import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { readDoc, splitMarkdown, splitText, zipChunks } from "../../src/lib/ingest/read";
import { hasPdftotext, makeZip } from "./helpers";

describe("markdown 나누기", () => {
  it("제목으로 절을 나누고 H1은 문서 제목이 된다", () => {
    const { title, chunks } = splitMarkdown("# 기획\n\n머리말\n\n## 끼어들기 강도\n세 단계다.\n\n### 상\n0.3초\n\n## 빈 절\n\n## 기록\n읽기만 한다.");
    expect(title).toBe("기획");
    expect(chunks.map((c) => c.loc)).toEqual(['첫머리', '"끼어들기 강도" 절', '"끼어들기 강도 > 상" 절', '"기록" 절']);
    expect(chunks[1].text).toContain("세 단계다.");
  });

  it("코드 블록 안의 #은 제목이 아니다", () => {
    const { chunks } = splitMarkdown("## 실행\n```\n# 주석\nnpm ci\n```");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("# 주석");
  });

  it("긴 절은 단락 경계에서 나누고 위치에 번호를 붙인다", () => {
    const para = "가".repeat(1500);
    const { chunks } = splitMarkdown(`## 긴 절\n${para}\n\n${para}\n\n${para}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].loc).toBe(`"긴 절" 절 (1/${chunks.length})`);
  });
});

describe("txt 나누기", () => {
  it("단락 번호로 위치를 붙인다", () => {
    expect(splitText("첫째\n\n둘째").map((c) => c.loc)).toEqual(["1~2번째 단락"]);
  });
});

describe("zip (노션 내보내기)", () => {
  it("안의 md·txt를 읽고 노션 id 꼬리를 뗀다", () => {
    const zip = makeZip([
      { name: "기획 0123456789abcdef0123456789abcdef.md", text: "# 기획\n## 강도\n세 단계다.", deflate: true },
      { name: "그림.png", text: "x" },
      { name: "메모.txt", text: "로컬 모드" },
    ]);
    const chunks = zipChunks(zip);
    expect(chunks.map((c) => c.loc)).toEqual(['기획 · "강도" 절', "메모 · 1번째 단락"]);
    expect(chunks[0].text).toContain("세 단계다.");
  });

  it("zip 안의 zip도 읽는다", () => {
    const inner = makeZip([{ name: "a.md", text: "## 절\n내용" }]);
    const outer = makeZip([{ name: "Export-Part-1.zip", text: inner, deflate: true }]);
    expect(zipChunks(outer)).toEqual([{ loc: 'a · "절" 절', text: "## 절\n내용" }]);
  });
});

// 시험용 PDF는 공개 저장소에 없어서, 파일이 있을 때만 돈다
describe.skipIf(!hasPdftotext || !fs.existsSync("docs/멘토링-사전자료-2026-10-25.pdf"))("pdf", () => {
  it("쪽마다 조각을 만든다", () => {
    const d = readDoc("docs/멘토링-사전자료-2026-10-25.pdf");
    expect(d.kind).toBe("pdf");
    expect(d.chunks.map((c) => c.loc)).toEqual(["1쪽", "2쪽", "3쪽", "4쪽", "5쪽"]);
    expect(d.chunks[0].text).toContain("갈피");
  });
});
