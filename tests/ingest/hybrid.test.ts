// BM25 + 로컬 임베딩(RRF) 검색 — 임베딩 고정본(tests/ingest/fixtures/current-plan.e5.json)으로 모델 없이 결정적으로.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { embedFacts, ingestFile, searchDocs } from "../../src/lib/ingest";
import { setEmbedder, type Embedder } from "../../src/lib/ingest/embed";
import type { Extractor } from "../../src/lib/ingest/extract";
import { readVecs } from "../../src/lib/ingest/store";
import { GAP_QUERIES } from "./gap-queries";
import { measure } from "./hybrid-measure";
import { QUERIES } from "./queries";

describe("지식 공백 발언 30개 → 사실 (상위 1·3)", () => {
  it("BM25+임베딩이 BM25 단독보다 상위 1·3 모두 낫거나 같다", async () => {
    const m = await measure(GAP_QUERIES);
    expect(GAP_QUERIES).toHaveLength(30);
    // 2026-10-30 잰 값: BM25 21·26 → 합침 23·27 (보고서 S4 단계 5)
    expect(m.bm25).toEqual([21, 26]);
    expect(m.hybrid).toEqual([23, 27]);
  });

  it("다음 회의 발언 30개(단계 3 세트)에서도 떨어지지 않는다", async () => {
    const m = await measure(QUERIES);
    expect(m.hybrid[0]).toBeGreaterThanOrEqual(m.bm25[0]);
    expect(m.hybrid[1]).toBeGreaterThanOrEqual(29);
  });

  it("얻은 것과 잃은 것 (바뀌면 이 시험이 알려 준다)", async () => {
    const { rows } = await measure(GAP_QUERIES);
    const better = rows.filter((r) => (r.hybrid || 9) < (r.bm25 || 9)).map((r) => r.q.q);
    const worse = rows.filter((r) => (r.hybrid || 9) > (r.bm25 || 9)).map((r) => r.q.q);
    expect(better).toEqual(["멘토님 학교 오시는 날이 언제였지?", "에이전트 이름 정한 게 언제였지?", "중깡도는 몇 초 쉬면 말하더라", "제일 센 강도면 언제 말하더라"]);
    // 잃은 것: "십일월"이 "대회 제출" 쪽 다른 사실에 끌림(1→2위), "사용자"가 설문 사실에 끌림(3위→밖)
    expect(worse).toEqual(["제출일이 십일월 며칠이었더라", "우리가 노리는 사용자가 누구였더라"]);
  });
});

// ── searchDocs 안에서: 색인 격리, 임베딩 채우기, 꺼졌을 때 ─────────────
const tmp = path.join(process.cwd(), "tests", ".tmp", `hybrid-${process.pid}`);
const prevDir = process.env.GALPI_INGEST_DIR;

// 글자 몇 개로 정해지는 장난감 임베딩: "마감"·"제출" 쪽과 "강도"·"단계" 쪽 두 축
let passageCalls = 0;
const toy: Embedder = {
  model: "toy",
  query: (t) => vec(t),
  passages: async (ts) => {
    passageCalls += ts.length;
    return ts.map(vec);
  },
};
function vec(t: string): Float32Array {
  const v = new Float32Array(4);
  v[0] = /마감|제출|언제|날짜/.test(t) ? 1 : 0;
  v[1] = /강도|단계|몇/.test(t) ? 1 : 0;
  v[2] = /팀/.test(t) ? 0.2 : 0;
  v[3] = 0.1;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const lines: Extractor = async ({ chunks }) => ({
  facts: chunks.flatMap((c, i) => c.text.split("\n").map((l) => l.replace(/^[-#\s]+/, "").trim()).filter(Boolean).map((l) => ({ chunk: i, kind: "number" as const, text: l, quote: l, keys: [] }))),
  usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 },
});
async function doc(name: string, body: string) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return (await ingestFile(file, { extractor: lines })).info.id;
}

describe("searchDocs — 자료 묶음마다 따로 색인", () => {
  beforeEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    process.env.GALPI_INGEST_DIR = path.join(tmp, "data");
    setEmbedder(toy);
    passageCalls = 0;
  });
  afterAll(() => {
    setEmbedder(undefined);
    process.env.GALPI_INGEST_DIR = prevDir;
  });

  it("A 팀 회의 검색에 B 팀 사실이 하나도 안 나온다 (같은 문장, 다른 값)", async () => {
    const a = await doc("a.md", "# A\n\nA팀 마감은 11월 2일이다.\n\nA팀 강도는 세 단계다.\n");
    const b = await doc("b.md", "# B\n\nB팀 마감은 11월 9일이다.\n\nB팀 강도는 다섯 단계다.\n");
    await embedFacts(a);
    await embedFacts(b);
    for (const q of ["마감이 언제였지?", "강도 몇 단계였지?", "B팀 마감 11월 9일", "팀"]) {
      const hits = searchDocs(q, 5, { docIds: [a] });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.fact.docId === a)).toBe(true);
    }
    expect(searchDocs("마감이 언제였지?", 1, { docIds: [b] })[0].fact.text).toBe("B팀 마감은 11월 9일이다.");
  });

  it("임베딩은 사실이 바뀐 것만 다시 계산하고, 생기면 다음 검색부터 합친다", async () => {
    const file = path.join(tmp, "plan.md");
    fs.writeFileSync(file, "# 기획\n\n마감은 11월 2일이다.\n\n강도는 세 단계다.\n");
    const id = (await ingestFile(file, { extractor: lines })).info.id;
    expect(searchDocs("언제였지?", 3, { docIds: [id] })).toEqual([]); // 낱말이 안 겹치고 임베딩도 아직 없음
    expect(await embedFacts(id)).toBe(2);
    expect(Object.keys(readVecs(id, "toy"))).toHaveLength(2);
    expect(searchDocs("언제였지?", 1, { docIds: [id] })[0].fact.text).toBe("마감은 11월 2일이다.");
    fs.writeFileSync(file, "# 기획\n\n마감은 11월 2일이다.\n\n강도는 상·중·하 세 단계다.\n");
    await ingestFile(file, { extractor: lines });
    passageCalls = 0;
    expect(await embedFacts(id)).toBe(1);
    expect(passageCalls).toBe(1);
  });

  it("임베딩이 꺼지거나 질문 임베딩이 늦으면 BM25 결과 그대로", async () => {
    const id = await doc("p.md", "# 기획\n\n마감은 11월 2일이다.\n\n강도는 세 단계다.\n");
    await embedFacts(id);
    setEmbedder({ ...toy, query: () => null });
    const late = searchDocs("강도 단계", 2, { docIds: [id] });
    setEmbedder(null);
    const off = searchDocs("강도 단계", 2, { docIds: [id] });
    expect(late).toEqual(off);
    expect(off[0].fact.text).toBe("강도는 세 단계다.");
    expect(searchDocs("언제였지?", 3, { docIds: [id] })).toEqual([]);
  });
});
