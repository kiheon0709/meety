// 연동이 밖으로 나가는 요청은 전부 여기를 지난다 (보안 security.md ⑫ — SSRF·리다이렉트).
// 주소 검사는 IP를 직접 따지지 않고 "커넥터마다 정해진 공식 호스트 목록"만 허용한다:
// https만, 기본 포트만, 사용자 정보 없는 주소만, 리다이렉트는 따라가지 않는다.
export type Connector = "notion" | "notion_api" | "discord";

export const ALLOWED_HOSTS: Record<Connector, readonly string[]> = {
  notion: ["mcp.notion.com"], // 공식 원격 MCP 서버 + 그 인가 서버 (05 §1-2)
  notion_api: ["api.notion.com"], // 되돌려 쓰기 REST
  discord: ["discord.com", "discordapp.com"], // 웹훅
};

export class UnsafeUrlError extends Error {}

export function checkUrl(connector: Connector, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("주소가 아니에요");
  }
  if (u.protocol !== "https:") throw new UnsafeUrlError(`https만 돼요 (${u.protocol})`);
  if (u.username || u.password) throw new UnsafeUrlError("주소에 계정 정보가 있어요");
  if (u.port && u.port !== "443") throw new UnsafeUrlError("기본 포트만 돼요");
  if (!ALLOWED_HOSTS[connector].includes(u.hostname.toLowerCase())) throw new UnsafeUrlError(`${connector}에 허용된 주소가 아니에요 (${u.hostname})`);
  return u;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function safeFetch(connector: Connector, url: string, init: RequestInit = {}, fetchImpl: FetchLike = fetch): Promise<Response> {
  const u = checkUrl(connector, url);
  const r = await fetchImpl(u.toString(), { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(15_000) });
  if (r.status >= 300 && r.status < 400) throw new UnsafeUrlError(`리다이렉트는 따라가지 않아요 (${r.status})`);
  return r;
}
