import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DocFact, DocInfo } from "../../src/lib/live/contract";
import { getFacts, ingestFile, ingestPath, listDocs, searchDocs } from "../../src/lib/ingest";
import { verbatimQuote, type Extractor } from "../../src/lib/ingest/extract";

const tmp = path.join(process.cwd(), "tests", ".tmp", `ingest-${process.pid}`);
process.env.GALPI_INGEST_DIR = path.join(tmp, "data");

// 모델 대신: 조각의 줄마다 사실 하나 (quote는 줄 그대로)
let calls = 0;
const lineExtractor: Extractor = async ({ chunks }) => {
  calls++;
  const facts = chunks.flatMap((c, i) =>
    c.text
      .split("\n")
      .map((l) => l.replace(/^[-#\s]+/, "").trim())
      .filter(Boolean)
      .map((l) => ({ chunk: i, kind: "claim" as const, text: l, quote: l, keys: [] })),
  );
  return { facts, usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 } };
};

const PLAN = "docs/agent/scenarios/B-plan.md";

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  calls = 0;
});

describe("계약 시그니처", () => {
  it("contract.ts에 적힌 모양과 맞다", () => {
    const l: () => DocInfo[] = listDocs;
    const g: (docId: string) => DocFact[] = getFacts;
    const s: (query: string, k?: number) => { fact: DocFact; score: number }[] = searchDocs;
    const i: (path: string) => Promise<DocInfo> = ingestPath;
    expect([l, g, s, i].every((f) => typeof f === "function")).toBe(true);
  });
});

describe("읽기·저장", () => {
  it("읽은 문서가 목록과 사실에 나온다", async () => {
    const r = await ingestFile(PLAN, { extractor: lineExtractor });
    expect(r.info.path).toBe(PLAN);
    expect(r.info.id).toMatch(/^B-plan-[0-9a-f]{6}$/);
    expect(listDocs()).toEqual([r.info]);
    const facts = getFacts(r.info.id);
    expect(facts).toHaveLength(r.info.facts);
    const three = facts.find((f) => f.quote === "세 단계다.");
    expect(three).toMatchObject({ docId: r.info.id, loc: '"끼어들기 강도" 절' });
    expect(three?.id).toMatch(new RegExp(`^${r.info.id}#\\d+$`));
  });

  it("같은 파일은 다시 뽑지 않고, 내용이 바뀌면 다시 뽑는다", async () => {
    const f = path.join(tmp, "plan.md");
    fs.writeFileSync(f, "## 강도\n세 단계다.");
    await ingestFile(f, { extractor: lineExtractor });
    const again = await ingestFile(f, { extractor: lineExtractor });
    expect(again.cached).toBe(true);
    expect(calls).toBe(1);
    fs.writeFileSync(f, "## 강도\n다섯 단계다.");
    const changed = await ingestFile(f, { extractor: lineExtractor });
    expect(changed.cached).toBe(false);
    expect(calls).toBe(2);
    expect(listDocs()).toHaveLength(1);
    expect(getFacts(changed.info.id).map((x) => x.quote)).toContain("다섯 단계다.");
  });

  it("모르는 형식은 거절한다", async () => {
    const f = path.join(tmp, "a.docx");
    fs.writeFileSync(f, "x");
    await expect(ingestFile(f, { extractor: lineExtractor })).rejects.toThrow(/형식/);
  });

  it("원문에 없는 quote는 가까운 줄로 바꾸고, 없으면 버린다", async () => {
    const bad: Extractor = async () => ({
      facts: [
        { chunk: 0, kind: "number", text: "강도는 세 단계다", quote: "강도는 세 단계", keys: [] },
        { chunk: 0, kind: "claim", text: "지어낸 말", quote: "전혀 없는 문장입니다", keys: [] },
      ],
      usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 },
    });
    const f = path.join(tmp, "q.md");
    fs.writeFileSync(f, "## 끼어들기 강도\n강도는   세 단계다.");
    const r = await ingestFile(f, { extractor: bad });
    expect(r.facts.map((x) => x.quote)).toEqual(["강도는 세 단계"]);
    expect(r.dropped).toBe(1);
  });

  it("한 묶음의 모델 출력이 형식에 안 맞아 던지면 그 묶음만 한 번 더 묻는다", async () => {
    let calls = 0;
    const flaky: Extractor = async ({ chunks }) => {
      if (++calls === 1) throw new Error("Failed to parse structured output");
      return { facts: chunks.map((c, i) => ({ chunk: i, kind: "number" as const, text: "강도는 세 단계다", quote: "강도는 세 단계다.", keys: [] })), usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 } };
    };
    const f = path.join(tmp, "flaky.md");
    fs.writeFileSync(f, "## 끼어들기 강도\n강도는 세 단계다.");
    const r = await ingestFile(f, { extractor: flaky });
    expect(calls).toBe(2);
    expect(r.facts.map((x) => x.text)).toEqual(["강도는 세 단계다"]);
  });
});

describe("원문 인용 확인", () => {
  it("공백 차이는 같은 것으로 본다", () => {
    expect(verbatimQuote("세  단계다.", "## 강도\n세 단계다.")).toEqual({ quote: "세 단계다.", fixed: false });
  });
  it("살짝 다르면 원문 줄로 바꾼다", () => {
    expect(verbatimQuote("로컬 모드에서는 음성이 나가지 않는다", "- 로컬 모드에선 음성과 회의 내용이 기기 밖으로 나가지 않는다.")).toEqual({
      quote: "로컬 모드에선 음성과 회의 내용이 기기 밖으로 나가지 않는다.",
      fixed: true,
    });
  });
  it("관계없으면 null", () => {
    expect(verbatimQuote("완전히 다른 이야기", "세 단계다.")).toBeNull();
  });
});

describe("검색", () => {
  it("줄 단위 사실만으로도 '다섯 단계' 발화에 '세 단계'가 상위 3개에 든다", async () => {
    const r = await ingestFile(PLAN, { extractor: lineExtractor });
    const top = searchDocs("끼어드는 강도는 다섯 단계로 조절할 수 있고요", 3);
    expect(top.map((t) => t.fact.quote)).toContain("세 단계다.");
    expect(top.every((t) => t.fact.docId === r.info.id)).toBe(true);
  });

  it("docIds로 회의에 고른 자료만 본다", async () => {
    const f = path.join(tmp, "other.md");
    fs.writeFileSync(f, "## 끼어들기 강도\n끼어들기 강도는 다섯 단계로 조절한다.");
    const plan = await ingestFile(PLAN, { extractor: lineExtractor });
    const other = await ingestFile(f, { extractor: lineExtractor });
    const q = "끼어드는 강도는 다섯 단계로 조절할 수 있고요";
    expect(searchDocs(q, 1)[0].fact.docId).toBe(other.info.id);
    expect(searchDocs(q, 5, { docIds: [plan.info.id] }).every((t) => t.fact.docId === plan.info.id)).toBe(true);
  });

  it("관계없는 말에는 아무것도 안 나온다", async () => {
    await ingestFile(PLAN, { extractor: lineExtractor });
    expect(searchDocs("ㅋㅋ", 3)).toEqual([]);
  });
});
