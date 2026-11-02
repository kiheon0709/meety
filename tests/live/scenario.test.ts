import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLongTranscript, parseScenario } from "../../src/lib/live/scenario";

describe("시나리오 대본 읽기", () => {
  it("A: 설정·대본·기대를 읽는다", () => {
    const s = parseScenario(fs.readFileSync("docs/agent/scenarios/A-meeting.md", "utf8"));
    expect(s.participants).toEqual(["기헌", "준영", "태은", "지호"]);
    expect(s.intensity).toBe("high");
    expect(s.agenda).toEqual([
      { title: "시연 영상 구성", expected: ["장면 순서 확정"] },
      { title: "디스코드 연동 범위", expected: ["이번에 만들 범위 결정"] },
      { title: "리허설", expected: ["날짜", "담당자"] },
    ]);
    expect(s.lines).toHaveLength(11);
    const ex = s.lines.flatMap((l, i) => l.expects.map((e) => `${i}:${e.type}:${e.kind ?? ""}`));
    expect(ex).toEqual(["2:change_card:", "3:speak:conflict", "4:settings:low", "4:speak:ack", "6:change_card:", "7:hand_raise:conflict", "10:checklist:"]);
    const cl = s.lines[10].expects[0];
    expect(cl.statuses).toEqual(["done", "done", "done", "no_owner"]);
    expect(cl.raised).toBe(1);
  });

  it("B: 한 줄 agenda와 docIds", () => {
    const s = parseScenario(fs.readFileSync("docs/agent/scenarios/B-presentation.md", "utf8"));
    expect(s.agenda).toEqual([{ title: "발표", expected: [] }]);
    expect(s.wantsDocs).toBe(true);
    expect(s.participants).toEqual(["기헌"]);
    const ex = s.lines.flatMap((l, i) => l.expects.map((e) => `${i}:${e.type}:${e.kind ?? ""}`));
    expect(ex).toEqual(["2:speak:conflict", "3:settings:low", "3:speak:ack", "4:hand_raise:conflict"]);
  });
});

describe("기대 줄의 덧붙임", () => {
  it("'포함:'은 대사에 있어야 할 말 (여러 개면 하나라도)", async () => {
    const { parseExpect } = await import("../../src/lib/live/scenario");
    expect(parseExpect("speak answer — 포함: 11월 2일|11/2")[0]).toMatchObject({ type: "speak", kind: "answer", mustInclude: ["11월 2일", "11/2"] });
    expect(parseExpect("speak conflict — 제출은 11/2. 자료 근거")[0]).toMatchObject({ needsDoc: true });
  });
});

// 실제 회의 전사는 공개 저장소에 없어서, 파일이 있을 때만 돈다
describe.skipIf(!fs.existsSync("docs/mentoring/2026-10-29-멘토링-전사.md"))("긴 실제 회의 전사 읽기", () => {
  it("멘토링 전사를 150자 안쪽 발화로 나눈다", () => {
    const s = parseLongTranscript(fs.readFileSync("docs/mentoring/2026-10-29-멘토링-전사.md", "utf8"));
    expect(s.lines.length).toBeGreaterThan(200);
    expect(s.participants).toEqual(expect.arrayContaining(["멘토", "홍기헌"]));
    expect(s.lines.every((l) => l.text.length <= 400 && l.speaker)).toBe(true);
    expect(s.lines.filter((l) => l.text.length > 150).length / s.lines.length).toBeLessThan(0.2);
  });
});
