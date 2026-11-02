// 임베딩 고정본 (tests/ingest/fixtures/current-plan.e5.json): 글 → 8비트로 줄인 벡터. 시험에서 가짜 Embedder로 쓴다.
import fs from "node:fs";
import type { Embedder } from "../../src/lib/ingest/embed";

export const VEC_FIXTURE = "tests/ingest/fixtures/current-plan.e5.json";

// 벡터마다 최대 절댓값으로 나눠 -127~127. 앞 4바이트는 그 배율(Float32).
export function quantize(v: Float32Array): string {
  const scale = Math.max(...v.map(Math.abs)) || 1;
  const b = Buffer.alloc(4 + v.length);
  b.writeFloatLE(scale, 0);
  v.forEach((x, i) => b.writeInt8(Math.round((x / scale) * 127), 4 + i));
  return b.toString("base64");
}
export function dequantize(s: string): Float32Array {
  const b = Buffer.from(s, "base64");
  const scale = b.readFloatLE(0);
  const v = new Float32Array(b.length - 4);
  for (let i = 0; i < v.length; i++) v[i] = (b.readInt8(4 + i) / 127) * scale;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

// 고정본에 있는 글만 아는 가짜 Embedder. 모르는 글은 null (= 그 검색은 BM25만).
export function fixtureEmbedder(): Embedder {
  const fx = JSON.parse(fs.readFileSync(VEC_FIXTURE, "utf8")) as { model: string; facts: Record<string, string>; queries: Record<string, string> };
  return {
    model: `${fx.model}-fixture`,
    query: (t) => (fx.queries[t] ? dequantize(fx.queries[t]) : null),
    passages: async (ts) => ts.map((t) => (fx.facts[t] ? dequantize(fx.facts[t]) : new Float32Array(384))),
  };
}
