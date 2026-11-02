// 디스코드 웹훅 페이로드 형식 확인 (보내지 않음).  npx tsx scripts/discord-dryrun.ts
import "./env";
process.env.DISCORD_DRY_RUN = "1";
import { postDiscord } from "../src/lib/notify";
import { listSpaces } from "../src/lib/service";

async function main() {
  const sp = listSpaces()[0];
  if (!sp) throw new Error("스페이스 없음");
  await postDiscord(sp.id, { title: `"10월 27일 회의" 정리했어요 — 달라진 점 3개 · 한 번 봐주세요 1개`, lines: ["• 로고 시안은 지호가 맡기로 함", "• 가격 안건은 무료로 가기로 하고 닫음", "⚠️ 타깃을 초기 창업팀으로 변경"], url: `http://localhost:3100/s/${sp.id}/sessions/se_x`, tone: "orange" });
  await postDiscord(sp.id, { title: "다음 회의 전 브리핑을 새로 썼어요", lines: ["• 주제: 회의 맥락 변화 추적 서비스", "• 타깃: 대학생 팀프로젝트 팀", "• 입력: 브라우저 녹음 + 녹취 붙여넣기"], url: `http://localhost:3100/s/${sp.id}/briefing`, tone: "green" });
  await postDiscord(sp.id, { title: "의견이 엇갈려요 — 결론이 필요해요", lines: ["타깃을 초기 창업팀으로 변경", "지호: 반대 · 아직 대학생 팀도 검증 안 됐어요"], url: `http://localhost:3100/s/${sp.id}/c/c_x`, tone: "orange" });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
