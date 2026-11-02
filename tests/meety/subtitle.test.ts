// 자막: 한 줄 16자(라틴·공백·문장부호 0.5자), 최대 2줄, 어절 경계, 2줄이면 아래가 긴 피라미드
import { describe, expect, it } from "vitest";
import { pagesOf, widthOf } from "../../src/components/meety/subtitle";

describe("자막 줄나눔", () => {
  it("폭: 한글 1, 라틴·숫자·공백·문장부호 0.5", () => {
    expect(widthOf("미티")).toBe(2);
    expect(widthOf("AI 팀원.")).toBe(1 + 0.5 + 2 + 0.5);
  });

  it("16자 안이면 한 줄 그대로", () => {
    expect(pagesOf("잠깐만요, 확인할게요.")).toEqual([["잠깐만요, 확인할게요."]]);
  });

  it("넘치면 어절 경계로 두 줄, 아래가 같거나 길게", () => {
    const [p] = pagesOf("10월 10일 회의에서 입구는 웹 중심으로 정했어요.");
    expect(p.length).toBe(2);
    for (const l of p) expect(widthOf(l)).toBeLessThanOrEqual(16);
    expect(widthOf(p[1])).toBeGreaterThanOrEqual(widthOf(p[0]));
    expect(p.join(" ")).toBe("10월 10일 회의에서 입구는 웹 중심으로 정했어요.");
  });

  it("두 줄로도 넘치면 여러 장으로 (글자는 하나도 안 잃음)", () => {
    const s = "잠깐만요, 10월 10일 회의에서 입구는 웹 중심으로 하고 디스코드 봇은 2단계로 미루기로 정했어요.";
    const pages = pagesOf(s);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p.length).toBeLessThanOrEqual(2);
      for (const l of p) expect(widthOf(l)).toBeLessThanOrEqual(16);
    }
    expect(pages.flat().join(" ")).toBe(s);
  });

  it("띄어쓰기 없는 긴 낱말은 16자에서 자른다", () => {
    const pages = pagesOf("가나다라마바사아자차카타파하가나다라마바");
    expect(pages.flat().every((l) => widthOf(l) <= 16)).toBe(true);
    expect(pages.flat().join("")).toBe("가나다라마바사아자차카타파하가나다라마바");
  });
});
