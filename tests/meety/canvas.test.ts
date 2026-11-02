// 캔버스 스펙 검증(두뇌가 고르고 화면이 그린다) + 이벤트가 없을 때 스스로 고르기
import { describe, expect, it } from "vitest";
import { autoCanvas, checkCanvas } from "../../src/components/meety/canvas";

const ev = { label: "9/30 회의 — 입구는 웹 중심, 디스코드 봇은 2단계", quote: "디스코드는 2단계로" };

describe("캔버스 스펙 검증", () => {
  it("맞는 스펙은 그대로", () => {
    const c = { kind: "compare", title: "입구", aLabel: "정한 것", bLabel: "지금 말", rows: [{ label: "입구", a: "웹", b: "디스코드" }] };
    expect(checkCanvas(c)).toEqual(c);
  });

  it("모르는 kind·깨진 스펙은 text로 낮추거나 버린다", () => {
    expect(checkCanvas({ kind: "pie", title: "x" })).toBeNull();
    expect(checkCanvas({ kind: "compare", title: "입구" })).toEqual({ kind: "text", title: "입구", lines: [] });
    expect(checkCanvas(null)).toBeNull();
  });

  it("너무 큰 스펙은 검증 전에 자른다 (zod 큰 배열 메모리 문제)", () => {
    const big = { kind: "evidence", items: Array.from({ length: 5000 }, () => ev) };
    expect((checkCanvas(big) as { items: unknown[] }).items.length).toBe(6);
    const tl = { kind: "timeline", title: "t", points: Array.from({ length: 50 }, (_, i) => ({ date: `${i}`, label: "x" })) };
    expect((checkCanvas(tl) as { points: unknown[] }).points.length).toBe(8);
  });

  it("flow는 v2 — 아직 안 그리고 text로", () => {
    expect(checkCanvas({ kind: "flow", title: "흐름", mermaid: "graph LR; A-->B" })).toEqual({ kind: "text", title: "흐름", lines: [] });
  });
});

describe("이벤트 없을 때 스스로 고르기 (v1)", () => {
  it("말하는 근거에 날짜가 둘 이상이면 timeline, 하나면 evidence", () => {
    const two = autoCanvas({ evidence: [ev, { label: "10/10 회의 — 웹 중심 다시 확인" }] });
    expect(two?.kind).toBe("timeline");
    expect(autoCanvas({ evidence: [ev] })?.kind).toBe("evidence");
    expect(autoCanvas({ evidence: [] })).toBeNull();
  });

  it("바뀐 것 카드(from→to)면 compare", () => {
    const c = autoCanvas({ evidence: [], card: { title: "디스코드 연동 범위", from: "알림만", to: "입구까지" } });
    expect(c).toMatchObject({ kind: "compare", rows: [{ label: "디스코드 연동 범위", a: "알림만", b: "입구까지" }] });
  });
});

import { pickCanvas } from "../../src/components/meety/pick";
import { initState, reduce } from "../../src/components/live/state";
import type { AgentEvent } from "../../src/lib/live/contract";

describe("어떤 캔버스를 띄우나 (pickCanvas)", () => {
  const agent = (s: ReturnType<typeof initState>, ev: AgentEvent) => reduce(s, { src: "agent", ev });
  // S3 research가 실제로 보내는 꼴 (src/lib/live/meeting.ts research): 소리 없이 show 하나, kind text, ttlMs 60초
  const research: AgentEvent = { type: "show", actionId: "r1", canvas: { kind: "text", title: "근데 대회 마감이 언제였지?", lines: ["대회 마감은 11월 2일이에요.", "출처: 갈피 — 지금 기획"] }, ttlMs: 60_000 };

  it("말·손 없이 혼자 온 show(리서치 카드)도 살아 있는 동안 띄운다", () => {
    const s = agent(initState("mid"), research);
    expect(pickCanvas(s, { liveShow: "r1" })?.spec).toMatchObject({ kind: "text", lines: ["대회 마감은 11월 2일이에요.", "출처: 갈피 — 지금 기획"] });
    expect(pickCanvas(s, { liveShow: null })).toBeNull(); // ttl 지나면 내림 (오른쪽 "보여 준 것"에서 다시)
  });

  it("말하는 중이면 그 말에 붙은 show가 먼저, 없으면 그 말의 근거로 스스로", () => {
    let s = agent(initState("mid"), research);
    s = agent(s, { type: "speak", actionId: "a1", kind: "conflict", text: "x", sentences: ["x"], evidence: [{ label: "9/30 회의 — 웹 중심" }] });
    s = reduce(s, { src: "ui", type: "sentence", actionId: "a1", index: 0 });
    expect(pickCanvas(s, { liveShow: "r1" })?.actionId).toBe("a1"); // 지금 말이 우선
    s = agent(s, { type: "show", actionId: "a1", canvas: { kind: "compare", title: "입구", aLabel: "정한 것", bLabel: "지금 말", rows: [{ label: "입구", a: "웹", b: "디스코드" }] } });
    expect(pickCanvas(s, { liveShow: "a1" })?.spec.kind).toBe("compare");
  });

  it("닫은 것·고정한 것", () => {
    const s = agent(initState("mid"), research);
    expect(pickCanvas(s, { liveShow: "r1", closed: "r1" })).toBeNull();
    expect(pickCanvas(s, { liveShow: null, pinned: "r1" })?.actionId).toBe("r1");
  });
});
