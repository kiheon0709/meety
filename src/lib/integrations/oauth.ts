// MCP 원격 서버용 OAuth 2.1 클라이언트 (integration.md §5, security.md ⑫).
//   발견: Protected Resource Metadata(RFC 9728) → 인가 서버 메타데이터(RFC 8414)
//   인가: PKCE S256 + state(한 번만) + resource(RFC 8707) + iss 확인(RFC 9207, mix-up 막기)
//   모든 주소는 그 커넥터의 공식 호스트만(safeFetch/checkUrl). 리다이렉트는 따라가지 않는다.
import crypto from "node:crypto";
import { checkUrl, safeFetch, type Connector, type FetchLike } from "./http";

export interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  iss_supported?: boolean; // authorization_response_iss_parameter_supported
}

export class OAuthError extends Error {}

async function getJson(connector: Connector, url: string, fetchImpl?: FetchLike): Promise<Record<string, unknown>> {
  const r = await safeFetch(connector, url, { headers: { accept: "application/json" } }, fetchImpl);
  if (!r.ok) throw new OAuthError(`메타데이터를 못 받았어요 (${r.status})`);
  return (await r.json()) as Record<string, unknown>;
}

// MCP 서버 주소 → 그 서버를 지키는 인가 서버 (주소는 전부 같은 커넥터의 허용 호스트여야 한다)
export async function discover(connector: Connector, mcpUrl: string, fetchImpl?: FetchLike): Promise<AuthServer & { resource: string }> {
  const mcp = checkUrl(connector, mcpUrl);
  const prm = await getJson(connector, `${mcp.origin}/.well-known/oauth-protected-resource`, fetchImpl);
  const servers = prm.authorization_servers;
  if (!Array.isArray(servers) || typeof servers[0] !== "string") throw new OAuthError("인가 서버가 없어요");
  const asUrl = checkUrl(connector, servers[0]);
  const meta = await getJson(connector, `${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname === "/" ? "" : asUrl.pathname}`, fetchImpl);
  const issuer = String(meta.issuer ?? "");
  if (issuer.replace(/\/$/, "") !== asUrl.toString().replace(/\/$/, "")) throw new OAuthError("인가 서버 issuer가 주소와 달라요");
  for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"] as const) {
    if (meta[k] !== undefined) checkUrl(connector, String(meta[k]));
  }
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthError("PKCE S256을 안 받는 서버예요");
  return {
    issuer,
    authorization_endpoint: String(meta.authorization_endpoint),
    token_endpoint: String(meta.token_endpoint),
    registration_endpoint: meta.registration_endpoint ? String(meta.registration_endpoint) : undefined,
    iss_supported: meta.authorization_response_iss_parameter_supported === true,
    resource: String(prm.resource ?? mcp.toString()),
  };
}

// ── 진행 중인 인가 (state 하나에 한 번만 쓰임, 10분) ─────────────
export interface Pending {
  spaceId: string;
  memberId: string | null;
  connector: Connector;
  verifier: string;
  issuer: string;
  tokenEndpoint: string;
  resource: string;
  redirectUri: string;
  clientId: string;
  issRequired: boolean;
  at: number;
}
const TTL_MS = 10 * 60_000;
const g = globalThis as unknown as { __meetyOAuth?: Map<string, Pending> };
const pending = (g.__meetyOAuth ??= new Map<string, Pending>());

const b64url = (b: Buffer) => b.toString("base64url");

export function beginAuth(as: AuthServer & { resource: string }, p: Omit<Pending, "verifier" | "issuer" | "tokenEndpoint" | "resource" | "issRequired" | "at">, scope?: string): string {
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(24));
  pending.set(state, { ...p, verifier, issuer: as.issuer, tokenEndpoint: as.token_endpoint, resource: as.resource, issRequired: !!as.iss_supported, at: Date.now() });
  const u = checkUrl(p.connector, as.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", b64url(crypto.createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", as.resource);
  if (scope) u.searchParams.set("scope", scope);
  return u.toString();
}

// state를 꺼내 지운다(다시 쓸 수 없게). 없거나 오래됐으면 null
export function takePending(state: string): Pending | null {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > TTL_MS) return null;
  return p;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // ms
  token_type?: string;
  scope?: string;
}

async function tokenRequest(connector: Connector, endpoint: string, form: Record<string, string>, fetchImpl?: FetchLike): Promise<TokenSet> {
  const secret = process.env.NOTION_MCP_CLIENT_SECRET;
  const body = new URLSearchParams(secret ? { ...form, client_secret: secret } : form);
  const r = await safeFetch(connector, endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }, fetchImpl);
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || typeof j.access_token !== "string") throw new OAuthError(`토큰을 못 받았어요 (${r.status})`);
  return {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
    expires_at: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : undefined,
    token_type: typeof j.token_type === "string" ? j.token_type : undefined,
    scope: typeof j.scope === "string" ? j.scope : undefined,
  };
}

// 콜백: iss가 오면 기록한 인가 서버와 같아야 한다 (mix-up)
export async function finishAuth(p: Pending, q: { code: string; iss?: string | null }, fetchImpl?: FetchLike): Promise<TokenSet> {
  if (p.issRequired && !q.iss) throw new OAuthError("인가 서버가 보내기로 한 iss가 없어요");
  if (q.iss != null && q.iss.replace(/\/$/, "") !== p.issuer.replace(/\/$/, "")) throw new OAuthError("다른 인가 서버의 응답이에요 (iss)");
  return tokenRequest(p.connector, p.tokenEndpoint, { grant_type: "authorization_code", code: q.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource }, fetchImpl);
}

export async function refresh(connector: Connector, endpoint: string, t: { refresh_token: string; client_id: string; resource: string }, fetchImpl?: FetchLike): Promise<TokenSet> {
  const next = await tokenRequest(connector, endpoint, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id, resource: t.resource }, fetchImpl);
  return { ...next, refresh_token: next.refresh_token ?? t.refresh_token };
}
