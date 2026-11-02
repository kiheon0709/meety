import { describe, expect, it } from "vitest";
import { isNoAgenda } from "@/components/live/EndView";
import type { MeetingSetup } from "@/components/live/state";

const setup = (agenda: MeetingSetup["agenda"]): MeetingSetup => ({ spaceId: "sp", title: "1:1", agenda, intensity: "high", participants: ["기헌"] });
const item = { agenda: "a", expected: "b", status: "open" as const, evidence: [] };

describe("회의 끝 화면 — 안건 없는 회의는 요약", () => {
  it("나와야 할 것을 하나도 안 적었으면 체크리스트가 와도 요약", () => {
    expect(isNoAgenda(setup([]), [item])).toBe(true);
    expect(isNoAgenda(setup([{ title: "디자인", expected: [] }]), [])).toBe(true);
  });
  it("하나라도 적었으면 체크리스트", () => {
    expect(isNoAgenda(setup([{ title: "디자인", expected: ["화면 순서"] }]), [item])).toBe(false);
  });
  it("설정을 모르는 기기는 받은 체크리스트로", () => {
    expect(isNoAgenda(null, [])).toBe(true);
    expect(isNoAgenda(null, [item])).toBe(false);
  });
});
