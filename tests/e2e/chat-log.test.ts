// 녹화 기록 → 말풍선 장면 기록(S11 형식) 변환 (scripts/chat-log.ts)
import { describe, expect, it } from "vitest";
import { toChat } from "../../scripts/chat-log";

const base = { clips: [], chunks: [], feedAt: null, labels: [], drafts: [], fps: [], speaks: [], asks: [], subs: [], mouth: [], forbidden: [] };
const rec = {
  ...base,
  t0: 1000,
  voice: [[2000, "speech_start", 1, null, 0], [3900, "speech_end", 1, null, 0], [4000, "final", 1, 0.9, 0], [8000, "speech_start", 2, null, 0]] as [number, string, number, number | null, number][],
  finals: [
    [4000, { id: 1, t0: 0, t1: 1.9, text: "이번에 안드로이드도 가치 내요", speaker: "준영" }],
    [5000, { id: 3, t0: 0, t1: 1, text: "10월 20일에", echo: true }],
  ] as NonNullable<import("../../scripts/screen-voice").Rec["finals"]>,
  brain: [
    [4100, { type: "queued", actionId: "a1", kind: "conflict", preview: "어긋남" }],
    [4200, { type: "speak", actionId: "a1", kind: "conflict", text: "", sentences: ["10월 20일에 iOS만 내기로 정했어요.", "그대로 갈까요?"], evidence: [{ label: "10/20 회의 — 첫 버전은 iOS만", quote: "안드로이드는 3월 이후" }] }],
    [9000, { type: "hand_raise", actionId: "a2", kind: "owner_gap", preview: "박람회 부스 담당이 없어요", evidence: [] }],
    [9500, { type: "private", actionId: "a4", kind: "quiet_member", to: "지호", text: "지호 님 생각도 듣고 싶어요", evidence: [] }],
    [9900, { type: "queued", actionId: "a3", kind: "structure", preview: "두 안 정리" }],
    [10000, { type: "show", actionId: "a3", canvas: { kind: "compare", title: "온보딩", aLabel: "한 장", bLabel: "세 장", rows: [{ label: "개발", a: "3일", b: "5일" }] } }],
  ] as NonNullable<import("../../scripts/screen-voice").Rec["brain"]>,
  tts: [[4500, true, "10월 20일에 iOS만 내기로 정했어요."], [7000, false, null], [7050, true, "그대로 갈까요?"], [8010, false, null]] as [number, boolean, string | null][],
  barges: [8000],
};

describe("chat-log", () => {
  it("사람 말·생각·말·근거 카드·끊김·손들기·사설·비교 카드를 장면 시각으로", () => {
    const c = toChat(rec, { id: "s1", title: "시험", script: [{ speaker: "준영", text: "이번에 안드로이드도 같이 내요." }] });
    expect(c.source.offset).toBe(0.5);
    expect(c.people).toEqual({ c: { name: "준영", color: "#6D28D9", bg: "#EDE9FE" }, d: { name: "지호", color: "#B45309", bg: "#FEF3C7" } });
    expect(c.events).toEqual([
      { t: 0.5, who: "c", text: "이번에 안드로이드도 같이 내요." },
      { t: 2.6, who: "meety", act: "think" },
      { t: 3, who: "meety", act: "say", text: "10월 20일에 iOS만 내기로 정했어요. 그대로 갈까요?", dur: 3.5 },
      { t: 3.4, who: "meety", act: "card", card: { label: "근거", title: "10/20 회의 — 첫 버전은 iOS만", body: "안드로이드는 3월 이후" } },
      { t: 6.5, who: "meety", act: "stop" },
      { t: 7.5, who: "meety", act: "hand", text: "박람회 부스 담당이 없어요" },
      { t: 8, who: "meety", act: "private", to: "d", text: "지호 님 생각도 듣고 싶어요" },
      { t: 8.4, who: "meety", act: "think" },
      { t: 8.5, who: "meety", act: "card", card: { label: "정리", title: "온보딩", body: "개발: 한 장 3일 / 세 장 5일" } },
    ]);
    expect(c.duration).toBe(11);
  });

  it("대본이 없으면 받아쓰기 글 그대로, --from/--to로 자른다", () => {
    const c = toChat(rec, { id: "s1", title: "시험", from: 3, to: 7 });
    expect(c.source.offset).toBe(3);
    expect(c.events.map((e) => e.act ?? e.text)).toEqual(["think", "say", "card", "stop"]);
    expect(c.duration).toBe(4);
  });

  it("웹 리서치 show(출처(웹) 줄)는 S11 웹 카드로", () => {
    const web = { ...rec, finals: [], tts: [], barges: [], brain: [[5000, { type: "show", actionId: "w1", canvas: { kind: "text", title: "웹에서 찾음 · 회의 AI", lines: ["Otter는 부르면 답해요.", "Teams는 채팅으로 요약해요.", "출처(웹): Otter Meeting Agent — https://otter.ai/a"] } }]] as NonNullable<import("../../scripts/screen-voice").Rec["brain"]> };
    const c = toChat(web, { id: "w", title: "웹", from: 3 });
    expect(c.events).toEqual([{ t: 1, who: "meety", act: "card", card: { kind: "web", title: "Otter는 부르면 답해요.", body: "Teams는 채팅으로 요약해요.", source: "Otter Meeting Agent", url: "https://otter.ai/a" } }]);
  });
});
