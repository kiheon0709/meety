// 콘티 질문 검증표 (보고서용, 모델 호출 없음): 시연 자료 세트를 먼저 읽어 둔 뒤(RUNBOOK 11절)
//   npx tsx tests/ingest/demo-table.ts [--without storyboard,멘토링]   (경로에 그 글자가 든 자료를 빼고)
// 읽어 둔 data/ingest/에서 DEMO_DOCS의 docId를 찾아 searchDocs(질문, 3, { docIds })를 돌린다. 임베딩이 있으면 BM25+임베딩, 없으면 BM25만.
import { embedFacts, listDocs, searchDocs } from "../../src/lib/ingest";
import { embedder } from "../../src/lib/ingest/embed";
import { DEMO_DOCS, DEMO_QUERIES } from "./demo-queries";

(async () => {
  const wi = process.argv.indexOf("--without");
  const without = wi > 0 ? process.argv[wi + 1].split(",") : [];
  const want = DEMO_DOCS.filter((p) => !without.some((w) => p.includes(w)));
  const docs = listDocs().filter((d) => want.includes(d.path));
  if (docs.length !== want.length) throw new Error(`자료 세트를 먼저 읽어 주세요 (찾은 것 ${docs.length}/${want.length})`);
  const docIds = docs.map((d) => d.id);
  // 워커 데우기 + 빠진 임베딩 채우기
  for (const id of docIds) await embedFacts(id);
  const emb = embedder();
  if (emb) for (let i = 0; i < 40 && !emb.query("데우기"); i++) await new Promise((r) => setTimeout(r, 50));
  const mode = emb?.query("데우기") ? "BM25+임베딩" : "BM25만";

  searchDocs("데우기", 3, { docIds }); // 색인 만들기는 재지 않는다
  const rows = [];
  const ms: number[] = [];
  for (const x of DEMO_QUERIES) {
    let hits = searchDocs(x.q, 3, { docIds });
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      hits = searchDocs(i ? `${x.q} ${i}` : x.q, 3, { docIds });
      ms.push(performance.now() - t);
    }
    hits = searchDocs(x.q, 3, { docIds });
    const rank = hits.findIndex((h) => new RegExp(x.expect).test(h.fact.text)) + 1;
    rows.push({ x, rank, top: hits[0]?.fact });
  }
  console.log(`자료 ${docs.length}개 · 사실 ${docs.reduce((a, d) => a + d.facts, 0)}개 · ${mode}\n`);
  console.log("| 회의 | 장면 | 질문 | 정답 | 1위 사실 (문서) |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const { x, rank, top } of rows) {
    const doc = top ? top.docId.replace(/-[0-9a-f]{6}$/, "") : "—";
    console.log(`| ${x.meeting} | ${x.scene ?? ""} | ${x.q} | ${rank ? `${rank}위` : "**없음**"} | ${top?.text ?? "—"} (${doc}) |`);
  }
  ms.sort((a, b) => a - b);
  const top1 = rows.filter((r) => r.rank === 1).length;
  const top3 = rows.filter((r) => r.rank > 0).length;
  console.log(`\n상위 1: ${top1}/${rows.length} · 상위 3: ${top3}/${rows.length} · 검색 ${ms.length}번 p50 ${ms[Math.floor(ms.length / 2)].toFixed(1)}ms · p95 ${ms[Math.floor(ms.length * 0.95)].toFixed(1)}ms · 최대 ${ms[ms.length - 1].toFixed(1)}ms`);
  process.exit(0);
})();
