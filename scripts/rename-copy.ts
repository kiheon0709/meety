// 녹화·시연용 DB 복사본(meeting.sh가 원본 ctxgit.db를 떠 온 것)에서 옛 서비스 이름 "갈피"를 "미티"로 바꾼다. 원본에는 절대 쓰지 않는다.
// 10/31 기헌 "ㅇㅇ 바꾸자": 데모 대본의 "이름은 갈피로 확정"을 미티로. 낱말은 S10(07b1128 data/transcripts/03-pricing.md·B-plan.md)과 같게.
//   npx tsx scripts/rename-copy.ts data/meeting-날짜.db
// 문장째 바꿀 것(갈피를 못 잡겠다·책갈피 같은 말장난)을 먼저 바꾸고, 남은 "갈피"는 "미티"로. 모든 표의 글 칸을 훑는다
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) throw new Error("복사본 DB 경로를 주세요");
const src = path.resolve(process.env.GALPI_SOURCE_DB ?? path.join(process.cwd(), "data/ctxgit.db"));
if (path.resolve(file) === src || /ctxgit\.db$/.test(file)) throw new Error(`원본(${file})에는 쓰지 않아요 — 복사본만`);

const space = /^const SPACE_NAME = "(.*)";$/m.exec(fs.readFileSync("scripts/seed.ts", "utf8"))?.[1] ?? "심화프로젝트랩 5조 · 미티";
const RULES: [string, string][] = [
  // 회의 3 녹취 (03-pricing.md와 같게)
  ['"갈피"는 어때요? 갈피를 못 잡겠다 할 때 그 갈피요.', '"미티"는 어때요? 미팅에서 따온 이름이에요.'],
  ["회의할 때마다 책갈피 하나씩 꽂아두는 느낌이네요. 좋아요.", '회의 때 "미티야" 하고 부르기도 쉽겠네요. 좋아요.'],
  // 그 회의에서 나온 결정·제안 (정리 결과)
  ["'갈피를 못 잡겠다'의 갈피이자 회의마다 책갈피를 꽂는 느낌이고, 비개발자도 바로 알아들을 수 있어 '갈피'로 정했다.", "미팅에서 따온 이름이라 회의 때 '미티야' 하고 부르기 쉽고, 비개발자도 바로 알아들을 수 있어 '미티'로 정했다."],
  ["갈피를 못 잡겠다 할 때의 '갈피'를 쓰자는 의견.", "미팅에서 따온 '미티'를 쓰자는 의견."],
  // 기획 자료 첫 줄 (B-plan.md와 같게)
  ["갈피는 팀 회의에 같이 앉아 있는 AI 팀원", "우리 팀은 팀 회의에 같이 앉아 있는 AI 팀원"],
  ["심화프로젝트랩 5조 · 갈피 프로젝트", space],
  ["갈피", "미티"],
];

const db = new Database(file);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
let changed = 0;
const left: string[] = [];
db.transaction(() => {
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string; type: string }[]).filter((c) => /TEXT|^$/i.test(c.type)).map((c) => c.name);
    for (const c of cols) {
      for (const [from, to] of RULES) changed += db.prepare(`UPDATE "${t}" SET "${c}" = replace("${c}", ?, ?) WHERE instr("${c}", ?) > 0`).run(from, to, from).changes;
      const n = db.prepare(`SELECT count(*) FROM "${t}" WHERE instr("${c}", '갈피') > 0`).pluck().get() as number;
      if (n) left.push(`${t}.${c} ${n}`);
    }
  }
})();
db.close();
console.log(`   복사본에서 "갈피" → "미티": ${changed}칸 바꿈${left.length ? `, 남은 곳 ${left.join(", ")}` : ", 남은 곳 0"}`);
