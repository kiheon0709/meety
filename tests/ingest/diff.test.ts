import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScript } from "../../src/lib/ingest/diff";

describe("대본 줄 꺼내기", () => {
  it("코드 블록 안 발화만, 지문은 빼고 화자는 뗀다", () => {
    const lines = parseScript(fs.readFileSync("docs/agent/scenarios/B-presentation.md", "utf8"));
    expect(lines).toHaveLength(6);
    expect(lines[2]).toEqual({ speaker: "기헌", text: "끼어드는 강도는 다섯 단계로 조절할 수 있고요." });
    expect(lines.some((l) => l.text.includes("미티 기대"))).toBe(false);
  });
  it("코드 블록이 없으면 모든 줄", () => {
    expect(parseScript("# 제목\n첫 문장\n\n준영: 둘째 문장")).toEqual([
      { speaker: null, text: "첫 문장" },
      { speaker: "준영", text: "둘째 문장" },
    ]);
  });
});
