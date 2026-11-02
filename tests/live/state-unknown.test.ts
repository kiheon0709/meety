// 화면 상태: 모르는 이벤트가 와도 죽지 않는다 (실제 녹화 E2E에서 두뇌의 status 이벤트로 state가 undefined가 되어 죽었다)
import { describe, expect, it } from "vitest";
import { initState, meetyMode, reduce, type LiveAction } from "../../src/components/live/state";

describe("화면 상태 리듀서", () => {
  it("모르는 두뇌 이벤트는 무시한다", () => {
    const s = initState();
    const next = reduce(s, { src: "agent", ev: { type: "something_new", x: 1 } } as unknown as LiveAction);
    expect(next).toBe(s);
    expect(meetyMode(next)).toBe("listening");
  });

  it("모르는 음성 이벤트는 무시한다", () => {
    const s = initState();
    expect(reduce(s, { src: "voice", ev: { type: "unknown_voice" } } as unknown as LiveAction)).toBe(s);
  });

  it("status ok는 아무것도 안 바꾸고, ok가 아니면 알림을 띄운다", () => {
    const s = initState();
    expect(reduce(s, { src: "agent", ev: { type: "status", state: "ok", message: "정상" } })).toBe(s);
    const bad = reduce(s, { src: "agent", ev: { type: "status", state: "paused", reason: "rate_limit", message: "잠깐 쉬는 중이에요" } });
    expect(bad.toast?.text).toContain("잠깐 쉬는 중");
  });

  it("모르는 화면 동작도 무시한다", () => {
    const s = initState();
    expect(reduce(s, { type: "no_such_action" } as unknown as LiveAction)).toBe(s);
  });
});
