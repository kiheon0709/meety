// 자료를 읽어 사실을 뽑고 개수·예시를 출력한다.
//   npx tsx scripts/ingest.ts <경로...>                 → 읽기 (같은 파일은 캐시)
//   npx tsx scripts/ingest.ts <경로...> --force         → 캐시 무시하고 다시 뽑기
//   npx tsx scripts/ingest.ts --search "문장" [-k 5]    → 읽어 둔 자료에서 찾기 (경로와 같이 써도 된다)
//   npx tsx scripts/ingest.ts --embed                  → 로컬 임베딩 모델을 받아 두고 읽어 둔 자료의 사실 임베딩을 채움 (회의 전에 한 번)
//   GALPI_EXTRACT_MODEL=claude-sonnet-5-5 npx tsx scripts/ingest.ts ...   → 모델 바꿔 비교
import "./env";
import { embedFacts, ingestFile, listDocs, searchDocs } from "../src/lib/ingest";
import { embedder } from "../src/lib/ingest/embed";

const args = process.argv.slice(2);
const force = args.includes("--force");
const all = args.includes("--all");
const embed = args.includes("--embed");
const qi = args.indexOf("--search");
const query = qi >= 0 ? args[qi + 1] : null;
const ki = args.indexOf("-k");
const k = ki >= 0 ? Number(args[ki + 1]) : 5;
const skip = new Set([qi + 1, ki + 1].filter((i) => i > 0));
const paths = args.filter((a, i) => !a.startsWith("-") && !skip.has(i));

async function main() {
  if (!paths.length && !query && !embed) {
    console.log("사용법: npx tsx scripts/ingest.ts <경로...> [--force] [--all] [--search \"문장\" -k 5]");
    console.log("\n읽어 둔 자료:");
    for (const d of listDocs()) console.log(`  ${d.id}  ${d.path}  (사실 ${d.facts}개)`);
    return;
  }
  let total = 0;
  for (const p of paths) {
    const r = await ingestFile(p, { force });
    const byKind: Record<string, number> = {};
    for (const f of r.facts) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    console.log(`\n■ ${r.info.title}`);
    console.log(`  id ${r.info.id} · ${r.info.path} · 조각 ${r.chunks}개 · 사실 ${r.facts.length}개 ${JSON.stringify(byKind)}`);
    if (r.cached) console.log("  (캐시에서 읽음 — 모델 호출 없음)");
    else if (r.usage) {
      total += r.usage.cost_usd;
      console.log(`  ${r.usage.model} · 호출 ${r.usage.calls}번 · ${r.usage.ms}ms · 입력 ${r.usage.input_tokens} / 출력 ${r.usage.output_tokens} 토큰 · $${r.usage.cost_usd.toFixed(5)}`);
    }
    if (r.quoteFixed || r.dropped || r.retried) console.log(`  원문 인용 고침 ${r.quoteFixed}개 · 버림 ${r.dropped}개 · 빠진 조각 다시 물음 ${r.retried}개`);
    for (const f of all ? r.facts : r.facts.slice(0, 5)) {
      console.log(`  - [${f.kind}] ${f.text}`);
      console.log(`      ${f.loc} · "${f.quote}"`);
    }
    if (!all && r.facts.length > 5) console.log(`  … 외 ${r.facts.length - 5}개 (--all로 전부)`);
  }
  if (total) console.log(`\n이번 실행 비용 $${total.toFixed(5)}`);
  if (embed) {
    if (!embedder()) console.log("\n로컬 임베딩이 꺼져 있어요 (GALPI_EMBED=0이거나 시험 중)");
    for (const d of listDocs()) {
      const t = Date.now();
      const n = await embedFacts(d.id);
      console.log(`  임베딩 ${d.id}: 새로 ${n}개 (${Date.now() - t}ms)`);
    }
  }
  if (query) {
    console.log(`\n🔎 "${query}"`);
    for (const { fact, score } of searchDocs(query, k)) console.log(`  ${score.toFixed(3)}  [${fact.kind}] ${fact.text}  (${fact.docId} · ${fact.loc})`);
  }
}

// 임베딩 워커가 프로세스를 붙잡고 있을 수 있어 끝나면 직접 나간다
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
