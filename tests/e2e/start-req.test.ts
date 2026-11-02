// 회의 시작 요청에 호스트·회의 종류·역할을 싣는다 (두뇌가 아직 안 써도 계약대로 먼저 보낸다)
import { describe, expect, it } from "vitest";
import { MODES, parseRoles, withHostMode } from "../../src/components/live/start-req";

const base = { spaceId: "sp", title: "회의", agenda: [], intensity: "mid" as const, participants: ["기헌", "태은", "지호"] };

describe("시작 요청 — 호스트·회의 종류·역할", () => {
  it("호스트를 안 고르면 첫 참석자, 고른 사람이 참석자에서 빠지면 다시 첫 참석자", () => {
    expect(withHostMode(base, { mode: "decision" })).toMatchObject({ host: "기헌", mode: "decision" });
    expect(withHostMode(base, { host: "태은", mode: "brainstorm" })).toMatchObject({ host: "태은", mode: "brainstorm" });
    expect(withHostMode(base, { host: "준영", mode: "decision" }).host).toBe("기헌");
    expect(withHostMode({ ...base, participants: [] }, { mode: "decision" }).host).toBeUndefined();
  });

  it("역할은 하나라도 끈 게 있을 때만 7개 다 싣는다 (없거나 다 켜져 있으면 두뇌가 회의 종류 기본값)", () => {
    expect(withHostMode(base, { mode: "presentation" })).not.toHaveProperty("roles");
    expect(withHostMode(base, { mode: "decision", roles: { conflict: true, suggest: false } }).roles).toMatchObject({ conflict: true, suggest: false, research: true });
  });

  it("회의 종류 세 가지에 이름이 있다", () => {
    expect(Object.keys(MODES)).toEqual(["decision", "brainstorm", "presentation"]);
  });

  it("명령줄 역할: 'conflict,research,-suggest' → 켜기·끄기, 모르는 이름은 버림", () => {
    expect(parseRoles("conflict,research,-suggest,nope")).toEqual({ conflict: true, research: true, suggest: false });
    expect(parseRoles(undefined)).toBeUndefined();
  });
});
