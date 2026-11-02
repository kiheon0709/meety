// 대답 첫 글자 시간 재기 (10/31 피클 구조 — 말 끝→첫 반응 0.5초 목표): 모델 × 프롬프트 꼴마다 첫 토큰 p50·p90.
//   LIVE_LLM=1 npx tsx scripts/live-latency.ts [--n 8]
// 꼴: full-miss(대답 프롬프트 그대로, 캐시 없음) · full-hit(같은 고정 층 되풀이 → 캐시 적중) · short-hit(첫 문장용 짧은 지시 + 고정 층 캐시) · tiny(고정 층 없이 메모+최근 몇 마디+질문)
// DB는 data/ctxgit.db를 tests/.tmp/latency.db로 복사해서 쓴다(원본엔 안 씀).
import "./env";
import fs from "node:fs";
import path from "node:path";

if (process.env.LIVE_LLM !== "1") {
  console.error("모델을 부르는 측정이라 LIVE_LLM=1일 때만 돌아요.");
  process.exit(1);
}
const ROOT = process.cwd();
const db = path.join(ROOT, "tests", ".tmp", "latency.db");
fs.mkdirSync(path.dirname(db), { recursive: true });
for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
fs.copyFileSync(path.join(ROOT, "data", "ctxgit.db"), db);
process.env.GALPI_DB_PATH = db;

const args = process.argv.slice(2);
const N = Number(args[args.indexOf("--n") + 1] || 8) || 8;

async function main() {
  const { getDb } = await import("../src/lib/db");
  const { buildContext } = await import("../src/lib/live/context");
  const { docsForSpace } = await import("../src/lib/live/docs");
  const { direct } = await import("../src/lib/live/llm");
  const { ANSWER_SYSTEM } = await import("../src/lib/live/prompts");
  const { pct } = await import("./live-lib");

  const space = getDb().prepare(`SELECT id FROM spaces WHERE is_demo = 1 AND name LIKE '%5조%' ORDER BY created_at LIMIT 1`).get() as { id: string };
  const docIds = docsForSpace(space.id).filter((d) => d.id.startsWith("current-plan")).map((d) => d.id);
  const ctx = buildContext({ spaceId: space.id, title: "1:1 기획", agenda: [], participants: ["기헌"], docIds });
  const recent = ["기헌: 오늘은 발표 준비 얘기 좀 하자.", "기헌: 슬라이드는 내가 만들고 있는데, 뭐부터 해야 할지 모르겠네.", "미티: 기록상 슬라이드 초안은 태은 님 할 일이에요.", "기헌: 아 그렇지. 그럼 시연 영상은 누가 찍지."];
  const memo = "## 미티 메모\n주제: 발표 준비\n정한 것: -\n빈 것: 시연 영상 담당\n할 일: 11/2 제출";
  const question = "기헌: 미티야, 시연 영상은 누가 찍기로 했었지?";
  const FIRST = `너는 회의 AI 팀원 "미티"다. 팀원 물음에 첫 문장 하나만 말로 답한다. 구어체 해요체 40자 안쪽, 결론 먼저. 기록에 없으면 "기록엔 없는데"로 시작해 생각을 짧게. 지어내지 마라.`;
  const HAIKU = { provider: "anthropic" as const, model: "claude-haiku-5-5", thinkingOff: "disabled" as const, effort: "low" as const };
  const SONNET = { provider: "anthropic" as const, model: "claude-sonnet-5-5", thinkingOff: "between_tools" as const, effort: "low" as const };
  const shapes = {
    "full-miss": (i: number) => ({ system: [`(측정 ${Date.now()}-${i})\n${ANSWER_SYSTEM}`, ctx.text], user: `${recent.join("\n")}\n\n${memo}\n\n## 질문\n${question}` }),
    "full-hit": () => ({ system: [ANSWER_SYSTEM, ctx.text], user: `${recent.join("\n")}\n\n${memo}\n\n## 질문\n${question}` }),
    "short-hit": () => ({ system: [FIRST, ctx.text], user: `${memo}\n\n${recent.slice(-3).join("\n")}\n\n${question}` }),
    tiny: () => ({ system: [FIRST], user: `${memo}\n\n${recent.slice(-3).join("\n")}\n\n${question}` }),
  };
  const rows: string[] = [];
  for (const [mname, choice] of [["Haiku 5.5", HAIKU], ["Sonnet 5.5", SONNET]] as const) {
    for (const [sname, make] of Object.entries(shapes)) {
      const first: number[] = [];
      const total: number[] = [];
      let sample = "";
      let input = 0;
      let cached = 0;
      for (let i = 0; i < N + 1; i++) {
        const p = make(i);
        let r;
        try {
          r = await direct("speak", { ...p, maxTokens: 120, choice });
        } catch (e) {
          console.error(`${mname} ${sname} ${i}: ${e instanceof Error ? e.message : e}`);
          continue;
        }
        if (i === 0 && sname !== "full-miss") continue; // 첫 번은 캐시를 데우는 데 쓴다
        if (r.stat.firstTokenMs !== undefined) first.push(r.stat.firstTokenMs);
        total.push(r.stat.ms);
        input = r.stat.input;
        cached = r.stat.cacheRead;
        sample ||= r.text.split("\n")[0];
      }
      const line = `| ${mname} | ${sname} | ${input} / ${cached} | ${pct(first, 50)} / ${pct(first, 90)} | ${pct(total, 50)} / ${pct(total, 90)} | ${sample.slice(0, 60)} |`;
      console.log(line);
      rows.push(line);
    }
  }
  const out = [
    `# 대답 첫 글자 시간 — ${new Date().toISOString()}`,
    "",
    `각 꼴 ${N}번 (캐시 적중 꼴은 한 번 데운 뒤). max_tokens 120, 생각 끔, effort low. 이 맥에서 Anthropic API로.`,
    "",
    "| 모델 | 꼴 | 입력 / 캐시 읽기 토큰 | 첫 토큰 p50 / p90 (ms) | 전체 p50 / p90 (ms) | 예 (첫 줄) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ];
  const file = path.join(ROOT, "tests", "live", "results", `latency-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  fs.writeFileSync(file, out.join("\n"));
  console.log(`저장: ${path.relative(ROOT, file)}`);
}
void main();
