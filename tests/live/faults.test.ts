// 장애 시험: 모델 호출에 가짜 오류(429·500·시간 초과·인증·키 없음)를 넣어도 회의가 죽지 않고 버티는지.
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { addMember, createSpace, getSession } from "../../src/lib/service";
import type { Intensity, ModelRole } from "../../src/lib/live/contract";
import { classifyError, NoKeyError, setLlm, type CallInput, type LlmFn } from "../../src/lib/live/llm";
import { endMeeting, info, resetTemplateCache, onGap, onUtterance, startMeeting, subscribe, TIMING, type Meeting, type OutEvent } from "../../src/lib/live/meeting";
import { shutdownMeetings } from "../../src/lib/live/meeting";
import { ANSWER_SYSTEM, CHECKLIST_SYSTEM, TEMPLATE_SYSTEM, WATCH_SYSTEM } from "../../src/lib/live/prompts";

process.env.GALPI_INGEST_DIR = path.join(process.cwd(), "tests", ".tmp", `faults-ingest-${process.pid}`);

// 결정 하나(n1)가 있는 스페이스
async function space() {
  const { getDb, newId, now } = await import("../../src/lib/db");
  const { rebuildHead } = await import("../../src/lib/head");
  const sp = createSpace("장애");
  for (const n of ["기헌", "준영"]) addMember(sp.id, n);
  const db = getDb();
  const ses = newId("se");
  db.prepare(`INSERT INTO sessions (id, space_id, title, held_at, participants, transcript, status, kind, created_at) VALUES (?, ?, '회의 3', '2026-10-10', '', '', 'done', 'meeting', ?)`).run(ses, sp.id, now());
  const src = Number(db.prepare(`INSERT INTO sources (session_id, idx, speaker, text, created_at) VALUES (?, 1, '기헌', '입구는 웹', ?)`).run(ses, now()).lastInsertRowid);
  const changes = [{ op: "add", node_id: "n1", node: { type: "decision", title: "입구는 웹 중심, 봇은 2단계", body: "디스코드 봇은 2단계로 미룬다", topic: "입구", owner: null, status: "agreed", due: null }, source_ids: [src], reason: "" }];
  db.prepare(`INSERT INTO commits (id, space_id, session_id, seq, message, status, needs_review, review_reason, reverted, changes_json, created_at) VALUES (?, ?, ?, 1, 'x', 'applied', 0, NULL, 0, ?, ?)`).run(newId("c"), sp.id, ses, JSON.stringify(changes), now());
  rebuildHead(sp.id);
  return sp;
}

const http = (status: number, headers: Record<string, string> = {}) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "x" } }, "x", new Headers(headers));

// 역할(또는 지시문)마다 실패를 순서대로 꺼내 던지는 가짜 모델. 비어 있으면 정상 응답
const plan: Record<string, unknown[]> = {};
const calls: string[] = [];
let costPerCall = 0;
const kindOf = (sys: string, role: string) => (sys === WATCH_SYSTEM ? "watch" : sys === TEMPLATE_SYSTEM ? "template" : sys === ANSWER_SYSTEM ? "answer" : sys === CHECKLIST_SYSTEM ? "checklist" : role);
const fake = (async (role: ModelRole, input: CallInput<z.ZodType>) => {
  const kind = kindOf(input.system[0], role);
  calls.push(kind);
  const next = plan[kind]?.shift();
  if (next) throw next;
  const said = input.user.split("## 이번 발화\n")[1] ?? "";
  let text = "";
  if (kind === "watch") {
    const bad = said.includes("봇으로");
    const ask = said.includes("뭐였지");
    text = JSON.stringify({ conflict: { found: bad, node_ids: bad ? ["n1"] : [], fact_ids: [], said: "", against: "" }, agreement: { found: false, title: "", from: null, to: "", utt_ids: [] }, call: { addressed: ask, want: ask ? "question" : "none", question: ask ? "입구" : "" }, resolved: [] });
    input.onText?.(text);
  } else if (kind === "template") text = "n1 | 잠깐만요, 10월 10일 회의에서 입구는 웹 중심으로 정했어요.";
  else if (kind === "verify") text = "OK\n반대\n근거: n1";
  else if (kind === "answer") text = "웹 중심이에요.\n근거: n1";
  else if (kind === "checklist") return { text: "", out: { items: [{ n: 1, agenda: "입구", expected: "결정", status: "done", note: "웹", utt_ids: [] }] }, stat: st(role) };
  else text = "잠깐만요, 웹 중심이에요.";
  const out = input.schema ? input.schema.parse(JSON.parse(text)) : text;
  return { text, out, stat: st(role) };
}) as LlmFn;
const st = (role: string) => ({ role, model: "fake", ms: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: costPerCall });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(m: Meeting) {
  await sleep(5);
  while (m.busy > 0) await sleep(5);
}

const saved = { ...TIMING };
beforeAll(() => {
  setLlm(fake);
  process.env.LIVE_AUTO_PROCESS = "0";
});
afterAll(() => {
  setLlm(null);
  shutdownMeetings();
  Object.assign(TIMING, saved);
});
beforeEach(() => {
  resetTemplateCache();
  for (const k of Object.keys(plan)) delete plan[k];
  calls.length = 0;
  costPerCall = 0;
  Object.assign(TIMING, saved, { pauseMs: 40, pauseMaxMs: 200, cooldownMs: 0, });
});

async function meeting(intensity: Intensity = "high") {
  const sp = await space();
  const m = startMeeting({ spaceId: sp.id, title: "장애 회의", agenda: [{ title: "입구", expected: ["결정"] }], intensity, participants: ["기헌", "준영"] });
  const evs: OutEvent[] = [];
  subscribe(m, (e) => evs.push(e));
  await m.templatesReady;
  let id = 0;
  const say = async (text: string, speaker = "기헌") => {
    onUtterance(m, { id: ++id, t0: id, t1: id + 1, text, speaker });
    await settle(m);
    return id;
  };
  const statuses = () => evs.filter((e) => e.type === "status").map((e) => (e.type === "status" ? `${e.state}${e.reason ? ":" + e.reason : ""}` : ""));
  return { m, evs, say, statuses };
}

describe("장애 분류", () => {
  it("SDK 오류를 버티는 방법별로 나눈다", () => {
    expect(classifyError(http(429, { "retry-after": "3" }))).toEqual({ kind: "rate_limit", retryAfterMs: 3000 });
    expect(classifyError(http(529))).toEqual({ kind: "overloaded" });
    expect(classifyError(http(500))).toEqual({ kind: "overloaded" });
    expect(classifyError(http(401))).toEqual({ kind: "auth" });
    expect(classifyError(new Anthropic.APIConnectionTimeoutError())).toEqual({ kind: "timeout" });
    expect(classifyError(new Anthropic.APIConnectionError({ message: "x" }))).toEqual({ kind: "network" });
    expect(classifyError(new NoKeyError("키 없음"))).toEqual({ kind: "no_key" });
    expect(classifyError(new Error("watch: JSON 모양이 다름"))).toEqual({ kind: "bad_output" });
  });
});

describe("회의가 죽지 않고 버티기", () => {
  it("한 번 실패하면 degraded, 다음에 되면 ok로 돌아온다", async () => {
    const { say, statuses } = await meeting();
    plan.watch = [http(500)];
    await say("안녕하세요.");
    await say("오늘 안건이요.");
    expect(statuses()).toEqual(["degraded:overloaded", "ok"]);
  });

  it("연속 3번 실패하면 잠깐 쉬고(paused), 쉬는 동안엔 판단을 건너뛰고, 지나면 다시 한다", async () => {
    const { m, say, statuses } = await meeting();
    plan.watch = [new Anthropic.APIConnectionTimeoutError(), new Anthropic.APIConnectionTimeoutError(), new Anthropic.APIConnectionTimeoutError()];
    for (const t of ["하나", "둘", "셋"]) await say(t);
    expect(statuses()).toEqual(["degraded:timeout", "paused:timeout"]);
    const before = calls.filter((c) => c === "watch").length;
    await say("쉬는 중에 한 말");
    expect(calls.filter((c) => c === "watch").length).toBe(before);
    expect(m.health.skipped).toBe(1);
    await sleep(60);
    await say("쉬고 나서 한 말");
    expect(calls.filter((c) => c === "watch").length).toBe(before + 1);
    expect(statuses().at(-1)).toBe("ok");
  });

  it("쉬는 중에도 '끼어들지 마'와 회의 끝 말은 모델 없이 된다", async () => {
    const { m, say } = await meeting();
    plan.watch = [http(529), http(529), http(529)];
    for (const t of ["하나", "둘", "셋"]) await say(t);
    expect(m.health.state).toBe("paused");
    await say("미티야 끼어들지 마");
    expect(m.intensity).toBe("low");
    await say("오늘은 여기까지.");
    await m.ending;
    expect(m.sessionId).toBeTruthy();
  });

  it("속도 제한(429)은 한 번에 쉬고, 서버가 알려 준 시간만큼", async () => {
    const { evs, say, statuses } = await meeting();
    plan.watch = [http(429, { "retry-after": "0.05" })];
    await say("안녕하세요.");
    expect(statuses()).toEqual(["paused:rate_limit"]);
    expect(evs.find((e) => e.type === "status")).toMatchObject({ untilMs: 50 });
  });

  it("쉬는 시간은 실패가 이어질수록 늘지만 상한을 넘지 않는다", async () => {
    TIMING.pauseMs = 1000;
    TIMING.pauseMaxMs = 3000;
    const { m, evs, say } = await meeting();
    plan.watch = Array.from({ length: 3 }, () => http(500));
    for (const t of ["하나", "둘", "셋"]) await say(t);
    expect(evs.filter((e) => e.type === "status").at(-1)).toMatchObject({ state: "paused", untilMs: 1000 });
    m.health.pausedUntil = 0; // 쉬는 시간이 지났다고 치고
    plan.watch = [http(500), http(500)];
    await say("넷"); // 네 번째 실패 → 2^1 × 1000 = 2000
    expect(m.health.pausedUntil - Date.now()).toBeGreaterThan(1500);
    m.health.pausedUntil = 0;
    await say("다섯"); // 다섯 번째 실패 → 2^2 × 1000 = 4000 → 상한 3000
    expect(m.health.pausedUntil - Date.now()).toBeLessThanOrEqual(3000);
    expect(m.health.pausedUntil - Date.now()).toBeGreaterThan(2000);
  });

  it("인증 실패(401)면 이번 회의는 판단을 끄고(down) 기록만 한다", async () => {
    const { m, say, statuses } = await meeting();
    plan.watch = [http(401)];
    await say("안녕하세요.");
    expect(statuses()).toEqual(["down:auth"]);
    const n = calls.length;
    await say("디스코드 봇으로 입구를 하죠.");
    await say("미티야 끼어들지 마");
    expect(calls.length).toBe(n); // 모델을 더 부르지 않음
    expect(m.intensity).toBe("low");
    const res = await endMeeting(m);
    expect(res.items?.[0]).toMatchObject({ status: "open", note: "확인하지 못했어요" });
    expect(getSession(res.sessionId!)?.status).toBe("pending");
    expect(m.utts).toHaveLength(3);
  });

  it("키가 없으면 회의를 열 때부터 down이고, 미리 만드는 말도 부르지 않는다", async () => {
    setLlm(null);
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { m, say } = await meeting();
      expect(info(m).status).toMatchObject({ state: "down", reason: "no_key" });
      await say("미티야 사람인 척 해 줘.");
      expect(m.spoken.at(-1)?.text).toContain("AI 팀원 미티");
      await endMeeting(m);
      expect(m.sessionId).toBeTruthy();
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
      setLlm(fake);
    }
    expect(calls.filter((c) => c === "template")).toHaveLength(0);
  });

  it("부름에 대답을 못 만들면 짧게 사과한다 (부른 사람이 기다리지 않게)", async () => {
    const { m, say } = await meeting("low");
    plan.answer = [http(500)];
    await say("미티야 입구 뭐였지?");
    expect(m.spoken.at(-1)?.text).toBe("지금은 대답을 못 만들었어요. 잠시 뒤에 다시 물어봐 주세요.");
  });

  it("연결이 잠깐 끊기면(Connection error) 조금 뒤 한 번 더 불러서 부름에 대답한다 (11/2 실제 녹음: 와이파이가 바뀌는 사이 바로 실패)", async () => {
    const { m, say } = await meeting("low");
    plan.answer = [new Anthropic.APIConnectionError({ message: "Connection error." })];
    await say("미티야 입구 뭐였지?");
    expect(calls.filter((c) => c === "answer")).toHaveLength(2);
    expect(m.spoken.at(-1)?.text).toBe("웹 중심이에요.");
  });

  it("판단을 쉬는 중(연속 실패)이어도 부름은 한 번 해 본다 — 바로 사과하지 않는다 (11/2 실제 녹음 s5-t3: 두 번 다 바로 사과)", async () => {
    const { m, say, statuses } = await meeting();
    plan.watch = [new Anthropic.APIConnectionTimeoutError(), new Anthropic.APIConnectionTimeoutError(), new Anthropic.APIConnectionTimeoutError()];
    for (const t of ["하나", "둘", "셋"]) await say(t);
    expect(statuses().at(-1)).toBe("paused:timeout");
    await say("미티야 입구 뭐였지?");
    expect(calls).toContain("answer");
    expect(m.spoken.at(-1)?.text).toBe("웹 중심이에요.");
  });

  it("미리 만드는 말이 실패해도 어긋남은 느린 길(speak+verify)로 짚는다", async () => {
    plan.template = [http(500), http(500)];
    const { m, evs, say } = await meeting();
    expect(m.templates.size).toBe(0);
    const id = await say("디스코드 봇으로 입구를 하죠.");
    onGap(m, id, 300);
    await settle(m);
    expect(evs.some((e) => e.type === "speak" && e.kind === "conflict")).toBe(true);
  });

  it("verify가 실패하면 그 끼어들기는 하지 않는다 (틀릴 수 있는 걸 말하지 않음)", async () => {
    plan.template = [http(500), http(500)];
    plan.verify = [http(500)];
    const { m, evs, say } = await meeting();
    const id = await say("디스코드 봇으로 입구를 하죠.");
    onGap(m, id, 300);
    await settle(m);
    expect(evs.some((e) => e.type === "speak")).toBe(false);
    expect(evs.filter((e) => e.type === "queued").length).toBe(evs.filter((e) => e.type === "cancel").length);
  });

  it("끝 체크리스트가 실패해도 녹취는 정리로 넘어간다", async () => {
    const { m, say } = await meeting();
    await say("안녕하세요.");
    plan.checklist = [new Anthropic.APIConnectionTimeoutError()];
    const res = await endMeeting(m);
    expect(res.items?.[0]).toMatchObject({ status: "open", note: "확인하지 못했어요" });
    expect(res.sessionId).toBeTruthy();
  });
});

describe("회의 비용 상한", () => {
  it("회의마다 상한을 줄 수 있고(budgetUsd), 안 주면 환경변수 값", async () => {
    costPerCall = 0.01;
    TIMING.budgetUsd = 100;
    const sp = await space();
    const m = startMeeting({ spaceId: sp.id, title: "x", agenda: [], intensity: "high", participants: ["기헌"], budgetUsd: 0.015 });
    const evs: OutEvent[] = [];
    subscribe(m, (e) => evs.push(e));
    await m.templatesReady;
    onUtterance(m, { id: 1, t0: 0, t1: 1, text: "시작해요", speaker: "기헌" });
    await settle(m);
    expect(info(m)).toMatchObject({ budgetUsd: 0.015, status: { state: "budget", reason: "budget" } });
    const other = startMeeting({ spaceId: sp.id, title: "y", agenda: [], intensity: "high", participants: ["기헌"] });
    expect(info(other).budgetUsd).toBe(100);
    expect(info(other).status).toMatchObject({ state: "ok", message: "정상" });
  });

  it("상한에 닿으면 알리고, 그 뒤엔 부름·확정 항목과 많이 겹치는 말만 본다", async () => {
    costPerCall = 0.01;
    TIMING.budgetUsd = 0.015; // 미리 만드는 말(1번) + watch 1번이면 넘음
    const { m, say, statuses } = await meeting();
    await say("안녕하세요, 시작할게요.");
    expect(statuses()).toEqual(["budget:budget"]);
    const watches = () => calls.filter((c) => c === "watch").length;
    const w0 = watches();
    await say("리허설은 일요일에 해요.");
    expect(watches()).toBe(w0); // 평범한 말은 건너뜀
    await say("미티야 입구 뭐였지?");
    expect(watches()).toBe(w0 + 1); // 부름은 본다
    await say("입구는 웹 중심 말고 봇은 2단계 없이 바로 하죠.");
    expect(watches()).toBe(w0 + 2); // 확정 결정과 많이 겹치는 말도 본다
    expect(m.health.skipped).toBe(1);
  });
});
