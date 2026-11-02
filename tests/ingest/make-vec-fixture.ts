// 시험용 임베딩 고정본 만들기 (모델이 바뀌거나 사실·질문을 고쳤을 때만): npx tsx tests/ingest/make-vec-fixture.ts
// 실제 워커(src/lib/ingest/embed.ts)로 사실·질문을 임베딩해 8비트로 줄여 저장한다 → 시험은 모델 없이 결정적으로 돈다.
import fs from "node:fs";
import { embedder, EMBED_MODEL } from "../../src/lib/ingest/embed";
import { embedText, type IngestFact } from "../../src/lib/ingest/search";
import { GAP_QUERIES } from "./gap-queries";
import { FIXTURE, QUERIES } from "./queries";
import { VEC_FIXTURE, quantize } from "./vec-fixture";

(async () => {
  const emb = embedder();
  if (!emb) throw new Error("임베딩이 꺼져 있어요");
  const facts: IngestFact[] = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const pv = (await emb.passages(facts.map(embedText)))!;
  const out = { model: EMBED_MODEL, facts: {} as Record<string, string>, queries: {} as Record<string, string> };
  facts.forEach((f, i) => (out.facts[embedText(f)] = quantize(pv[i])));
  for (const q of [...QUERIES, ...GAP_QUERIES].map((x) => x.q)) {
    let v = emb.query(q);
    for (let i = 0; !v && i < 20; i++) v = emb.query(q); // 첫 몇 번은 늦을 수 있다
    if (!v) throw new Error(`질문 임베딩 실패: ${q}`);
    out.queries[q] = quantize(v);
  }
  fs.writeFileSync(VEC_FIXTURE, JSON.stringify(out));
  console.log(`사실 ${Object.keys(out.facts).length}개 · 질문 ${Object.keys(out.queries).length}개 → ${VEC_FIXTURE}`);
  process.exit(0);
})();
