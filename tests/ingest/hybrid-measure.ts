// 낱말 검색(BM25) 단독과 BM25+로컬 임베딩(RRF)의 상위 1·3 적중을 같은 사실·질문으로 잰다. 시험·표가 같이 쓴다.
import fs from "node:fs";
import { FactIndex, embedText, type IngestFact } from "../../src/lib/ingest/search";
import { FIXTURE, isAnswer, type Query } from "./queries";
import { fixtureEmbedder } from "./vec-fixture";

export const facts: IngestFact[] = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const emb = fixtureEmbedder();

let hybridIndex: Promise<FactIndex> | null = null;
export const bm25Index = new FactIndex(facts);
export function hybrid(): Promise<FactIndex> {
  hybridIndex ??= emb.passages(facts.map(embedText)).then((vs) => new FactIndex(facts, new Map(facts.map((f, i) => [f.id, vs![i]]))));
  return hybridIndex;
}

export interface Row {
  q: Query;
  bm25: number; // 정답 순위 (0 = 상위 3 밖)
  hybrid: number;
  top1: { bm25?: string; hybrid?: string };
}

export async function measure(set: Query[]): Promise<{ rows: Row[]; bm25: [number, number]; hybrid: [number, number] }> {
  const h = await hybrid();
  const rank = (x: Query, list: { fact: { text: string } }[]) => list.findIndex((r) => isAnswer(x, r.fact.text)) + 1;
  const rows = set.map((q) => {
    const b = bm25Index.search(q.q, 3);
    const y = h.search(q.q, 3, undefined, emb.query(q.q));
    return { q, bm25: rank(q, b), hybrid: rank(q, y), top1: { bm25: b[0]?.fact.text, hybrid: y[0]?.fact.text } };
  });
  const count = (k: "bm25" | "hybrid"): [number, number] => [rows.filter((r) => r[k] === 1).length, rows.filter((r) => r[k] >= 1).length];
  return { rows, bm25: count("bm25"), hybrid: count("hybrid") };
}
