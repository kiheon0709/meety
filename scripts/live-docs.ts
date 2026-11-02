// 자료를 읽고(캐시면 비용 0) 그 스페이스에 묶는다. 회의는 묶인 자료만 쓸 수 있다.
//   npx tsx scripts/live-docs.ts <spaceId|--demo> <파일...> [--replace]
//   --replace: 준 파일 말고 그 스페이스에 묶여 있던 자료는 푼다 (npm run meeting이 씀)
//   GALPI_DB_PATH=data/meeting-20261101.db npx tsx scripts/live-docs.ts --demo docs/agent/scenarios/B-plan.md docs/plan/current-plan.md
import "./env";
import Database from "better-sqlite3";
import { ingestPath } from "../src/lib/ingest";
import { bindDoc, docsForSpace, keepOnlyDocs } from "../src/lib/live/docs";

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes("--replace");
  const [who, ...files] = args.filter((a) => a !== "--replace");
  if (!who || !files.length) throw new Error("사용법: npx tsx scripts/live-docs.ts <spaceId|--demo> <파일...> [--replace]");
  // 묶으면 DB(docs·근거 조각)에도 쓴다 → 원본 data/ctxgit.db에 쓰지 않게 복사본 경로를 꼭 받는다 (npm run meeting은 알아서 넘김)
  if (!process.env.GALPI_DB_PATH) throw new Error("GALPI_DB_PATH=<복사본 DB>를 같이 주세요 (원본 data/ctxgit.db에 쓰지 않게)");
  let spaceId = who;
  if (who === "--demo") {
    // 서버가 같은 DB를 쓰고 있을 수 있어 읽기 전용으로만 연다
    const db = new Database(process.env.GALPI_DB_PATH, { readonly: true, fileMustExist: true });
    spaceId = (db.prepare(`SELECT id FROM spaces WHERE is_demo = 1 AND name LIKE '%5조%' ORDER BY created_at LIMIT 1`).get() as { id: string } | undefined)?.id ?? "";
    db.close();
    if (!spaceId) throw new Error("예시 스페이스가 없어요. npm run seed 먼저");
  }
  const bound: string[] = [];
  for (const f of files) {
    const info = await ingestPath(f);
    bindDoc(spaceId, info.id);
    bound.push(info.id);
    console.log(`${info.id}  ${info.title}  (사실 ${info.facts}개) → ${spaceId}`);
  }
  if (replace) for (const id of keepOnlyDocs(spaceId, bound)) console.log(`${id}  묶음 풂 (이번 자료 목록에 없음) ✕ ${spaceId}`);
  console.log(`이 스페이스 자료: ${docsForSpace(spaceId).map((d) => d.id).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
