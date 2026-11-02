// 연결(Connection): 스페이스가 어느 도구에, 누구 권한으로, 어디까지 붙었나 (integration.md §3-1).
// 토큰(secret)은 token_enc에 암호화해서만 둔다. 밖으로 내보내는 ConnectionInfo엔 secret이 없다.
import { getDb, newId, now } from "@/lib/db";
import { open, seal } from "./crypto";
import { checkUrl, type Connector } from "./http";

export interface ConnectionInfo {
  id: string;
  spaceId: string;
  connector: Connector;
  installedBy: string | null;
  scopes: string;
  root: Record<string, unknown>;
  status: "ok" | "expired" | "revoked";
  updatedAt: string;
}

interface Row {
  id: string;
  space_id: string;
  connector: Connector;
  installed_by: string | null;
  scopes: string;
  token_enc: string | null;
  root_json: string;
  status: ConnectionInfo["status"];
  updated_at: string;
}

const aad = (spaceId: string, connector: string) => `${spaceId}:${connector}`;

function row(spaceId: string, connector: Connector): Row | undefined {
  return getDb().prepare(`SELECT * FROM connections WHERE space_id = ? AND connector = ?`).get(spaceId, connector) as Row | undefined;
}

function info(r: Row): ConnectionInfo {
  return { id: r.id, spaceId: r.space_id, connector: r.connector, installedBy: r.installed_by, scopes: r.scopes, root: JSON.parse(r.root_json || "{}"), status: r.status, updatedAt: r.updated_at };
}

export function putConnection(spaceId: string, connector: Connector, c: { installedBy?: string | null; scopes?: string; secret: object; root?: Record<string, unknown> }): ConnectionInfo {
  const db = getDb();
  const prev = row(spaceId, connector);
  const t = now();
  const enc = seal(JSON.stringify(c.secret), aad(spaceId, connector));
  const root = JSON.stringify(c.root ?? (prev ? JSON.parse(prev.root_json) : {}));
  if (prev) {
    db.prepare(`UPDATE connections SET installed_by = ?, scopes = ?, token_enc = ?, root_json = ?, status = 'ok', updated_at = ? WHERE id = ?`).run(c.installedBy ?? prev.installed_by, c.scopes ?? prev.scopes, enc, root, t, prev.id);
  } else {
    db.prepare(`INSERT INTO connections (id, space_id, connector, installed_by, scopes, token_enc, root_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`).run(newId("cn"), spaceId, connector, c.installedBy ?? null, c.scopes ?? "", enc, root, t, t);
  }
  return info(row(spaceId, connector)!);
}

export function getConnection(spaceId: string, connector: Connector): ConnectionInfo | undefined {
  const r = row(spaceId, connector);
  return r ? info(r) : undefined;
}

export function listConnections(spaceId: string): ConnectionInfo[] {
  return (getDb().prepare(`SELECT * FROM connections WHERE space_id = ? ORDER BY connector`).all(spaceId) as Row[]).map(info);
}

// 토큰 꺼내기 — 서버 안에서 그 커넥터를 부를 때만. 화면·로그·모델로 보내지 않는다.
export function readSecret<T>(spaceId: string, connector: Connector): T | null {
  const r = row(spaceId, connector);
  if (!r?.token_enc || r.status !== "ok") return null;
  return JSON.parse(open(r.token_enc, aad(spaceId, connector))) as T;
}

export function setRoot(spaceId: string, connector: Connector, patch: Record<string, unknown>): void {
  const r = row(spaceId, connector);
  if (!r) return;
  const root = { ...JSON.parse(r.root_json || "{}"), ...patch };
  getDb().prepare(`UPDATE connections SET root_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(root), now(), r.id);
}

export function setStatus(spaceId: string, connector: Connector, status: ConnectionInfo["status"]): void {
  getDb().prepare(`UPDATE connections SET status = ?, updated_at = ? WHERE space_id = ? AND connector = ?`).run(status, now(), spaceId, connector);
}

export function removeConnection(spaceId: string, connector: Connector): ConnectionInfo | undefined {
  const r = row(spaceId, connector);
  if (!r) return undefined;
  getDb().prepare(`DELETE FROM connections WHERE id = ?`).run(r.id);
  return info(r);
}

// ── 디스코드 웹훅: 예전엔 spaces.discord_webhook 평문 칸 → 이제 연결(암호화)로 ──

const DISCORD_HOOK = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export function setDiscordWebhook(spaceId: string, url: string | null, installedBy?: string | null): void {
  const db = getDb();
  db.prepare(`UPDATE spaces SET discord_webhook = NULL WHERE id = ?`).run(spaceId);
  if (!url) {
    removeConnection(spaceId, "discord");
    return;
  }
  const u = url.trim();
  checkUrl("discord", u);
  if (!DISCORD_HOOK.test(u)) throw new Error("디스코드 웹훅 주소가 아니에요");
  putConnection(spaceId, "discord", { installedBy, secret: { webhookUrl: u } });
}

// 옛 평문 칸에 남은 게 있으면 이때 연결로 옮기고 칸을 비운다
export function discordWebhook(spaceId: string): string | null {
  const legacy = getDb().prepare(`SELECT discord_webhook FROM spaces WHERE id = ?`).get(spaceId) as { discord_webhook: string | null } | undefined;
  if (legacy?.discord_webhook) {
    try {
      setDiscordWebhook(spaceId, legacy.discord_webhook);
    } catch {
      getDb().prepare(`UPDATE spaces SET discord_webhook = NULL WHERE id = ?`).run(spaceId);
    }
  }
  return readSecret<{ webhookUrl: string }>(spaceId, "discord")?.webhookUrl ?? null;
}

// 화면에 보여 줄 때: 주소 대신 "…/webhooks/1234…/****"
export function discordStatus(spaceId: string): { connected: boolean; hint: string | null } {
  const url = discordWebhook(spaceId);
  if (!url) return { connected: false, hint: null };
  const id = url.match(/webhooks\/(\d+)/)?.[1] ?? "";
  return { connected: true, hint: `…/webhooks/${id.slice(0, 4)}…/****` };
}
