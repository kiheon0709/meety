// 연동 손잡이 (사람이 돌리는 것). 토큰은 명령줄 인자로 받지 않는다(셸 기록에 남음) — 환경변수로.
//   NOTION_API_TOKEN=ntn_… npx tsx scripts/integrations.ts notion-writer <spaceId> <결정 DB data source id> [제목 속성 이름]
//   npx tsx scripts/integrations.ts export <spaceId>
//   npx tsx scripts/integrations.ts status <spaceId>
import { listConnections } from "../src/lib/integrations/connections";
import { exportDecisions, setNotionWriter } from "../src/lib/integrations/export";

async function main() {
  const [cmd, spaceId, ...rest] = process.argv.slice(2);
  if (!spaceId) throw new Error("spaceId가 필요해요");
  if (cmd === "notion-writer") {
    const token = process.env.NOTION_API_TOKEN;
    if (!token) throw new Error("NOTION_API_TOKEN 환경변수에 노션 내부 통합 토큰을 넣어 주세요");
    setNotionWriter(spaceId, token, rest[0] ?? "", rest[1]);
    console.log("노션 쓰기 연결을 저장했어요 (토큰은 암호화).");
  } else if (cmd === "export") {
    console.log(JSON.stringify(await exportDecisions(spaceId), null, 1));
  } else if (cmd === "status") {
    console.log(JSON.stringify(listConnections(spaceId), null, 1));
  } else throw new Error("명령: notion-writer | export | status");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
