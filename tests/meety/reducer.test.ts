// 새 두뇌 이벤트(계약 b07fdea)를 화면 상태로: 왜 카드, 캔버스, 사설, 예산, 자동 침묵, 역할, 못 한 말
import { describe, expect, it } from "vitest";
import type { AgentEvent, VoiceEvent } from "../../src/lib/live/contract";
import { initState, meetyMode, reduce, type LiveAction, type LiveState } from "../../src/components/live/state";

const run = (evs: (AgentEvent | LiveAction)[], s: LiveState = initState("mid")) =>
  evs.reduce((st, e) => reduce(st, "src" in e ? e : { src: "agent", ev: e }), s);
const ev = { label: "9/30 회의 — 입구는 웹 중심" };

describe("새 두뇌 이벤트 → 화면 상태", () => {
  it("queued의 why·evidence를 왜 카드용으로 들고 있다 (speak 전에)", () => {
    const s = run([{ type: "queued", actionId: "a1", kind: "conflict", preview: "디스코드 입구는…", why: "9/30에 웹 중심으로 정함", evidence: [ev] }]);
    expect(s.queued).toMatchObject({ why: "9/30에 웹 중심으로 정함", evidence: [ev] });
    expect(meetyMode(s)).toBe("has_something");
  });

  it("show: 맞는 캔버스는 띄우고 지난 것은 목록으로, 모르는 kind는 무시", () => {
    const show = (actionId: string, canvas: unknown) => ({ type: "show", actionId, canvas }) as AgentEvent;
    let s = run([show("a1", { kind: "evidence", items: [ev] })]);
    expect(s.canvas?.spec.kind).toBe("evidence");
    s = run([show("a2", { kind: "compare", title: "t", aLabel: "a", bLabel: "b", rows: [{ label: "x", a: 1, b: 2 }] })], s);
    expect(s.canvas?.actionId).toBe("a2");
    expect(s.shown.map((c) => c.actionId)).toEqual(["a1", "a2"]);
    const same = run([show("a3", { kind: "hologram" })], s);
    expect(same.canvas?.actionId).toBe("a2");
  });

  it("사설: 호스트 승인 대기 목록, 처리하면 상태가 바뀐다", () => {
    let s = run([{ type: "private", actionId: "p1", to: "지호", kind: "quiet_member", text: "지호 님이 10분째 말이 없어요", evidence: [] }]);
    expect(s.privates).toMatchObject([{ actionId: "p1", status: "pending" }]);
    s = run([{ src: "ui", type: "private_done", actionId: "p1", to: "person" }], s);
    expect(s.privates[0].status).toBe("person");
  });

  it("예산·자동 침묵·역할 설정", () => {
    const s = run([
      { type: "budget", used: 1, limit: 1, windowMin: 10 },
      { type: "mode", quiet: true, reason: "time_pressure", message: "끝날 시간이 가까워 조용히 있을게요" },
      { type: "settings", intensity: "mid", by: "screen", roles: { suggest: false }, budgetPer10Min: 2 },
    ]);
    expect(s.budget).toEqual({ used: 1, limit: 1, windowMin: 10 });
    expect(s.quiet?.reason).toBe("time_pressure");
    expect(s.roles).toEqual({ suggest: false });
    expect(s.budgetPer10Min).toBe(2);
    expect(run([{ type: "mode", quiet: false, reason: "host", message: "" }], s).quiet).toBeUndefined();
  });

  it("끊긴 말의 못 한 문장(cancel.rest)을 남긴다", () => {
    const s = run([
      { type: "speak", actionId: "a1", kind: "conflict", text: "하나. 둘. 셋.", sentences: ["하나.", "둘.", "셋."], evidence: [] },
      { src: "ui", type: "sentence", actionId: "a1", index: 0 },
      { type: "cancel", actionId: "a1", reason: "barge_in", rest: ["둘.", "셋."] },
    ]);
    expect(s.said.at(-1)).toMatchObject({ status: "cut", rest: ["둘.", "셋."] });
  });
});

describe("말 끊김 표시는 끊은 그 말 동안만", () => {
  it("끊은 사람이 말을 마치면 듣는 중, 그 뒤 다른 말에는 다시 '말 끊김'이 뜨지 않는다 (실제 모드에서 깜빡이던 것)", () => {
    const v = (ev: VoiceEvent): LiveAction => ({ src: "voice", ev });
    let s = run([
      { type: "speak", actionId: "a1", kind: "ack", text: "알겠어요.", sentences: ["알겠어요."], evidence: [] },
      { src: "ui", type: "sentence", actionId: "a1", index: 0 },
      v({ type: "speech_start", id: 5, t: 1 }),
      v({ type: "barge_in", id: 5, t: 1 }),
    ]);
    expect(meetyMode(s)).toBe("cut");
    s = run([v({ type: "speech_end", id: 5, t0: 1, t1: 2 }), v({ type: "final", id: 5, t0: 1, t1: 2, text: "잠깐만" })], s);
    expect(meetyMode(s)).toBe("listening");
    s = run([v({ type: "speech_start", id: 6, t: 3 })], s);
    expect(meetyMode(s)).toBe("listening");
  });
});
