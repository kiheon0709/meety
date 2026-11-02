// 노션 읽기 (S5 연동 2번) — 가짜 MCP·인가 서버로 결정적 시험
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/lib/db";
import { getFacts } from "../../src/lib/ingest";
import type { Extractor } from "../../src/lib/ingest/extract";
import { getConnection, putConnection, readSecret } from "../../src/lib/integrations/connections";
import { beginNotionAuth, disconnectNotion, finishNotionAuth, importNotionPage, notionPageId } from "../../src/lib/integrations/notion";
import { docsForSpace } from "../../src/lib/live/docs";
import { createSpace } from "../../src/lib/service";
import { approve, fakeNotion, PAGE_ID, PAGE_URL } from "./fake-notion";

const tmp = path.join(process.cwd(), "tests", ".tmp", `notion-${process.pid}`);
process.env.GALPI_INGEST_DIR = path.join(tmp, "data", "ingest");
process.env.GALPI_UPLOAD_DIR = path.join(tmp, "data", "uploads");
process.env.NOTION_MCP_CLIENT_ID = "cid-test";

const lines: Extractor = async ({ chunks }) => ({
  facts: chunks.flatMap((c, i) =>
    c.text
      .split("\n")
      .map((l) => l.replace(/^[-#\s]+/, "").trim())
      .filter(Boolean)
      .map((l) => ({ chunk: i, kind: "decision" as const, text: l, quote: l, keys: [] })),
  ),
  usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 },
});

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

async function connect(spaceId: string, fake = fakeNotion()) {
  const url = await beginNotionAuth(spaceId, null, fake.fetch);
  const a = approve(fake, url);
  await finishNotionAuth({ state: a.state, code: a.code, iss: "https://mcp.notion.com" }, fake.fetch);
  return { fake, url: a.url };
}

describe("노션 연결 (OAuth)", () => {
  it("PKCE S256·resource·state를 붙여 인가 화면으로 보내고, 받은 토큰은 암호화해 둔다", async () => {
    const a = createSpace("A");
    const { url } = await connect(a.id);
    expect(url.origin + url.pathname).toBe("https://mcp.notion.com/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://mcp.notion.com/mcp");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/integrations\/notion\/callback$/);
    expect(getConnection(a.id, "notion")?.status).toBe("ok");
    expect(readSecret<{ access_token: string }>(a.id, "notion")?.access_token).toBe("at-1");
    const raw = JSON.stringify(getDb().prepare(`SELECT * FROM connections WHERE space_id = ?`).get(a.id));
    expect(raw).not.toContain("at-1");
    expect(raw).not.toContain("rt-1");
  });

  it("state는 한 번만 쓸 수 있다", async () => {
    const a = createSpace("A");
    const fake = fakeNotion();
    const ap = approve(fake, await beginNotionAuth(a.id, null, fake.fetch));
    await finishNotionAuth({ state: ap.state, code: ap.code, iss: "https://mcp.notion.com" }, fake.fetch);
    await expect(finishNotionAuth({ state: ap.state, code: ap.code, iss: "https://mcp.notion.com" }, fake.fetch)).rejects.toThrow(/state/);
  });

  it("다른 인가 서버의 응답(iss 다름)이나, 보내기로 한 iss가 없으면 거절 (mix-up)", async () => {
    const a = createSpace("A");
    const fake = fakeNotion();
    const p1 = approve(fake, await beginNotionAuth(a.id, null, fake.fetch));
    await expect(finishNotionAuth({ state: p1.state, code: p1.code, iss: "https://evil.example" }, fake.fetch)).rejects.toThrow(/iss/);
    const p2 = approve(fake, await beginNotionAuth(a.id, null, fake.fetch));
    await expect(finishNotionAuth({ state: p2.state, code: p2.code, iss: null }, fake.fetch)).rejects.toThrow(/iss/);
    expect(getConnection(a.id, "notion")).toBeUndefined();
  });

  it("client_id가 없으면 연결을 시작하지 않는다 (사람이 등록할 몫)", async () => {
    const a = createSpace("A");
    const prev = process.env.NOTION_MCP_CLIENT_ID;
    delete process.env.NOTION_MCP_CLIENT_ID;
    await expect(beginNotionAuth(a.id, null, fakeNotion().fetch)).rejects.toThrow(/NOTION_MCP_CLIENT_ID/);
    process.env.NOTION_MCP_CLIENT_ID = prev;
  });
});

describe("노션 페이지 → 자료", () => {
  it("페이지 하나를 MCP notion-fetch로 가져와 사실로 만들고 그 스페이스에 묶는다", async () => {
    const a = createSpace("A");
    const b = createSpace("B");
    const { fake } = await connect(a.id);
    const doc = await importNotionPage(a.id, PAGE_URL, { fetch: fake.fetch, extractor: lines });
    expect(getFacts(doc.id).map((f) => f.text)).toEqual(["입구는 웹으로 간다.", "디스코드 봇은 2단계로 한다."]);
    expect(docsForSpace(a.id).map((d) => d.id)).toContain(doc.id);
    expect(docsForSpace(b.id)).toEqual([]);
    const call = fake.calls.find((c) => c.body.includes("tools/call"))!;
    expect(call.headers.authorization).toBe("Bearer at-1");
    expect(call.headers["mcp-session-id"]).toBe("sess-1");
    expect(JSON.parse(call.body).params).toEqual({ name: "notion-fetch", arguments: { id: PAGE_ID } });
    const pages = getConnection(a.id, "notion")!.root.imported as Record<string, { docId: string; title: string }>;
    expect(pages[PAGE_ID]).toMatchObject({ docId: doc.id, title: "갈피 기획" });
    // S4 docs 행: 노션 페이지로, 진짜 페이지 주소와 함께
    expect(getDb().prepare(`SELECT connector, kind, external_id, external_url FROM docs WHERE space_id = ? AND id = ?`).get(a.id, doc.id)).toEqual({ connector: "notion", kind: "page", external_id: PAGE_ID, external_url: `https://www.notion.so/${PAGE_ID}` });
  });

  it("미티가 써 넣은 페이지(meety_node_id)는 읽지 않는다 — 메아리 막기", async () => {
    const a = createSpace("A");
    const { fake } = await connect(a.id, fakeNotion({ pageText: `<page url="https://www.notion.so/${PAGE_ID}"><properties>{"title":"결정","meety_node_id":"N12"}</properties><content>입구는 웹</content></page>` }));
    await expect(importNotionPage(a.id, PAGE_URL, { fetch: fake.fetch, extractor: lines })).rejects.toThrow(/미티가 써 넣은/);
    expect(docsForSpace(a.id)).toEqual([]);
  });

  it("연결이 없는 스페이스는 못 가져온다 — 다른 스페이스 연결을 빌려 쓰지 않음", async () => {
    const a = createSpace("A");
    const b = createSpace("B");
    const { fake } = await connect(a.id);
    await expect(importNotionPage(b.id, PAGE_URL, { fetch: fake.fetch, extractor: lines })).rejects.toThrow(/연결돼 있지 않아요/);
    expect(fake.calls.filter((c) => c.body.includes("tools/call"))).toHaveLength(0);
  });

  it("토큰이 곧 끝나면 새로 받고, MCP가 401이면 연결을 만료로 둔다", async () => {
    const a = createSpace("A");
    const { fake } = await connect(a.id);
    const s = readSecret<Record<string, unknown>>(a.id, "notion")!;
    putConnection(a.id, "notion", { secret: { ...s, expires_at: Date.now() - 1 } });
    await importNotionPage(a.id, PAGE_URL, { fetch: fake.fetch, extractor: lines });
    expect(fake.calls.some((c) => c.url.endsWith("/token") && c.body.includes("grant_type=refresh_token"))).toBe(true);
    expect(readSecret<{ access_token: string }>(a.id, "notion")?.access_token).toBe("at-2");

    const denied = fakeNotion({ mcpStatus: 401 });
    await expect(importNotionPage(a.id, PAGE_URL, { fetch: denied.fetch, extractor: lines })).rejects.toThrow(/만료/);
    expect(getConnection(a.id, "notion")?.status).toBe("expired");
  });

  it("끊으면 토큰이 지워지고 가져온 자료도 그 스페이스에서 빠진다", async () => {
    const a = createSpace("A");
    const { fake } = await connect(a.id);
    const doc = await importNotionPage(a.id, PAGE_URL, { fetch: fake.fetch, extractor: lines });
    disconnectNotion(a.id);
    expect(getConnection(a.id, "notion")).toBeUndefined();
    expect(docsForSpace(a.id).map((d) => d.id)).not.toContain(doc.id);
  });

  it.each([
    ["노션 주소", PAGE_URL, PAGE_ID],
    ["notion.site", `https://team.notion.site/Plan-${PAGE_ID}`, PAGE_ID],
    ["id만", "01234567-89ab-cdef-0123-456789abcdef", PAGE_ID],
  ])("페이지 주소 읽기: %s", (_l, ref, id) => expect(notionPageId(ref)).toBe(id));

  it.each(["https://evil.com/x-0123456789abcdef0123456789abcdef", "http://www.notion.so/x-0123456789abcdef0123456789abcdef", "javascript:alert(1)", "그냥 글"])("노션이 아닌 주소는 거절: %s", (ref) => {
    expect(() => notionPageId(ref)).toThrow();
  });
});
