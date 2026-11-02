// 참여도 다이얼(0~10): 회의 종류가 초깃값, 화면 슬라이더로 바꾸면 두뇌에 settings.participation, 두뇌가 바꾸면 화면에
import { describe, expect, it } from "vitest";
import { LiveClient, silentAudio } from "../../src/components/live/client";
import { initState, reduce } from "../../src/components/live/state";
import { MODES, allRoles, participationOf, withHostMode } from "../../src/components/live/start-req";

const base = { spaceId: "sp", title: "회의", agenda: [], intensity: "mid" as const, participants: ["기헌"] };

describe("참여도 다이얼", () => {
  it("회의 종류가 초깃값: 결정 5 · 브레인스토밍 8 · 발표 3, 직접 고르면 그 값(0~10 정수로)", () => {
    expect(MODES.decision.participation).toBe(5);
    expect(MODES.brainstorm.participation).toBe(8);
    expect(MODES.presentation.participation).toBe(3);
    expect(withHostMode(base, { mode: "brainstorm" }).participation).toBe(8);
    expect(withHostMode(base, { mode: "brainstorm", participation: 2 }).participation).toBe(2);
    expect(withHostMode(base, { mode: "decision", participation: 12.4 }).participation).toBe(10);
  });

  it("다이얼이 없던 회의는 강도로 어림 (상 7 · 중 5 · 하 2)", () => {
    expect(participationOf({ intensity: "high" })).toBe(7);
    expect(participationOf({ intensity: "low" })).toBe(2);
    expect(participationOf({ intensity: "mid", participation: 9 })).toBe(9);
  });

  it("두뇌 settings.participation이 화면 값을 바꾼다", () => {
    const s = reduce(initState("mid"), { src: "agent", ev: { type: "settings", intensity: "mid", by: "기헌", participation: 8 } });
    expect(s.participation).toBe(8);
  });

  it("슬라이더: 화면엔 바로, 두뇌엔 POST /settings {participation}", async () => {
    let state = initState("mid");
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const c = new LiveClient({
      meetingId: "m",
      brain: "http://brain.test",
      voiceUrl: "ws://voice.test/ws",
      dispatch: (a) => (state = reduce(state, a)),
      openStream: () => ({ close() {} }),
      audio: silentAudio,
      fetch: (async (url: string, init?: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json({});
      }) as typeof fetch,
    });
    c.participation(7, "mid");
    await new Promise((r) => setTimeout(r, 5));
    expect(state.participation).toBe(7);
    expect(sent.find((x) => x.url.endsWith("/settings"))?.body).toMatchObject({ participation: 7, intensity: "mid" });
  });
});

describe("역할 7개 켜고 끄기", () => {
  it("호스트가 바꾸면 화면엔 바로, 두뇌엔 POST /settings {roles} (7개 전부 실어 보냄)", async () => {
    let state = initState("mid");
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const c = new LiveClient({
      meetingId: "m",
      brain: "http://brain.test",
      voiceUrl: "ws://voice.test/ws",
      dispatch: (a) => (state = reduce(state, a)),
      openStream: () => ({ close() {} }),
      audio: silentAudio,
      fetch: (async (url: string, init?: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json({});
      }) as typeof fetch,
    });
    const roles = { ...allRoles(), suggest: false };
    c.roles(roles, "mid");
    await new Promise((r) => setTimeout(r, 5));
    expect(state.roles).toEqual(roles);
    expect(sent.find((x) => x.url.endsWith("/settings"))?.body).toMatchObject({ roles, intensity: "mid" });
    expect(Object.keys(roles)).toHaveLength(7);
  });

  it("회의 만들기: 다 켜져 있으면 안 실음(두뇌가 회의 종류 기본값), 하나라도 끄면 7개 다 실음", () => {
    expect(withHostMode(base, { mode: "decision", roles: allRoles() })).not.toHaveProperty("roles");
    const r = withHostMode(base, { mode: "decision", roles: { ...allRoles(), research: false } }).roles!;
    expect(r.research).toBe(false);
    expect(Object.keys(r)).toHaveLength(7);
  });
});
