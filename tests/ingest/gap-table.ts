// 지식 공백 발언 표 (보고서용): npx tsx tests/ingest/gap-table.ts [--all]
// 같은 사실 61개(current-plan 고정본)·같은 질문으로 BM25 단독과 BM25+임베딩(RRF)의 정답 순위를 나란히.
import { GAP_QUERIES } from "./gap-queries";
import { measure } from "./hybrid-measure";
import { QUERIES } from "./queries";

const all = process.argv.includes("--all");
(async () => {
  for (const [name, set] of [["지식 공백 발언 30", GAP_QUERIES], ["다음 회의 발언 30 (단계 3)", QUERIES]] as const) {
    const m = await measure(set);
    console.log(`\n### ${name}\n`);
    console.log("| # | 발언 | 종류 | BM25 | BM25+임베딩 | 합친 쪽 1위 사실 |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    m.rows.forEach((r, i) => {
      if (!all && r.bm25 === 1 && r.hybrid === 1) return;
      const x = r.q as (typeof GAP_QUERIES)[number];
      const kind = [x.conflict ? "어긋남" : "", x.noisy ? "흔들림" : "", x.para ? "바꿔 말함" : ""].filter(Boolean).join("·") || "그대로";
      const show = (n: number) => (n ? `${n}위` : "**없음**");
      console.log(`| ${i + 1} | ${r.q.q} | ${kind} | ${show(r.bm25)} | ${show(r.hybrid)} | ${r.top1.hybrid ?? "—"} |`);
    });
    console.log(`\n상위 1: BM25 ${m.bm25[0]}/30 → 합침 ${m.hybrid[0]}/30 · 상위 3: ${m.bm25[1]}/30 → ${m.hybrid[1]}/30`);
  }
})();
