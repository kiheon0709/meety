// API 라우트 왕복 시험: 실제 라우트 함수에 Request를 넣어 start → stream → utterance → gap → end 순서를 본다. 모델은 가짜.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { addMember, createSpace } from "../../src/lib/service";
import type { ModelRole } from "../../src/lib/live/contract";
import { setLlm, type CallInput, type LlmFn } from "../../src/lib/live/llm";
import { WATCH_SYSTEM } from "../../src/lib/live/prompts";
import { POST as start } from "../../src/app/api/live/start/route";
import { GET as getInfo } from "../../src/app/api/live/[meetingId]/route";
import { POST as utter } from "../../src/app/api/live/[meetingId]/utterance/route";
import { POST as gap } from "../../src/app/api/live/[meetingId]/gap/route";
import { POST as barge } from "../../src/app/api/live/[meetingId]/barge/route";
import { POST as settings } from "../../src/app/api/live/[meetingId]/settings/route";
import { POST as end } from "../../src/app/api/live/[meetingId]/end/route";
import { GET as stream } from "../../src/app/api/live/[meetingId]/stream/route";
import { GET as state } from "../../src/app/api/live/[meetingId]/state/route";
import { GET as docsList } from "../../src/app/api/live/docs/route";
import { shutdownMeetings } from "../../src/lib/live/meeting";

process.env.GALPI_INGEST_DIR = path.join(process.cwd(), "tests", ".tmp", `api-ingest-${process.pid}`);

// 가짜 모델: "웹 말고 봇"이면 결정 n1과 어긋남
const fakeLlm = (async (role: ModelRole, input: CallInput<z.ZodType>) => {
  let text = "";
  if (input.system[0] === WATCH_SYSTEM) {
    const bad = (input.user.split("## 이번 발화\n")[1] ?? "").includes("봇으로");
    text = JSON.stringify({ conflict: { found: bad, node_ids: bad ? ["n1"] : [], fact_ids: [], said: "", against: "" }, agreement: { found: false, title: "", from: null, to: "", utt_ids: [] }, call: { addressed: false, want: "none", question: "" }, resolved: [] });
    input.onText?.(text);
  } else if (role === "verify") text = "OK\n반대\n근거: n1";
  else if (role === "speak") text = "잠깐만요, 웹 중심으로 정했어요.";
  const out = input.schema ? (input.strict ? { items: [] } : input.schema.parse(JSON.parse(text))) : text;
  return { text, out, stat: { role, model: "fake", ms: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
}) as LlmFn;

beforeAll(() => {
  setLlm(fakeLlm);
  process.env.LIVE_AUTO_PROCESS = "0";
});
afterAll(() => {
  setLlm(null);
  shutdownMeetings();
});

const ctx = (meetingId: string) => ({ params: Promise.resolve({ meetingId }) });
const post = (url: string, body: unknown, token?: string) =>
  new Request(`http://t/api/live${url}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "x-live-token": token } : {}) }, body: JSON.stringify(body) });

// 결정 하나(n1, 합의됨)가 있는 예시 스페이스 (예시 스페이스는 로그인 없이 열린다)
async function demo() {
  const { getDb, newId, now } = await import("../../src/lib/db");
  const { rebuildHead } = await import("../../src/lib/head");
  const sp = createSpace("예시", undefined, true);
  for (const n of ["기헌", "준영"]) addMember(sp.id, n);
  const db = getDb();
  const ses = newId("se");
  db.prepare(`INSERT INTO sessions (id, space_id, title, held_at, participants, transcript, status, kind, created_at) VALUES (?, ?, '회의 3', '2026-10-10', '', '', 'done', 'meeting', ?)`).run(ses, sp.id, now());
  const src = Number(db.prepare(`INSERT INTO sources (session_id, idx, speaker, text, created_at) VALUES (?, 1, '기헌', '입구는 웹', ?)`).run(ses, now()).lastInsertRowid);
  const changes = [{ op: "add", node_id: "n1", node: { type: "decision", title: "입구는 웹 중심", body: "", topic: "입구", owner: null, status: "agreed", due: null }, source_ids: [src], reason: "" }];
  db.prepare(`INSERT INTO commits (id, space_id, session_id, seq, message, status, needs_review, review_reason, reverted, changes_json, created_at) VALUES (?, ?, ?, 1, 'x', 'applied', 0, NULL, 0, ?, ?)`).run(newId("c"), sp.id, ses, JSON.stringify(changes), now());
  rebuildHead(sp.id);
  return sp;
}

async function readEvents(res: Response, until: (types: string[]) => boolean, ms = 2000): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const types: string[] = [];
  let buf = "";
  const t0 = Date.now();
  while (!until(types) && Date.now() - t0 < ms) {
    const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 200))]);
    if (value) buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const d = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(i + 2);
      const ev = d ? JSON.parse(d.slice(6)) : null;
      if (ev && !(ev.type === "prepare" && ev.actionId === "templates")) types.push(ev.type); // 회의 시작 때 미리 만든 말은 빼고
    }
    if (done && !value) continue;
  }
  await reader.cancel();
  return types;
}

describe("API 왕복", () => {
  it("start는 회의 번호와 열쇠를 주고, 열쇠 없는 요청은 401", async () => {
    const sp = await demo();
    const r = await start(post("/start", { spaceId: sp.id, title: "회의 4", agenda: [], intensity: "high", participants: ["기헌", "준영"] }));
    const { meetingId, controlToken } = (await r.json()) as { meetingId: string; controlToken: string };
    expect(meetingId).toBeTruthy();
    expect(controlToken).toBeTruthy();
    expect((await utter(post(`/${meetingId}/utterance`, { id: 1, t0: 0, t1: 1, text: "안녕" }), ctx(meetingId))).status).toBe(401);
    expect((await utter(post(`/${meetingId}/utterance`, { id: 1, t0: 0, t1: 1, text: "안녕" }, "wrong-token"), ctx(meetingId))).status).toBe(401);
    expect((await state(new Request(`http://t/api/live/${meetingId}/state`), ctx(meetingId))).status).toBe(401);
    expect((await stream(new Request(`http://t/api/live/${meetingId}/stream`), ctx(meetingId))).status).toBe(401);
    expect((await utter(post(`/${meetingId}/utterance`, { id: 1, t0: 0, t1: 1, text: "안녕" }, controlToken), ctx(meetingId))).status).toBe(200);
  });

  it("회의 비용 상한(budgetUsd)은 0보다 큰 숫자만", async () => {
    const sp = await demo();
    expect((await start(post("/start", { spaceId: sp.id, title: "t", agenda: [], intensity: "high", budgetUsd: -1 }))).status).toBe(400);
    expect((await start(post("/start", { spaceId: sp.id, title: "t", agenda: [], intensity: "high", budgetUsd: "많이" }))).status).toBe(400);
    const ok = (await (await start(post("/start", { spaceId: sp.id, title: "t", agenda: [], intensity: "high", budgetUsd: 0.5 }))).json()) as { meetingId: string; controlToken: string };
    const r = await getInfo(new Request(`http://t/api/live/${ok.meetingId}`, { headers: { "x-live-token": ok.controlToken } }), ctx(ok.meetingId));
    expect(await r.json()).toMatchObject({ budgetUsd: 0.5 });
  });

  it("없는 회의는 404, 잘못된 몸은 400", async () => {
    expect((await utter(post(`/nope/utterance`, { id: 1, text: "x" }, "t"), ctx("nope"))).status).toBe(404);
    const sp = await demo();
    expect((await start(post("/start", { spaceId: sp.id }))).status).toBe(400);
    const { meetingId, controlToken } = (await (await start(post("/start", { spaceId: sp.id, title: "t", agenda: [], intensity: "high" }))).json()) as { meetingId: string; controlToken: string };
    expect((await utter(post(`/${meetingId}/utterance`, { text: "번호 없음" }, controlToken), ctx(meetingId))).status).toBe(400);
  });

  it("stream(열쇠는 ?token=)으로 queued → prepare → speak 순서가 온다", async () => {
    const sp = await demo();
    const { meetingId, controlToken } = (await (await start(post("/start", { spaceId: sp.id, title: "회의 4", agenda: [], intensity: "high", participants: ["기헌", "준영"] }))).json()) as { meetingId: string; controlToken: string };
    const res = await stream(new Request(`http://t/api/live/${meetingId}/stream?token=${controlToken}`), ctx(meetingId));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    await utter(post(`/${meetingId}/utterance`, { id: 1, t0: 0, t1: 2, text: "디스코드 봇으로 입구를 하죠", speaker: "준영" }, controlToken), ctx(meetingId));
    await new Promise((r) => setTimeout(r, 30));
    await gap(post(`/${meetingId}/gap`, { after_id: 1, ms: 300 }, controlToken), ctx(meetingId));
    const types = await readEvents(res, (t) => t.includes("speak"));
    expect(types.filter((t) => t !== "latency" && t !== "budget")).toEqual(["queued", "prepare", "speak"]);
  });

  // 화면(S6 client.ts)이 하는 순서 그대로: barge_in → POST /barge {id: 끊은 말 번호, playedMs} → 그 번호의 final에 barge 판정
  it("끊김: 남의 목소리(other)·짧게 끊김이면 다음 침묵에 다시 말하고, 멤버(member)면 다시 안 한다", async () => {
    const run = async (verdict: "other" | "member") => {
      const sp = await demo();
      const { meetingId, controlToken } = (await (await start(post("/start", { spaceId: sp.id, title: "회의 4", agenda: [], intensity: "high", participants: ["기헌", "준영"] }))).json()) as { meetingId: string; controlToken: string };
      const res = await stream(new Request(`http://t/api/live/${meetingId}/stream?token=${controlToken}`), ctx(meetingId));
      await utter(post(`/${meetingId}/utterance`, { id: 1, t0: 0, t1: 2, text: "디스코드 봇으로 입구를 하죠", speaker: "준영" }, controlToken), ctx(meetingId));
      await new Promise((r) => setTimeout(r, 30));
      await gap(post(`/${meetingId}/gap`, { after_id: 1, ms: 300 }, controlToken), ctx(meetingId));
      await new Promise((r) => setTimeout(r, 30));
      expect((await barge(post(`/${meetingId}/barge`, { id: 2, playedMs: 600 }, controlToken), ctx(meetingId))).status).toBe(200);
      await utter(post(`/${meetingId}/utterance`, { id: 2, t0: 3, t1: 3.5, text: "아 잠깐만요 저기", barge: verdict }, controlToken), ctx(meetingId));
      await new Promise((r) => setTimeout(r, 30));
      await gap(post(`/${meetingId}/gap`, { after_id: 2, ms: 1500 }, controlToken), ctx(meetingId));
      return (await readEvents(res, (t) => t.filter((x) => x === "speak").length >= 2, 600)).filter((t) => t === "speak" || t === "cancel");
    };
    expect(await run("other")).toEqual(["speak", "cancel", "speak"]);
    expect(await run("member")).toEqual(["speak", "cancel"]);
  });

  it("GET 회의 정보(MeetingInfo)와 화면에서 바꾼 강도", async () => {
    const sp = await demo();
    const { meetingId, controlToken } = (await (await start(post("/start", { spaceId: sp.id, title: "회의 4", agenda: [{ title: "a", expected: ["b"] }], intensity: "low", participants: ["기헌"] }))).json()) as { meetingId: string; controlToken: string };
    const up = await settings(post(`/${meetingId}/settings`, { intensity: "high", confirmed: true }, controlToken), ctx(meetingId));
    expect(await up.json()).toMatchObject({ applied: true });
    const r = await getInfo(new Request(`http://t/api/live/${meetingId}`, { headers: { "x-live-token": controlToken } }), ctx(meetingId));
    expect(await r.json()).toMatchObject({ meetingId, spaceId: sp.id, title: "회의 4", intensity: "high", ended: false, participants: ["기헌"], status: { type: "status", state: "ok" } });
  });

  it("end는 EndMeetingRes {sessionId, items}를 돌려준다", async () => {
    const sp = await demo();
    const { meetingId, controlToken } = (await (await start(post("/start", { spaceId: sp.id, title: "회의 4", agenda: [], intensity: "high", participants: ["기헌"] }))).json()) as { meetingId: string; controlToken: string };
    await utter(post(`/${meetingId}/utterance`, { id: 1, t0: 0, t1: 1, text: "시작해요", speaker: "기헌" }, controlToken), ctx(meetingId));
    const r = await end(post(`/${meetingId}/end`, {}, controlToken), ctx(meetingId));
    const body = (await r.json()) as { sessionId?: string; items?: unknown[] };
    expect(body.sessionId).toBeTruthy();
    expect(body.items).toEqual([]);
  });

  it("자료 목록은 스페이스를 줘야 하고, 그 스페이스 자료만 준다", async () => {
    expect(await (await docsList(new Request("http://t/api/live/docs"))).json()).toEqual([]);
    const sp = await demo();
    expect(await (await docsList(new Request(`http://t/api/live/docs?spaceId=${sp.id}`))).json()).toEqual([]);
  });
});
