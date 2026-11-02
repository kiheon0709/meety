// 발표 대본과 기획 문서의 어긋남 미리 보기. 대본 각 줄에 관련 사실과 "맞음/어긋남/관련 없음"을 표로.
//   npx tsx scripts/ingest-diff.ts docs/agent/scenarios/B-presentation.md docs/agent/scenarios/B-plan.md
import "./env";
import fs from "node:fs";
import { ingestFile, searchDocs } from "../src/lib/ingest";
import { judgeScript, parseScript } from "../src/lib/ingest/diff";

async function main() {
  const [scriptPath, ...docPaths] = process.argv.slice(2);
  if (!scriptPath || !docPaths.length) {
    console.log("사용법: npx tsx scripts/ingest-diff.ts <대본.md> <자료...>");
    return;
  }
  const docIds: string[] = [];
  for (const p of docPaths) docIds.push((await ingestFile(p)).info.id);

  const lines = parseScript(fs.readFileSync(scriptPath, "utf8"));
  const t0 = Date.now();
  const candidates = lines.map((l) => searchDocs(l.text, 3, { docIds }).map((r) => r.fact));
  const searchMs = Date.now() - t0;
  const { rows, cost_usd, ms } = await judgeScript(
    lines.map((l) => l.text),
    candidates,
  );

  const cell = (s: string) => s.replace(/\|/g, "\\|");
  console.log("| # | 대본 | 판정 | 관련 사실 (위치) | 이유 |");
  console.log("| --- | --- | --- | --- | --- |");
  rows.forEach((r, i) => {
    const fact = r.fact ? `${r.fact.text} (${r.fact.loc})` : "—";
    console.log(`| ${i + 1} | ${cell(r.text)} | ${r.verdict} | ${cell(fact)} | ${cell(r.reason)} |`);
  });
  console.log(`\n검색 ${searchMs}ms (${lines.length}문장) · 판정 ${ms}ms · $${cost_usd.toFixed(5)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
