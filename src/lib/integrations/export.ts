// 되돌려 쓰기 (연동 3번, integration.md §4): 사람이 승인한 결정만 노션 결정 DB·디스코드로.
//   멱등: exports.idempotency_key 유니크 = "스페이스:노드:커넥터:대상". 두 번 돌려도 상대 쪽엔 하나.
//   노션엔 meety_node_id 속성을 심고, 우리 기록이 없어도(중간에 죽음) 만들기 전에 먼저 찾는다.
//   결정이 바뀌면 지우지 않고 고친다("바뀜"). 회의 중엔 부르지 않는다 — 회의 뒤, 검토 게이트를 지난 노드만.
import crypto from "node:crypto";
import { getDb, newId, now } from "@/lib/db";
import { APP_URL, buildDiscordBody } from "@/lib/notify";
import { getConnection, putConnection, readSecret } from "./connections";
import { safeFetch, type Connector, type FetchLike } from "./http";

export interface ExportNode {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  superseded_by: string | null;
}

export type ExportResult = "created" | "updated" | "skipped" | "busy" | "failed";
const NOTION_VERSION = "2025-09-03";
const CLAIM_STALE_MS = 2 * 60_000;
const STATUS_LABEL: Record<string, string> = { agreed: "확정", superseded: "바뀜", withdrawn: "철회" };

// 내보낼 것: 결정 중 검토 대기가 아닌 것 (합의·바뀜·철회). 제안 상태는 안 내보낸다
export function exportableDecisions(spaceId: string): ExportNode[] {
  return getDb()
    .prepare(`SELECT id, type, title, body, status, superseded_by FROM nodes WHERE space_id = ? AND type = 'decision' AND review_pending = 0 AND status IN ('agreed','superseded','withdrawn') ORDER BY sort_order`)
    .all(spaceId) as ExportNode[];
}

export function nodeVersion(n: ExportNode): string {
  return crypto.createHash("sha1").update([n.type, n.title, n.body, n.status, n.superseded_by ?? ""].join("\u0000")).digest("hex").slice(0, 12);
}

const marker = (spaceId: string, nodeId: string) => `${spaceId}:${nodeId}`;
const statusText = (n: ExportNode) => (n.status === "superseded" && n.superseded_by ? `바뀜 → ${n.superseded_by}` : (STATUS_LABEL[n.status] ?? n.status));

interface ExportRow {
  id: string;
  external_id: string | null;
  node_version: string;
  status: string;
  created_at: string;
}

// ── 대상별 ──

interface Target {
  connector: Connector;
  target: string;
  push(n: ExportNode, externalId: string | null): Promise<{ id: string; url: string; created: boolean }>;
}

function notionTarget(spaceId: string, fetchImpl?: FetchLike): Target | null {
  const s = readSecret<{ token: string }>(spaceId, "notion_api");
  const root = getConnection(spaceId, "notion_api")?.root as { dataSourceId?: string; titleProp?: string } | undefined;
  if (!s || !root?.dataSourceId) return null;
  const ds = root.dataSourceId;
  const titleProp = root.titleProp || "Name";
  const headers = { authorization: `Bearer ${s.token}`, "notion-version": NOTION_VERSION, "content-type": "application/json" };
  const call = async (method: string, path: string, body: object) => {
    let r = await safeFetch("notion_api", `https://api.notion.com${path}`, { method, headers, body: JSON.stringify(body) }, fetchImpl);
    if (r.status === 429) {
      await new Promise((ok) => setTimeout(ok, Math.min(5, Number(r.headers.get("retry-after") ?? 1)) * 1000));
      r = await safeFetch("notion_api", `https://api.notion.com${path}`, { method, headers, body: JSON.stringify(body) }, fetchImpl);
    }
    if (!r.ok) throw new Error(`노션 ${r.status}`);
    return (await r.json()) as { id: string; url?: string; results?: { id: string; url?: string }[] };
  };
  const text = (t: string) => [{ text: { content: t.slice(0, 2000) } }];
  return {
    connector: "notion_api",
    target: `ds:${ds}`,
    async push(n, externalId) {
      const props = { [titleProp]: { title: text(n.title) }, meety_node_id: { rich_text: text(marker(spaceId, n.id)) }, meety_status: { rich_text: text(statusText(n)) } };
      let id = externalId;
      if (!id) {
        // 우리 기록이 없어도 상대 쪽에 이미 있으면 그걸 쓴다 (만들고 저장 전에 죽은 경우)
        const q = await call("POST", `/v1/data_sources/${ds}/query`, { filter: { property: "meety_node_id", rich_text: { equals: marker(spaceId, n.id) } }, page_size: 1 });
        id = q.results?.[0]?.id ?? null;
      }
      if (id) {
        const p = await call("PATCH", `/v1/pages/${id}`, { properties: props });
        return { id: p.id, url: p.url ?? "", created: false };
      }
      const p = await call("POST", "/v1/pages", {
        parent: { type: "data_source_id", data_source_id: ds },
        properties: props,
        children: n.body ? [{ object: "block", type: "paragraph", paragraph: { rich_text: text(n.body) } }] : [],
      });
      return { id: p.id, url: p.url ?? "", created: true };
    },
  };
}

function discordTarget(spaceId: string, fetchImpl?: FetchLike): Target | null {
  const hook = readSecret<{ webhookUrl: string }>(spaceId, "discord")?.webhookUrl;
  if (!hook) return null;
  const hookId = hook.match(/webhooks\/(\d+)/)?.[1] ?? "?";
  const send = (method: string, url: string, n: ExportNode) =>
    safeFetch("discord", url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDiscordBody({ title: `결정 · ${n.title}`, lines: [n.body, `상태: ${statusText(n)}`], url: `${APP_URL}/s/${spaceId}/issues/${encodeURIComponent(n.id)}`, tone: n.status === "agreed" ? "green" : "orange" })),
    }, fetchImpl);
  return {
    connector: "discord",
    target: `webhook:${hookId}`,
    async push(n, externalId) {
      if (externalId) {
        const r = await send("PATCH", `${hook}/messages/${externalId}`, n);
        if (r.ok) return { id: externalId, url: "", created: false };
        if (r.status !== 404) throw new Error(`디스코드 ${r.status}`);
        // 사람이 채널에서 지운 메시지 → 새로 올린다
      }
      const r = await send("POST", `${hook}?wait=true`, n);
      if (!r.ok) throw new Error(`디스코드 ${r.status}`);
      const j = (await r.json()) as { id: string };
      return { id: j.id, url: "", created: true };
    },
  };
}

// ── 한 노드를 한 대상으로 ──

export async function exportNode(spaceId: string, n: ExportNode, t: Target): Promise<ExportResult> {
  const db = getDb();
  const key = `${spaceId}:${n.id}:${t.connector}:${t.target}`;
  const version = nodeVersion(n);
  let row = db.prepare(`SELECT id, external_id, node_version, status, created_at FROM exports WHERE idempotency_key = ?`).get(key) as ExportRow | undefined;
  if (row?.status === "ok" && row.node_version === version) return "skipped";
  if (!row) {
    // 넣기 실패 = 다른 실행이 먼저 잡음 (조회 후 넣기가 아니라 유니크 제약으로 가른다)
    try {
      const t0 = now();
      db.prepare(`INSERT INTO exports (id, space_id, node_id, connector, target, node_version, idempotency_key, status, claimed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(newId("ex"), spaceId, n.id, t.connector, t.target, version, key, t0, t0);
    } catch {
      return "busy";
    }
    row = db.prepare(`SELECT id, external_id, node_version, status, created_at FROM exports WHERE idempotency_key = ?`).get(key) as ExportRow;
  } else {
    // 잡기: 다른 실행이 잡고 있지 않거나, 잡은 채 2분 넘게 안 끝났으면(죽은 실행) 다시 잡는다
    const stale = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
    const claimed = db.prepare(`UPDATE exports SET status = 'pending', claimed_at = ? WHERE id = ? AND (status != 'pending' OR claimed_at < ?)`).run(now(), row.id, stale);
    if (claimed.changes !== 1) return "busy";
  }
  try {
    const r = await t.push(n, row.external_id);
    db.prepare(`UPDATE exports SET status = 'ok', external_id = ?, external_url = ?, node_version = ?, pushed_at = ?, error = NULL WHERE id = ?`).run(r.id, r.url || null, version, now(), row.id);
    return r.created ? "created" : "updated";
  } catch (e) {
    // 오류 글엔 상태 번호만 (토큰·웹훅 주소가 섞이지 않게)
    const msg = (e as Error).message.replace(/https?:\/\/\S+/g, "(주소)").slice(0, 120);
    db.prepare(`UPDATE exports SET status = 'failed', error = ? WHERE id = ?`).run(msg, row.id);
    return "failed";
  }
}

export async function exportDecisions(spaceId: string, opts: { fetch?: FetchLike } = {}): Promise<Record<string, Record<ExportResult, number>>> {
  const targets = [notionTarget(spaceId, opts.fetch), discordTarget(spaceId, opts.fetch)].filter((t): t is Target => !!t);
  const out: Record<string, Record<ExportResult, number>> = {};
  for (const t of targets) {
    const c = (out[t.connector] = { created: 0, updated: 0, skipped: 0, busy: 0, failed: 0 });
    for (const n of exportableDecisions(spaceId)) c[await exportNode(spaceId, n, t)]++;
  }
  return out;
}

// 노션 쓰기 연결: 사람이 만든 내부 통합 토큰 + 결정 DB(data source) id. 토큰은 환경변수·화면에서만 받고 암호화해 둔다
export function setNotionWriter(spaceId: string, token: string, dataSourceId: string, titleProp?: string, installedBy?: string | null): void {
  if (!/^(ntn_|secret_)[A-Za-z0-9]{20,}$/.test(token)) throw new Error("노션 통합 토큰 모양이 아니에요");
  const ds = dataSourceId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(ds)) throw new Error("data source id(32자리)가 아니에요");
  putConnection(spaceId, "notion_api", { installedBy, scopes: "insert,update", secret: { token }, root: { dataSourceId: ds, titleProp: titleProp || "Name" } });
}
