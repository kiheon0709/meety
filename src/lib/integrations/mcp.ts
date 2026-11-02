// 아주 작은 MCP 클라이언트 (Streamable HTTP, JSON-RPC). 읽기 도구 호출만 한다.
// 상태 있는 서버(initialize + Mcp-Session-Id)와 상태 없는 서버(2026-07-28) 둘 다: initialize가 안 되면 건너뛴다.
import { safeFetch, type Connector, type FetchLike } from "./http";

const PROTOCOL = "2025-06-18";

export class McpAuthError extends Error {}
export class McpError extends Error {}

type Msg = { jsonrpc: "2.0"; id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

async function parse(r: Response, id: number): Promise<Msg | null> {
  const type = r.headers.get("content-type") ?? "";
  const text = await r.text();
  if (!text.trim()) return null;
  if (type.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const m = JSON.parse(line.slice(5).trim()) as Msg;
        if (m.id === id) return m;
      } catch {
        /* 다른 이벤트 */
      }
    }
    return null;
  }
  return JSON.parse(text) as Msg;
}

// 회의 중엔 읽기 도구만 부를 수 있다 (security.md ⑫ "도구 설명은 믿지 않음")
export const READ_TOOLS: Record<Connector, readonly string[]> = {
  notion: ["notion-fetch", "notion-search"],
  notion_api: [],
  discord: [],
};

export async function callTool(connector: Connector, endpoint: string, token: string, name: string, args: Record<string, unknown>, fetchImpl?: FetchLike): Promise<{ text: string }> {
  if (!READ_TOOLS[connector].includes(name)) throw new McpError(`부를 수 없는 도구예요: ${name}`);
  const base: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = async (body: object, headers: Record<string, string> = {}) => {
    const r = await safeFetch(connector, endpoint, { method: "POST", headers: { ...base, ...headers }, body: JSON.stringify(body) }, fetchImpl);
    if (r.status === 401 || r.status === 403) throw new McpAuthError("연결이 만료됐어요");
    return r;
  };

  let session: Record<string, string> = {};
  try {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "meety", version: "0.1" } } });
    const m = init.ok ? await parse(init, 1) : null;
    if (m?.result) {
      const sid = init.headers.get("mcp-session-id");
      session = { "mcp-protocol-version": String(m.result.protocolVersion ?? PROTOCOL), ...(sid ? { "mcp-session-id": sid } : {}) };
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    }
  } catch (e) {
    if (e instanceof McpAuthError) throw e; // 상태 없는 서버면 initialize 실패는 무시
  }

  const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, session);
  if (!r.ok) throw new McpError(`도구 호출 실패 (${r.status})`);
  const m = await parse(r, 2);
  if (!m || m.error) throw new McpError(m?.error?.message ?? "응답이 없어요");
  const content = (m.result?.content ?? []) as { type: string; text?: string }[];
  const text = content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  if (m.result?.isError) throw new McpError(text.slice(0, 200) || "도구가 오류를 냈어요");
  return { text };
}
