// 립싱크 2단계: 한글 중성 → VRM 입 모양 5개 (aa ih ou ee oh)
import { describe, expect, it } from "vitest";
import { mouthAt, visemeOf } from "../../src/components/meety/vowels";

describe("한글 모음 → 입 모양", () => {
  it("중성별 매핑", () => {
    expect(visemeOf("안")).toEqual({ aa: 1 });
    expect(visemeOf("녕")).toEqual({ aa: 0.6, oh: 0.4 });
    expect(visemeOf("세")).toEqual({ ee: 1 });
    expect(visemeOf("요")).toEqual({ oh: 1 });
    expect(visemeOf("우")).toEqual({ ou: 1 });
    expect(visemeOf("이")).toEqual({ ih: 1 });
    expect(visemeOf("으")).toEqual({ ih: 1 });
  });

  it("한글 아닌 글자·공백·문장부호는 입 닫힘", () => {
    expect(visemeOf(" ")).toEqual({});
    expect(visemeOf(",")).toEqual({});
    expect(visemeOf("A")).toEqual({ aa: 0.5 }); // 라틴은 모음을 모르니 반쯤 연 입
  });

  it("문장 길이에 음절을 고르게 나눠 지금 입 모양을 고른다", () => {
    // "안녕하세요" 5음절, 1초 → 0.2초씩
    expect(mouthAt("안녕하세요", 1, 0.05)).toEqual({ aa: 1 });
    expect(mouthAt("안녕하세요", 1, 0.65)).toEqual({ ee: 1 });
    expect(mouthAt("안녕하세요", 1, 0.95)).toEqual({ oh: 1 });
    expect(mouthAt("안녕하세요", 1, 1.5)).toEqual({}); // 끝난 뒤
  });
});
