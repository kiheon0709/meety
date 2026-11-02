// 다섯 상태 → 캐릭터 목표값 (판단 없음, 상수 표). 상태가 어떤 순서로 와도 목표만 바뀌고 매 프레임 따라간다
import { describe, expect, it } from "vitest";
import { EYE_R, SHINE, SHINE_R, approach, insideEye, targetOf } from "../../src/components/meety/pose";

describe("상태 → 목표값", () => {
  it("다섯 상태 모두 목표가 있고, 손은 손 들었을 때만", () => {
    for (const m of ["listening", "has_something", "hand_raised", "speaking", "cut"] as const) expect(targetOf(m, false)).toBeDefined();
    expect(targetOf("hand_raised", false).hand).toBe(1);
    expect(targetOf("listening", false).hand).toBe(0);
    expect(targetOf("has_something", false).lean).toBeGreaterThan(targetOf("listening", false).lean);
  });

  it("끊기면 움츠러들고(shrink), 손 들면 눈이 손 쪽 위를 본다(look)", () => {
    expect(targetOf("cut", false).shrink).toBe(1);
    expect(targetOf("listening", false).shrink).toBe(0);
    expect(targetOf("hand_raised", false).look).toBeGreaterThan(0);
    expect(targetOf("cut", false).look).toBeLessThan(0); // 시선을 아래로
  });

  it("듣는 중에 사람이 말하면 고개를 기울인다", () => {
    expect(targetOf("listening", true).tilt).toBeGreaterThan(targetOf("listening", false).tilt);
  });

  it("지수 따라가기: 한 프레임에 넘치지 않고, 충분히 지나면 닿는다", () => {
    expect(approach(0, 1, 1 / 60, 0.12)).toBeGreaterThan(0);
    expect(approach(0, 1, 1 / 60, 0.12)).toBeLessThan(0.2);
    expect(approach(0, 1, 2, 0.12)).toBeCloseTo(1, 3);
  });
});

import { blinkAt, jiggle } from "../../src/components/meety/pose";

describe("귀여운 움직임 (시간 함수)", () => {
  it("깜빡임은 0→1→0으로 부드럽게 (0.16초), 그 밖엔 0", () => {
    expect(blinkAt(0, 0)).toBe(0);
    expect(blinkAt(0.08, 0)).toBeCloseTo(1, 1);
    expect(blinkAt(0.04, 0)).toBeGreaterThan(0.3);
    expect(blinkAt(0.04, 0)).toBeLessThan(1);
    expect(blinkAt(0.2, 0)).toBe(0);
  });

  it("상태가 바뀌면 젤리처럼 출렁였다가 0.8초 안에 멈춘다", () => {
    expect(jiggle(0)).toBe(0);
    expect(Math.abs(jiggle(0.05))).toBeGreaterThan(0.02);
    expect(Math.abs(jiggle(0.9))).toBeLessThan(0.005);
    expect(jiggle(-1)).toBe(0);
  });
});

describe("팔·눈 표정 (기헌 아이디어: 평소엔 팔이 숨어 있다가 필요할 때 나옴)", () => {
  it("평소엔 팔이 안 보이고, 손 들었음엔 한쪽 팔이 쑥 나와 올라간다", () => {
    expect(targetOf("listening", false)).toMatchObject({ peek: 0, hand: 0 });
    expect(targetOf("hand_raised", false)).toMatchObject({ peek: 1, hand: 1 });
  });
  it("팔은 손 들기·끊김에서만 나온다 (반쯤 나온 팔은 몸 가장자리 혹으로 보임 — 기헌 1:1 시험). 할 말 있음 = 궁금한 눈, 말하는 중 = 기쁜 눈, 끊김 = 팔로 가리듯 움츠림 + 미안한 눈", () => {
    const has = targetOf("has_something", false);
    expect(has.peek).toBe(0);
    expect(has.curious).toBe(1);
    const sp = targetOf("speaking", false);
    expect(sp.peek).toBe(0);
    expect(sp.joy).toBeGreaterThan(0);
    expect(targetOf("listening", true).peek).toBe(0);
    expect(targetOf("hand_raised", false).hand).toBe(1);
    expect(targetOf("cut", false)).toMatchObject({ shy: 1, sorry: 1 });
  });
});

describe("눈 반짝임은 눈 안에", () => {
  it("눈이 크게 움직여도 반짝임(반지름 포함)이 눈 타원 밖으로 안 나간다", () => {
    for (const [dx, dy] of [[0, 0], [0.1, 0.1], [-0.1, -0.1], [0.08, -0.06], [-0.2, 0.2]]) {
      const [x, y] = insideEye(SHINE.x - dx * 0.6, SHINE.y - dy * 0.6);
      // 반짝임 둘레의 점이 모두 눈 타원 안
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 18) expect(Math.hypot((x + SHINE_R * Math.cos(a)) / EYE_R.x, (y + SHINE_R * Math.sin(a)) / EYE_R.y)).toBeLessThanOrEqual(1);
    }
    expect(insideEye(SHINE.x, SHINE.y)).toEqual([SHINE.x, SHINE.y]); // 평소 자리는 그대로
  });
});

describe("생각 중 (draft thinking)", () => {
  it("듣는 중일 때만 아주 작게: 눈이 옆·위로, 손·팔·멈춤은 없음", () => {
    const t = targetOf("listening", false, true);
    expect(t.think).toBe(1);
    expect(t.look).toBeGreaterThan(0);
    expect(t).toMatchObject({ hand: 0, peek: 0, still: 0 });
    expect(targetOf("speaking", false, true).think).toBe(0); // 다른 상태가 이기면 안 함
  });
});
