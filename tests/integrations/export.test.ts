// 되돌려 쓰기 (S5 연동 3번) — 두 번 보내도 상대 쪽엔 하나, 승인된 결정만, 바뀌면 고침
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/lib/db";
import { setDiscordWebhook } from "../../src/lib/integrations/connections";
import { exportableDecisions, exportDecisions, setNotionWriter } from "../../src/lib/integrations/export";
import { createSpace } from "../../src/lib/service";
import { fakeNotion } from "./fake-notion";

const TOKEN = "ntn_TESTTOKEN0123456789abcdefABCDEF";
const DS = "fedcba9876543210fedcba9876543210";
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jkl";

let seq = 0;
function node(spaceId: string, id: string, f: { title?: string; body?: string; status?: string; type?: string; review_pending?: number; superseded_by?: string | null } = {}) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO nodes (id, space_id, type, title, body, status, superseded_by, created_commit_id, updated_commit_id, sort_order, review_pending) VALUES (?, ?, ?, ?, ?, ?, ?, 'c', 'c', ?, ?)`,
    )
    .run(id, spaceId, f.type ?? "decision", f.title ?? "입구는 웹", f.body ?? "디스코드 봇은 2단계", f.status ?? "agreed", f.superseded_by ?? null, seq++, f.review_pending ?? 0);
}
const exportsOf = (spaceId: string) => getDb().prepare(`SELECT * FROM exports WHERE space_id = ? ORDER BY node_id, connector`).all(spaceId) as Record<string, string>[];

describe("내보낼 것 고르기", () => {
  it("검토 대기·제안·결정 아닌 노드는 안 내보낸다", () => {
    const a = createSpace("A");
    node(a.id, "N1");
    node(a.id, "N2", { review_pending: 1 });
    node(a.id, "N3", { status: "proposed" });
    node(a.id, "N4", { type: "action", status: "open" });
    node(a.id, "N5", { status: "superseded", superseded_by: "N1" });
    expect(exportableDecisions(a.id).map((n) => n.id)).toEqual(["N1", "N5"]);
  });
});

describe("노션 결정 DB로", () => {
  it("두 번 돌려도 페이지는 하나, meety_node_id를 심는다", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setNotionWriter(a.id, TOKEN, DS);
    const fake = fakeNotion();
    expect(await exportDecisions(a.id, { fetch: fake.fetch })).toEqual({ notion_api: { created: 1, updated: 0, skipped: 0, busy: 0, failed: 0 } });
    expect(await exportDecisions(a.id, { fetch: fake.fetch })).toEqual({ notion_api: { created: 0, updated: 0, skipped: 1, busy: 0, failed: 0 } });
    expect(fake.pages.size).toBe(1);
    const p = [...fake.pages.values()][0];
    expect(JSON.stringify(p.props)).toContain(`${a.id}:N1`);
    const post = fake.calls.find((c) => c.url === "https://api.notion.com/v1/pages")!;
    expect(post.headers["notion-version"]).toBe("2025-09-03");
    expect(JSON.parse(post.body).parent).toEqual({ type: "data_source_id", data_source_id: DS });
  });

  it("결정이 바뀌면 같은 페이지를 고친다(지우지 않음)", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setNotionWriter(a.id, TOKEN, DS);
    const fake = fakeNotion();
    await exportDecisions(a.id, { fetch: fake.fetch });
    node(a.id, "N1", { status: "superseded", superseded_by: "N9" });
    expect((await exportDecisions(a.id, { fetch: fake.fetch })).notion_api.updated).toBe(1);
    expect(fake.pages.size).toBe(1);
    expect(JSON.stringify([...fake.pages.values()][0].props)).toContain("바뀜 → N9");
  });

  it("만들고 기록 전에 죽어도(우리 기록 없음) 먼저 찾아서 새로 안 만든다", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setNotionWriter(a.id, TOKEN, DS);
    const fake = fakeNotion();
    await exportDecisions(a.id, { fetch: fake.fetch });
    getDb().prepare(`DELETE FROM exports WHERE space_id = ?`).run(a.id);
    const r = await exportDecisions(a.id, { fetch: fake.fetch });
    expect(r.notion_api.updated).toBe(1);
    expect(fake.pages.size).toBe(1);
  });

  it("같은 열쇠의 기록은 DB가 두 번 못 넣게 막는다", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setNotionWriter(a.id, TOKEN, DS);
    await exportDecisions(a.id, { fetch: fakeNotion().fetch });
    const row = exportsOf(a.id)[0];
    expect(() =>
      getDb().prepare(`INSERT INTO exports (id, space_id, node_id, connector, target, node_version, idempotency_key, status, created_at) VALUES ('x', ?, 'N1', 'notion_api', ?, 'v', ?, 'ok', 'now')`).run(a.id, row.target, row.idempotency_key),
    ).toThrow(/UNIQUE/);
  });

  it("실패하면 failed로 남기고 다음 실행에 다시 한다. 오류 글에 토큰이 없다", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setNotionWriter(a.id, TOKEN, DS);
    const down = async () => new Response("{}", { status: 500 });
    expect((await exportDecisions(a.id, { fetch: down })).notion_api.failed).toBe(1);
    const row = exportsOf(a.id)[0];
    expect(row.status).toBe("failed");
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    const fake = fakeNotion();
    expect((await exportDecisions(a.id, { fetch: fake.fetch })).notion_api.created).toBe(1);
  });

  it("다른 실행이 잡고 있으면 건너뛴다", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setNotionWriter(a.id, TOKEN, DS);
    const fake = fakeNotion();
    await exportDecisions(a.id, { fetch: fake.fetch });
    node(a.id, "N1", { title: "입구는 앱" });
    getDb().prepare(`UPDATE exports SET status = 'pending', claimed_at = ? WHERE space_id = ?`).run(new Date().toISOString(), a.id);
    expect((await exportDecisions(a.id, { fetch: fake.fetch })).notion_api.busy).toBe(1);
  });

  it.each([
    ["토큰 모양", "abc", DS],
    ["data source id", TOKEN, "../../v1/users"],
  ])("이상한 %s는 저장하지 않는다", (_l, tok, ds) => {
    const a = createSpace("A");
    expect(() => setNotionWriter(a.id, tok, ds)).toThrow();
  });
});

describe("디스코드로", () => {
  it("wait=true로 메시지 id를 받아 두고, 바뀌면 그 메시지를 고친다", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setDiscordWebhook(a.id, HOOK);
    const fake = fakeNotion();
    expect((await exportDecisions(a.id, { fetch: fake.fetch })).discord.created).toBe(1);
    expect(fake.calls.at(-1)!.url).toBe(`${HOOK}?wait=true`);
    expect((await exportDecisions(a.id, { fetch: fake.fetch })).discord.skipped).toBe(1);
    node(a.id, "N1", { status: "withdrawn" });
    expect((await exportDecisions(a.id, { fetch: fake.fetch })).discord.updated).toBe(1);
    expect(fake.calls.at(-1)).toMatchObject({ method: "PATCH", url: `${HOOK}/messages/1000` });
    expect(fake.discord.size).toBe(1);
  });

  it("채널에서 메시지를 지웠으면 새로 올린다", async () => {
    const a = createSpace("A");
    node(a.id, "N1");
    setDiscordWebhook(a.id, HOOK);
    const fake = fakeNotion();
    await exportDecisions(a.id, { fetch: fake.fetch });
    fake.discord.clear();
    node(a.id, "N1", { title: "바뀐 제목" });
    expect((await exportDecisions(a.id, { fetch: fake.fetch })).discord.created).toBe(1);
  });
});

describe("스페이스 격리", () => {
  it("B의 내보내기는 B의 연결·B의 결정만 쓴다", async () => {
    const a = createSpace("A");
    const b = createSpace("B");
    node(a.id, "N1", { title: "A만 아는 결정" });
    setNotionWriter(a.id, TOKEN, DS);
    setDiscordWebhook(a.id, HOOK);
    const fake = fakeNotion();
    expect(await exportDecisions(b.id, { fetch: fake.fetch })).toEqual({});
    node(b.id, "N1", { title: "B 결정" });
    expect(await exportDecisions(b.id, { fetch: fake.fetch })).toEqual({});
    expect(fake.calls).toHaveLength(0);
  });
});
