// 정확도 표 (보고서용): npx tsx tests/ingest/accuracy-table.ts
import fs from "node:fs";
import { FactIndex, type IngestFact } from "../../src/lib/ingest/search";
import { FIXTURE, QUERIES, isAnswer } from "./queries";

const index = new FactIndex(JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as IngestFact[]);
console.log("| # | 발언 | 종류 | 정답 순위 | 1위 사실 |");
console.log("| --- | --- | --- | --- | --- |");
let hit = 0;
QUERIES.forEach((x, i) => {
  const top = index.search(x.q, 3);
  const r = top.findIndex((t) => isAnswer(x, t.fact.text)) + 1;
  if (r) hit++;
  const kind = [x.conflict ? "어긋남" : "질문", x.noisy ? "흔들림" : ""].filter(Boolean).join("·");
  console.log(`| ${i + 1} | ${x.q} | ${kind} | ${r ? `${r}위` : "**없음**"} | ${top[0]?.fact.text ?? "—"} |`);
});
console.log(`\n상위 3개 안: ${hit}/${QUERIES.length}`);
