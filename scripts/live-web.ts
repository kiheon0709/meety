// 웹에서 찾기 확인 (11/1 기헌): 실제 모델·실제 웹 검색으로 부름 두 번 + 팀원끼리 물음 한 번. 말·카드·검색 로그를 tests/live/results/web-*.md로.
//   LIVE_LLM=1 npx tsx scripts/live-web.ts [--only 2]
// DB는 data/ctxgit.db를 tests/.tmp/web.db로 복사해서 쓴다(원본엔 안 씀).
import "./env";
import fs from "node:fs";
import path from "node:path";

if (process.env.LIVE_LLM !== "1") {
  console.error("모델을 부르는 확인이라 LIVE_LLM=1일 때만 돌아요.");
  process.exit(1);
}
const ROOT = process.cwd();
const db = path.join(ROOT, "tests", ".tmp", "web.db");
fs.mkdirSync(path.dirname(db), { recursive: true });
for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
fs.copyFileSync(path.join(ROOT, "data", "ctxgit.db"), db);
process.env.GALPI_DB_PATH = db;
process.env.LIVE_AUTO_PROCESS = "0";

// 한 줄 = 한 사람 말. 부름(미티야) 둘, 팀원끼리 물음 하나(리서치 길 — 다음 말에 답이 없어야 찾는다)
const ONLY = process.argv.includes("--only") ? Number(process.argv[process.argv.indexOf("--only") + 1]) : -1;
const RUNS_ALL: { name: string; participation: number; lines: [string, string][] }[] = [
  { name: "부름: 시장 규모", participation: 7, lines: [["기헌", "미티야, 요즘 회의 AI 시장 규모가 얼마지?"]] },
  { name: "부름: 경쟁 서비스", participation: 7, lines: [["기헌", "미티야, 회의 AI 경쟁 서비스 찾아봐."]] },
  { name: "팀원끼리 (다이얼 9)", participation: 9, lines: [["준영", "근데 국내 회의록 AI 서비스 이용자가 얼마였지?"], ["기헌", "음 글쎄, 잘 모르겠네."]] },
  // 11/2: 리서치가 웹에서 찾는 사이 같은 걸 부름 → 새로 안 찾고 그 검색에 붙어 결과로 대답
  { name: "찾는 중인 검색에 부름이 붙기", participation: 7, lines: [["준영", "근데 회의 AI 시장 규모가 얼마였지?"], ["기헌", "음 글쎄, 잘 모르겠네."], ["기헌", "미티야, 회의 AI 시장 규모 얼마야?"]] },
];
const RUNS = ONLY >= 0 ? [RUNS_ALL[ONLY]] : RUNS_ALL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { getDb } = await import("../src/lib/db");
  const meeting = await import("../src/lib/live/meeting");
  const space = getDb().prepare(`SELECT id FROM spaces WHERE is_demo = 1 AND name LIKE '%5조%' ORDER BY created_at LIMIT 1`).get() as { id: string };
  const out: string[] = [`# 웹에서 찾기 — ${new Date().toISOString()}`, "", `실제 모델(대답 기본 ROLE_MODELS, 웹은 ${meeting.WEB.choice.model} + web_search_20250305 max_uses ${meeting.WEB.maxUses}), 데모 스페이스 5조.`, ""];
  let total = 0;
  for (const run of RUNS) {
    const m = meeting.startMeeting({ spaceId: space.id, title: "웹 확인", agenda: [], intensity: "mid", participants: ["기헌", "준영"], participation: run.participation });
    const t0 = Date.now();
    const log: string[] = [];
    meeting.subscribe(m, (ev) => {
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      if (ev.type === "speak") log.push(`${s}초 🗣 ${ev.kind}: ${ev.text}${ev.evidence.length ? `  (근거: ${ev.evidence.map((e) => e.label).join(" / ")})` : ""}`);
      if (ev.type === "show" && ev.canvas.kind === "text") log.push(`${s}초 🃏 카드 「${ev.canvas.title}」\n${ev.canvas.lines.map((l) => `      ${l}`).join("\n")}`);
    });
    await sleep(300);
    let id = 0;
    for (const [speaker, text] of run.lines) {
      id++;
      log.push(`${((Date.now() - t0) / 1000).toFixed(1)}초 👤 ${speaker}: ${text}`);
      meeting.onUtterance(m, { id, t0: id * 10, t1: id * 10 + 2, text, speaker });
      meeting.onGap(m, id, 1500);
      await sleep(1800);
    }
    for (const t = Date.now(); Date.now() - t < 30000 && (m.busy > 0 || !m.webLog.some((w) => w.reply !== null || w.note)); ) await sleep(200);
    await sleep(2500);
    const snap = meeting.snapshot(m) as { cost: number };
    total += snap.cost;
    out.push(`## ${run.name}`, "", "```", ...log, "```", "", "웹 로그:", "", ...m.webLog.map((w) => `- ${w.via} · "${w.query}" · ${w.ms ?? "-"}ms · 검색 ${w.searches}번 · $${w.cost.toFixed(4)}${w.note ? ` · ${w.note}` : ""}`), ...(m.webLog.length ? [] : ["- (웹 안 부름)"]), ...(m.errors.length ? ["", `오류: ${m.errors.join(" | ")}`] : []), "", `이 회의 비용 $${snap.cost.toFixed(4)}`, "");
    console.log(out.slice(-12).join("\n"));
    await meeting.endMeeting(m).catch(() => undefined);
  }
  out.push(`합계 $${total.toFixed(4)}`, "");
  const file = path.join(ROOT, "tests", "live", "results", `web-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  fs.writeFileSync(file, out.join("\n"));
  console.log(`저장: ${path.relative(ROOT, file)} · $${total.toFixed(4)}`);
  process.exit(0);
}
void main();
