// 노션 읽기 (연동 2번): 공식 원격 MCP 서버에 OAuth로 붙어 페이지 하나를 가져와 그 스페이스 자료(사실)로.
//   연결 → beginNotionAuth / finishNotionAuth (토큰은 연결에 암호화)
//   가져오기 → importNotionPage: notion-fetch → RawItem(S4 knowledge-design §5-1 모양) → toFacts
//   미티가 써 넣은 페이지(meety_node_id)는 읽지 않는다 — 자기 결정을 자기 근거로 삼는 메아리 막기
import fs from "node:fs";
import path from "node:path";
import type { DocInfo } from "@/lib/live/contract";
import { ingestFile } from "@/lib/ingest";
import { recordDoc } from "@/lib/ingest/sources";
import type { Extractor } from "@/lib/ingest/extract";
import { bindDoc, unbindDoc } from "@/lib/live/docs";
import { APP_URL } from "@/lib/notify";
import { getConnection, putConnection, readSecret, removeConnection, setRoot, setStatus } from "./connections";
import type { FetchLike } from "./http";
import { callTool, McpAuthError } from "./mcp";
import { beginAuth, discover, finishAuth, OAuthError, refresh, takePending, type TokenSet } from "./oauth";
import { uploadsDir } from "./upload";

export const NOTION_MCP_URL = process.env.NOTION_MCP_URL || "https://mcp.notion.com/mcp";
export const NOTION_REDIRECT = `${APP_URL}/api/integrations/notion/callback`;

// S4와 맞춘 경계면 (knowledge-design.md §5-1)
export interface RawItem {
  connector: "notion";
  kind: "page" | "db_row";
  externalId: string;
  url: string;
  title: string;
  parentPath: string[];
  lastEditedTime: string;
  markdown?: string;
  properties?: Record<string, string>;
  createdByMeety?: boolean;
}

interface NotionSecret extends TokenSet {
  client_id: string;
  issuer: string;
  token_endpoint: string;
  resource: string;
}

export class NotionError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// ── 연결 ────────────────────────────────────────────────

export async function beginNotionAuth(spaceId: string, memberId: string | null, fetchImpl?: FetchLike): Promise<string> {
  const clientId = process.env.NOTION_MCP_CLIENT_ID;
  if (!clientId) throw new NotionError("노션 연결 준비가 안 됐어요 (NOTION_MCP_CLIENT_ID — scripts/notion-register.ts)", 503);
  const as = await discover("notion", NOTION_MCP_URL, fetchImpl);
  return beginAuth(as, { spaceId, memberId, connector: "notion", redirectUri: NOTION_REDIRECT, clientId });
}

export async function finishNotionAuth(q: { state: string; code: string; iss?: string | null }, fetchImpl?: FetchLike): Promise<{ spaceId: string }> {
  const p = takePending(q.state);
  if (!p || p.connector !== "notion") throw new OAuthError("연결 요청이 없거나 오래됐어요 (state)");
  const t = await finishAuth(p, q, fetchImpl);
  const secret: NotionSecret = { ...t, client_id: p.clientId, issuer: p.issuer, token_endpoint: p.tokenEndpoint, resource: p.resource };
  putConnection(p.spaceId, "notion", { installedBy: p.memberId, scopes: t.scope ?? "", secret, root: getConnection(p.spaceId, "notion")?.root ?? { imported: {} } });
  return { spaceId: p.spaceId };
}

// 만료 1분 전이면 새로 받는다. 못 받으면 연결을 expired로 두고 null
export async function notionToken(spaceId: string, fetchImpl?: FetchLike): Promise<string | null> {
  const s = readSecret<NotionSecret>(spaceId, "notion");
  if (!s) return null;
  if (!s.expires_at || s.expires_at - Date.now() > 60_000) return s.access_token;
  if (!s.refresh_token) {
    setStatus(spaceId, "notion", "expired");
    return null;
  }
  try {
    const t = await refresh("notion", s.token_endpoint, { refresh_token: s.refresh_token, client_id: s.client_id, resource: s.resource }, fetchImpl);
    putConnection(spaceId, "notion", { secret: { ...s, ...t } });
    return t.access_token;
  } catch {
    setStatus(spaceId, "notion", "expired");
    return null;
  }
}

export function disconnectNotion(spaceId: string): void {
  const c = removeConnection(spaceId, "notion");
  const imported = (c?.root.imported ?? {}) as Record<string, { docId: string }>;
  for (const { docId } of Object.values(imported)) unbindDoc(spaceId, docId);
}

// ── 가져오기 ────────────────────────────────────────────

// 노션 주소(notion.so·notion.site) 또는 페이지 id(32자리 16진수)만 받는다
export function notionPageId(ref: string): string {
  const t = ref.trim();
  let hay = t;
  if (/^https?:\/\//i.test(t)) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      throw new NotionError("노션 주소가 아니에요");
    }
    if (u.protocol !== "https:" || !/(^|\.)notion\.(so|site)$/i.test(u.hostname)) throw new NotionError("노션 주소가 아니에요");
    hay = u.pathname;
  }
  const hex = hay.replace(/-/g, "").match(/[0-9a-f]{32}(?![0-9a-f])/gi);
  if (!hex) throw new NotionError("노션 페이지 id를 찾지 못했어요");
  return hex[hex.length - 1].toLowerCase();
}

// notion-fetch 결과 글 → RawItem. 결과 모양이 서버 버전마다 조금씩 달라 넉넉하게 읽는다 [실물로 확인 필요]
export function toRawItem(text: string, ref: string): RawItem {
  const id = notionPageId(ref);
  const content = text.match(/<content>([\s\S]*?)<\/content>/)?.[1] ?? text;
  const title = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? text.match(/<title>([^<]+)<\/title>/)?.[1] ?? content.match(/^#\s+(.+)$/m)?.[1] ?? "노션 페이지";
  const url = text.match(/url="(https:\/\/[^"]+)"/)?.[1] ?? (/^https:/.test(ref) ? ref : `https://www.notion.so/${id}`);
  const edited = text.match(/"last_edited_time"\s*:\s*"([^"]+)"/)?.[1] ?? new Date().toISOString();
  return { connector: "notion", kind: "page", externalId: id, url, title: title.trim(), parentPath: [], lastEditedTime: edited, markdown: content.trim(), createdByMeety: /meety_node_id/.test(text) };
}

// RawItem → 사실. S4 ingestItem(spaceId, raw)가 생기면 여기 한 줄만 바꾼다.
// 그 전까지: 페이지 본문을 그 스페이스 업로드 폴더에 md로 두고 ingestFile + bindDoc (파일 넣기와 같은 길)
export async function toFacts(spaceId: string, raw: RawItem, opts: { extractor?: Extractor } = {}): Promise<DocInfo> {
  // 미티가 써 넣은 페이지는 어느 길로 와도 사실로 만들지 않는다 (메아리 — S4 knowledge-design §5-2 1번)
  if (raw.createdByMeety) throw new NotionError("미티가 써 넣은 페이지라 자료로 읽지 않아요", 409);
  const dir = path.join(uploadsDir(), spaceId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `notion-${raw.externalId}.md`);
  const body = raw.markdown ?? "";
  fs.writeFileSync(file, (/^#\s/.test(body) ? "" : `# ${raw.title}\n\n`) + body, { mode: 0o600 });
  const info = (await ingestFile(file, { extractor: opts.extractor })).info;
  bindDoc(spaceId, info.id);
  // S4 docs 행에 진짜 페이지 주소·수정 시각을 남긴다 (파일 이름으로 짐작한 것보다 정확 — "원문 보기"·바뀜 판정)
  recordDoc(spaceId, info.id, { connector: "notion", kind: "page", externalId: raw.externalId, url: raw.url, version: raw.lastEditedTime });
  return info;
}

export async function importNotionPage(spaceId: string, ref: string, opts: { fetch?: FetchLike; extractor?: Extractor } = {}): Promise<DocInfo> {
  const id = notionPageId(ref);
  const conn = getConnection(spaceId, "notion");
  if (!conn) throw new NotionError("이 프로젝트는 노션에 연결돼 있지 않아요", 409);
  const token = await notionToken(spaceId, opts.fetch);
  if (!token) throw new NotionError("노션 연결이 만료됐어요. 다시 연결해 주세요", 401);
  let text: string;
  try {
    text = (await callTool("notion", NOTION_MCP_URL, token, "notion-fetch", { id }, opts.fetch)).text;
  } catch (e) {
    if (e instanceof McpAuthError) {
      setStatus(spaceId, "notion", "expired");
      throw new NotionError("노션 연결이 만료됐어요. 다시 연결해 주세요", 401);
    }
    throw new NotionError(`노션에서 못 가져왔어요: ${(e as Error).message}`, 502);
  }
  const raw = toRawItem(text, ref);
  if (raw.createdByMeety) throw new NotionError("미티가 써 넣은 페이지라 자료로 읽지 않아요", 409);
  const info = await toFacts(spaceId, raw, opts);
  const imported = (conn.root.imported ?? {}) as Record<string, unknown>;
  setRoot(spaceId, "notion", { imported: { ...imported, [raw.externalId]: { docId: info.id, url: raw.url, title: raw.title, fetchedAt: new Date().toISOString() } } });
  return info;
}
