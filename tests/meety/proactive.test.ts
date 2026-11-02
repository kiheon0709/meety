// 능동형 미티 (10/31 기헌 결정): think(떠올린 것 메모) · backchannel(맞장구) — 계약 확정 전 예상 꼴을 가짜 이벤트로
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/lib/live/contract";
import { initState, meetyMode, reduce, webSearching, type AgentEventX, type LiveAction, type LiveState } from "../../src/components/live/state";
import { ideaFx, NOD_S, nodFx, scanFx } from "../../src/components/meety/pose";

const run = (evs: (AgentEventX | LiveAction)[], s: LiveState = initState("mid")) =>
  evs.reduce((st, e) => reduce(st, "src" in e ? e : { src: "agent", ev: e }), s);
const think = (text: string, kind: "idea" | "research" = "idea"): AgentEventX => ({ type: "think", kind, text });
const ev = { label: "10/10 회의 — 입구는 웹 중심" };

describe("생각 메모 (think)", () => {
  it("떠올리면 메모가 생기고 소리·손들기·말하기 상태는 아니다 (듣는 중 그대로)", () => {
    const s = run([think("촬영 날짜가 아직 안 정해졌어요")]);
    expect(s.think).toMatchObject({ n: 1, kind: "idea", text: "촬영 날짜가 아직 안 정해졌어요" });
    expect(meetyMode(s)).toBe("listening");
    expect(run([think("b")], s).think?.n).toBe(2); // 새로 떠올릴 때마다 마스코트가 다시 반응하게
  });

  it("말하려 하면(queued) 메모가 왜 카드의 이유가 된다 — 두뇌가 why를 주면 그게 먼저", () => {
    const s = run([think("촬영 날짜가 아직 안 정해졌어요"), { type: "queued", actionId: "a1", kind: "owner_gap", preview: "촬영 날짜…" }]);
    expect(s.think).toBeUndefined();
    expect(s.queued?.why).toBe("촬영 날짜가 아직 안 정해졌어요");
    const t = run([think("메모"), { type: "queued", actionId: "a1", kind: "owner_gap", preview: "…", why: "두뇌 이유" }]);
    expect(t.queued?.why).toBe("두뇌 이유");
  });

  it("queued 없이 바로 말해도 메모가 말하는 이유로 이어진다", () => {
    const s = run([think("리허설 담당이 없어요"), { type: "speak", actionId: "a1", kind: "owner_gap", text: "", sentences: ["리허설은 누가 맡을까요?"], evidence: [ev] } as AgentEvent]);
    expect(s.think).toBeUndefined();
    expect(s.speech?.why).toBe("리허설 담당이 없어요");
  });

  it("손을 들면 메모는 손든 카드로 바뀌어 사라진다", () => {
    const s = run([think("메모"), { type: "hand_raise", actionId: "h1", kind: "conflict", preview: "…", evidence: [] }]);
    expect(s.think).toBeUndefined();
  });

  it("찾아보는 중(research)은 결과 카드(show)가 오면 끝, 다른 생각은 show로 안 지워진다", () => {
    const show = { type: "show", actionId: "r1", canvas: { kind: "text", title: "회의록 도구 비교", lines: ["클로바노트 — 녹취·요약"] } } as AgentEvent;
    expect(run([think("회의록 도구 찾아보는 중", "research"), show]).think).toBeUndefined();
    expect(run([think("아이디어"), show]).think?.text).toBe("아이디어");
  });

  it("스스로 웹에서 찾는 중(draft why '웹에서 찾는 중 · 검색어')은 검색어를 화면 메모로, 끝나면(dropped·말) 지운다", () => {
    const start: AgentEventX = { type: "draft", uttId: 5, kind: "research", state: "thinking", why: "웹에서 찾는 중 · 회의 AI 시장 규모" };
    expect(webSearching(run([start]))).toBe("회의 AI 시장 규모");
    expect(webSearching(run([start, { type: "draft", uttId: 5, kind: "research", state: "dropped", why: "카드로" }]))).toBeUndefined();
    expect(webSearching(run([start, { type: "speak", actionId: "a", kind: "ack", text: "네, 한번 찾아볼게요.", sentences: ["네, 한번 찾아볼게요."], evidence: [] }]))).toBeUndefined();
    expect(webSearching(run([{ type: "draft", uttId: 6, kind: "conflict", state: "thinking", why: "어긋나 보여요" }]))).toBeUndefined();
  });
});

describe("맞장구 (backchannel)", () => {
  it("화면엔 끄덕임 횟수만 늘고 자막·말하기 상태는 없다", () => {
    const s = run([{ type: "backchannel", text: "네" }, { type: "backchannel", text: "음" }]);
    expect(s.nods).toBe(2);
    expect(s.speech).toBeUndefined();
    expect(meetyMode(s)).toBe("listening");
  });
});

describe("마스코트 작은 반응", () => {
  it("떠올림: 0.5초 안에 살짝 뛰었다 내려오고 눈은 위로 갔다가 돌아온다", () => {
    expect(ideaFx(0.25).hop).toBeGreaterThan(0.04);
    expect(ideaFx(0.6).hop).toBe(0);
    expect(ideaFx(0.5).up).toBe(1);
    expect(ideaFx(3).up).toBeLessThan(0.01);
    expect(ideaFx(-1)).toEqual({ hop: 0, up: 0 });
  });
  it("끄덕임: 0.5초에 한 번 내려갔다 올라옴", () => {
    expect(nodFx(NOD_S / 2)).toBeCloseTo(1);
    expect(nodFx(NOD_S)).toBe(0);
    expect(nodFx(-0.1)).toBe(0);
  });
  it("찾는 중: 눈이 좌우로 -1~1", () => {
    const xs = Array.from({ length: 40 }, (_, i) => scanFx(i * 0.1));
    expect(Math.min(...xs)).toBeLessThan(-0.9);
    expect(Math.max(...xs)).toBeGreaterThan(0.9);
  });
});
