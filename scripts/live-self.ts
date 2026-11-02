// 미티 자기소개 지식 확인 (11/1 기헌): "너 뭐 할 수 있어?" 같은 물음을 실제 모델로 부름(둘 이상)·1:1 회의에서 한 번씩 물어 대답을 모은다.
//   LIVE_LLM=1 npx tsx scripts/live-self.ts
// DB는 data/ctxgit.db를 tests/.tmp/self.db로 복사해서 쓴다(원본엔 안 씀).
import "./env";
import fs from "node:fs";
import path from "node:path";

if (process.env.LIVE_LLM !== "1") {
  console.error("모델을 부르는 확인이라 LIVE_LLM=1일 때만 돌아요.");
  process.exit(1);
}
const ROOT = process.cwd();
const db = path.join(ROOT, "tests", ".tmp", "self.db");
fs.mkdirSync(path.dirname(db), { recursive: true });
for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
fs.copyFileSync(path.join(ROOT, "data", "ctxgit.db"), db);
process.env.GALPI_DB_PATH = db;
process.env.LIVE_AUTO_PROCESS = "0";

const QUESTIONS = ["너 뭐 할 수 있어?", "너 누가 만들었어?", "우리 대화 어디 저장돼?", "웹 검색 돼?", "조용히 하게 하려면?"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { getDb } = await import("../src/lib/db");
  const meeting = await import("../src/lib/live/meeting");
  const space = getDb().prepare(`SELECT id FROM spaces WHERE is_demo = 1 AND name LIKE '%5조%' ORDER BY created_at LIMIT 1`).get() as { id: string };
  const rows: string[] = [];
  let cost = 0;
  for (const [label, participants] of [["부름", ["기헌", "준영"]], ["1:1", ["기헌"]]] as const) {
    const m = meeting.startMeeting({ spaceId: space.id, title: "자기소개 확인", agenda: [], intensity: "mid", participants: [...participants] });
    const said: { at: number; uttId?: number; text: string }[] = [];
    meeting.subscribe(m, (ev) => {
      if (ev.type === "speak" && ev.kind === "answer") said.push({ at: Date.now(), text: ev.text });
    });
    await sleep(500);
    let id = 0;
    for (const q of QUESTIONS) {
      id++;
      const text = label === "부름" ? `미티야, ${q}` : q;
      const n = said.length;
      const t0 = Date.now();
      meeting.onUtterance(m, { id, t0: id * 10, t1: id * 10 + 2, text, speaker: "기헌" });
      meeting.onGap(m, id, 1500);
      // 대답이 오고 2.5초 조용하면(둘째 문장까지) 다음 물음, 최대 15초
      while (Date.now() - t0 < 15000 && (said.length === n || Date.now() - said[said.length - 1].at < 2500)) await sleep(100);
      const reply = said.slice(n).map((s) => s.text).join(" ") || "(대답 없음)";
      const ms = said.length > n ? said[n].at - t0 : null;
      console.log(`[${label}] ${text} → ${reply}`);
      rows.push(`| ${label} | ${text} | ${reply} | ${reply.length}자 | ${ms === null ? "-" : (ms / 1000).toFixed(1) + "초"} |`);
      await sleep(1500);
    }
    cost += (meeting.snapshot(m) as { cost: number }).cost;
    await meeting.endMeeting(m).catch(() => undefined);
  }
  const out = [
    `# 미티 자기소개 지식 — ${new Date().toISOString()}`,
    "",
    `실제 모델(기본 ROLE_MODELS), 데모 스페이스 5조. 비용 $${cost.toFixed(3)}.`,
    "",
    "| 회의 | 물음 | 대답 | 길이 | 첫 대답까지 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ];
  const file = path.join(ROOT, "tests", "live", "results", `self-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  fs.writeFileSync(file, out.join("\n"));
  console.log(`저장: ${path.relative(ROOT, file)} · $${cost.toFixed(3)}`);
  process.exit(0);
}
void main();
