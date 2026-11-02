// 시험용 가짜 노션: 원격 MCP 서버 + 그 OAuth 인가 서버 + REST API (fetch 자리에 끼운다). 진짜 네트워크는 안 쓴다.
import crypto from "node:crypto";

export const PAGE_ID = "0123456789abcdef0123456789abcdef";
export const PAGE_URL = `https://www.notion.so/team/갈피-기획-${PAGE_ID}`;

export interface FakeOpts {
  pageText?: string;
  asMeta?: Record<string, unknown>;
  prm?: Record<string, unknown>;
  mcpStatus?: number;
  redirectOn?: string;
}

export function fakeNotion(o: FakeOpts = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
  const challenges = new Map<string, string>(); // code → challenge (시험이 code를 정함)
  let tokenN = 0;
  const pages = new Map<string, { id: string; props: Record<string, unknown> }>();
  const discord = new Map<string, unknown>();
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    const method = init.method ?? "GET";
    calls.push({ method, url, headers, body });
    const u = new URL(url);
    if (o.redirectOn && url.startsWith(o.redirectOn)) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });

    if (u.pathname === "/.well-known/oauth-protected-resource") return json(o.prm ?? { resource: "https://mcp.notion.com/mcp", authorization_servers: ["https://mcp.notion.com"] });
    if (u.pathname === "/.well-known/oauth-authorization-server")
      return json(
        o.asMeta ?? {
          issuer: "https://mcp.notion.com",
          authorization_endpoint: "https://mcp.notion.com/authorize",
          token_endpoint: "https://mcp.notion.com/token",
          registration_endpoint: "https://mcp.notion.com/register",
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        },
      );
    if (u.hostname === "mcp.notion.com" && u.pathname === "/token") {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") === "authorization_code") {
        const ch = challenges.get(f.get("code") ?? "");
        const got = crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (!ch || ch !== got || !f.get("resource")) return json({ error: "invalid_grant" }, 400);
      } else if (f.get("grant_type") !== "refresh_token") return json({ error: "unsupported" }, 400);
      tokenN++;
      return json({ access_token: `at-${tokenN}`, refresh_token: `rt-${tokenN}`, expires_in: 3600, token_type: "bearer", scope: "read" });
    }
    if (u.hostname === "mcp.notion.com" && u.pathname === "/mcp") {
      if (o.mcpStatus) return new Response("", { status: o.mcpStatus });
      if (!headers.authorization?.startsWith("Bearer at-")) return new Response("", { status: 401 });
      const m = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: { id?: string } } };
      if (m.method === "initialize") return json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } } }, 200, { "mcp-session-id": "sess-1" });
      if (m.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (m.method === "tools/call" && m.params?.name === "notion-fetch") {
        const text = o.pageText ?? `<page url="https://www.notion.so/${PAGE_ID}"><properties>{"title":"갈피 기획"}</properties><content># 갈피 기획\n\n입구는 웹으로 간다.\n디스코드 봇은 2단계로 한다.\n</content></page>`;
        const msg = { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } };
        return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    }
    // ── REST (되돌려 쓰기) ──
    if (u.hostname === "api.notion.com" && /\/v1\/data_sources\/[^/]+\/query$/.test(u.pathname)) {
      const want = (JSON.parse(body) as { filter: { rich_text: { equals: string } } }).filter.rich_text.equals;
      const hit = [...pages.values()].filter((p) => JSON.stringify(p.props).includes(`"content":"${want}"`));
      return json({ results: hit.map((p) => ({ id: p.id, url: `https://www.notion.so/${p.id}` })) });
    }
    if (u.hostname === "api.notion.com" && u.pathname === "/v1/pages" && method === "POST") {
      const id = crypto.randomUUID().replace(/-/g, "");
      pages.set(id, { id, props: (JSON.parse(body) as { properties: Record<string, unknown> }).properties });
      return json({ id, url: `https://www.notion.so/${id}` });
    }
    if (u.hostname === "api.notion.com" && u.pathname.startsWith("/v1/pages/") && method === "PATCH") {
      const id = u.pathname.split("/").pop()!;
      const p = pages.get(id);
      if (!p) return json({ object: "error" }, 404);
      p.props = { ...p.props, ...(JSON.parse(body) as { properties: Record<string, unknown> }).properties };
      return json({ id, url: `https://www.notion.so/${id}` });
    }
    // ── 디스코드 웹훅 ──
    if (u.hostname === "discord.com" && u.pathname.startsWith("/api/webhooks/")) {
      if (method === "POST") {
        const id = String(discord.size + 1000);
        discord.set(id, JSON.parse(body));
        return json({ id, channel_id: "c1" });
      }
      if (method === "PATCH") {
        const id = u.pathname.split("/").pop()!;
        if (!discord.has(id)) return json({ message: "Unknown Message" }, 404);
        discord.set(id, JSON.parse(body));
        return json({ id });
      }
    }
    return json({ error: "fake: 모르는 주소" }, 404);
  };

  return { fetch, calls, challenges, pages, discord };
}

// 인가 URL에서 state·challenge를 꺼내 가짜 서버에 "사람이 허락했다"를 흉내
export function approve(fake: ReturnType<typeof fakeNotion>, authUrl: string, code = "code-1") {
  const u = new URL(authUrl);
  fake.challenges.set(code, u.searchParams.get("code_challenge")!);
  return { state: u.searchParams.get("state")!, code, url: u };
}
