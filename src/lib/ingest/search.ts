// 벡터 DB 없는 검색: 글자 2-gram + 조사 뗀 낱말 BM25.
// 띄어쓰기를 지우고 2글자씩 자르므로 "강도는/강도를", "세 단계/세단계" 같은 차이를 견딘다.
// 사실 임베딩과 질문 임베딩이 있으면 BM25 순위와 코사인 순위를 RRF로 합친다 (knowledge-design §2-2).
import type { DocFact } from "@/lib/live/contract";

// 계약의 DocFact에 검색용 다른 표현(keys)을 덧붙인 것. 두뇌에는 그대로 DocFact로 보인다.
export type IngestFact = DocFact & { keys?: string[] };

export function bigrams(s: string): string[] {
  const t = s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (t.length < 2) return t ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

// 흔한 표기 차이와 받아쓰기 흔들림. 검색할 때 사실·질문 양쪽에 똑같이 적용한다.
const ALIASES: [RegExp, string][] = [
  [/타겟/g, "타깃"],
  [/미띠|밋티/g, "미티"],
  [/써버/g, "서버"],
];
function normalize(s: string): string {
  let t = s.normalize("NFC").toLowerCase();
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  return t;
}

// 낱말 끝 조사를 뗀 낱말. 2-gram이 놓치는 한 글자 낱말("하로" → "하", "상은" → "상")을 잡는다.
const JOSA = /(으로|에서|이랑|까지|부터|이나|은|는|이|가|을|를|로|에|의|도|만|과|와|랑|요)$/;
const VERB = /^(하는|하고|하면|해요|한다|하다|하자)$/; // "하는" → "하"(강도 하)로 잘못 떼지 않게
function words(s: string): string[] {
  return s
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => (w.length > 1 && !VERB.test(w) ? w.replace(JOSA, "") || w : w))
    .filter(Boolean)
    .map((w) => `w:${w}`);
}

export function terms(s: string): string[] {
  const t = normalize(s);
  return [...bigrams(t), ...words(t)];
}

// 임베딩할 글: 정리한 문장 + 다른 표현 (원문 인용은 길고 말투가 섞여서 뺀다)
export function embedText(f: IngestFact): string {
  return `${f.text} ${(f.keys ?? []).join(" ")}`.trim();
}

// 사실 하나를 찾을 때 보는 글: 정리한 문장 + 원문 + 위치(절 제목) + 다른 표현
function factText(f: IngestFact): string {
  return `${f.text} ${f.quote} ${f.loc.replace(/절|쪽|번째 단락/g, "")} ${(f.keys ?? []).join(" ")}`;
}

// 짧은 쪽 2-gram의 70% 이상이 긴 쪽에 있으면 같은 내용으로 본다. 날짜("10/28에")는 빼고 비교.
export function nearDuplicate(a: string, b: string): boolean {
  const strip = (s: string) => new Set(bigrams(s.replace(/^\d{1,2}\/\d{1,2}에\s*/, "")));
  const A = strip(a);
  const B = strip(b);
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  if (!small.size) return false;
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size >= 0.7;
}

const K1 = 1.2;
const B = 0.75;
// RRF: score = Σ 1/(RRF_K + 순위). 60은 원 논문 기본값. 두 쪽 모두 상위 RRF_DEPTH개만 본다.
const RRF_K = 60;
const RRF_DEPTH = 20;

export class FactIndex {
  private docs: { fact: IngestFact; tf: Map<string, number>; len: number; vec?: Float32Array }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  // vecs: 사실 id → 임베딩 (정규화된 것). 없는 사실은 BM25 쪽에서만 순위를 얻는다.
  constructor(facts: IngestFact[], vecs?: Map<string, Float32Array>) {
    for (const fact of facts) {
      const tf = new Map<string, number>();
      const grams = terms(factText(fact));
      for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
      for (const g of tf.keys()) this.df.set(g, (this.df.get(g) ?? 0) + 1);
      this.docs.push({ fact, tf, len: grams.length, vec: vecs?.get(fact.id) });
    }
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / (this.docs.length || 1);
  }

  get size(): number {
    return this.docs.length;
  }
  get vectors(): number {
    return this.docs.filter((d) => d.vec).length;
  }

  private bm25(query: string, only: Set<string> | null): { fact: IngestFact; score: number }[] {
    const q = [...new Set(terms(query))];
    if (!q.length) return [];
    const N = this.docs.length;
    const scored: { fact: IngestFact; score: number }[] = [];
    for (const d of this.docs) {
      if (only && !only.has(d.fact.docId)) continue;
      let score = 0;
      for (const g of q) {
        const tf = d.tf.get(g);
        if (!tf) continue;
        const df = this.df.get(g) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / (this.avgLen || 1)));
      }
      if (score > 0) scored.push({ fact: d.fact, score: Math.round(score * 1000) / 1000 });
    }
    return scored.sort((a, b) => b.score - a.score);
  }

  // qvec: 질문 임베딩. 있으면 BM25 상위 20과 코사인 상위 20을 RRF로 합친다. 없으면 BM25만 (점수도 BM25).
  search(query: string, k = 5, docIds?: string[], qvec?: Float32Array | null): { fact: DocFact; score: number }[] {
    const only = docIds?.length ? new Set(docIds) : null;
    let ranked = this.bm25(query, only);
    if (qvec && this.docs.some((d) => d.vec)) {
      const dense = this.docs
        .filter((d) => d.vec && (!only || only.has(d.fact.docId)))
        .map((d) => ({ fact: d.fact, s: dot(qvec, d.vec!) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, RRF_DEPTH);
      const fused = new Map<IngestFact, number>();
      ranked.slice(0, RRF_DEPTH).forEach((r, i) => fused.set(r.fact, 1 / (RRF_K + i + 1)));
      dense.forEach((r, i) => fused.set(r.fact, (fused.get(r.fact) ?? 0) + 1 / (RRF_K + i + 1)));
      ranked = [...fused].map(([fact, s]) => ({ fact, score: Math.round(s * 1e5) / 1e5 })).sort((a, b) => b.score - a.score);
    }
    // 같은 내용이 문서 두 곳(본문·결정 로그)에서 뽑힌 건 점수 높은 하나만 낸다
    const out: { fact: IngestFact; score: number }[] = [];
    for (const r of ranked) {
      if (out.length >= k) break;
      if (!out.some((o) => nearDuplicate(o.fact.text, r.fact.text))) out.push(r);
    }
    return out;
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
