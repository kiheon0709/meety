// 회의 뒤 한 줄 요약 바로잡기 지시(ONE_LINE_FIX_SYSTEM)를 실제 모델로 한 번 (11/2 dryrun se_g9hyq426 재현). LIVE_LLM=1 npx tsx scripts/live-oneline-check.ts [--ok]
import "./env";
async function main() {
  const { direct } = await import("../src/lib/live/llm");
  const { ONE_LINE_FIX_SYSTEM } = await import("../src/lib/live/prompts");
  const transcript = ["시험팀장: 자, 오늘은 모집 예산 정하자.", "민지: 포스터 인쇄를 많이 하려면 예산이 좀 필요해요. 이번엔 포스터를 먼저 쫙 붙이고 시작하는 게 좋을 것 같아요.", "서준: 아 맞다, 에브리타임 먼저였지. 그럼 포스터는 조금만 뽑죠.", "시험팀장: 그래요. 예산은 포스터 인쇄 3만 원, 체험 행사 간식 5만 원으로 해요.", "민지: 좋아요. 간식은 누가 사 오죠?", "서준: 음, 일단 넘어가죠. 다음 안건 있어요?", "시험팀장: 미티야, 체험 행사 날짜가 언제였지?"].join("\n");
  // --ok: 이미 맞는 요약 (OK가 나와야 함)
  const one = process.argv.includes("--ok") ? "모집 예산을 포스터 인쇄 3만 원과 체험 행사 간식 5만 원으로 정했고, 간식 담당은 아직 정하지 못한 회의다." : "모집 예산을 포스터 인쇄 3만 원과 체험 행사 간식 5만 원으로 정했고, 간식 담당과 체험 행사 날짜는 아직 정하지 못한 회의다.";
  const qa = "- #7 시험팀장: 미티야, 체험 행사 날짜가 언제였지? → 미티: 체험 행사는 11월 14일 동아리방이에요. (근거: 10/28 회의 — 체험 행사 11월 14일 동아리방)";
  const r = await direct("verify", { system: [ONE_LINE_FIX_SYSTEM], user: `## 녹취\n${transcript}\n\n## 지금 한 줄 요약\n${one}\n\n## 미티가 기록에서 찾아 답한 것\n${qa}`, maxTokens: 300 });
  console.log(r.text, `· $${r.stat.cost.toFixed(4)} · ${r.stat.ms}ms`);
}
void main();
