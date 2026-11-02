// 소개 영상 말풍선 장면(docs/presentation/video/scenarios/)의 맥락 데이터를 데모 DB 복사본에 넣는다.
// 원본은 복사만 하고 쓰지 않는다(끝에 해시로 확인). 상황 1~4는 새 예시 스페이스, 상황 5는 기존 "5조 · 미티" 스페이스에 회의 5를 더한다.
// 지난 회의 녹취는 실제 처리(processSession, 모델 호출)로 결정·할 일이 되고, 자료는 읽어서(캐시면 비용 0) 그 스페이스에만 묶는다.
//
//   npx tsx scripts/scene-seed.ts --from ../s10-uiux-0e3d8c/data/demo.db [--out data/scenes.db]
//   그다음: GALPI_SOURCE_DB=$PWD/data/scenes.db MEETING_FRESH=1 MEETING_DOCS= npm run meeting
//   (MEETING_DOCS를 비워야 meeting.sh가 모든 스페이스에 같은 자료를 다시 묶지 않는다)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const FROM = path.resolve(opt("from", process.env.GALPI_SOURCE_DB ?? "")!);
const OUT = path.resolve(opt("out", "data/scenes.db")!);
const DIR = path.join(process.cwd(), "docs/presentation/video/scenarios/context");
const TEAM = ["기헌", "준영", "태은", "지호"];
// 5조 스페이스의 회의 자료(meeting.sh 기본 세트)도 같이 묶어 둔다 — MEETING_DOCS=로 켜면 meeting.sh가 다시 묶지 않으니까
const DEMO_DOCS = ["docs/plan/meety-plan.md", "docs/plan/DECISIONS-2026-10-30-pivot.md", "docs/presentation/submission-guide.md"];

const SCENES: { dir: string; space?: string; members: string[]; docs: string[] }[] = [
  { dir: "s1", space: "산책일기 · 제품팀", members: TEAM, docs: ["s1-interview.md"] },
  { dir: "s2", space: "온결 리빙 · 마케팅영업", members: ["태은", "준영", "지호", "기헌"], docs: ["s2-ads-oct.md"] },
  { dir: "s3", space: "모아 · 디자인개발", members: ["기헌", "지호", "준영", "태은"], docs: ["s3-usability.md"] },
  { dir: "s4", space: "태은 · 동아리 기획", members: ["태은"], docs: ["s4-recruit-2025.md"] },
  { dir: "s5", members: TEAM, docs: [] }, // 기존 5조 스페이스. 지호 질문은 웹 검색으로 — s5-meeting-ai.md는 대비용 대사 근거로만
];

const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 12);

function parseFile(file: string) {
  const m = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`front matter 없음: ${file}`);
  const meta = Object.fromEntries(m[1].split("\n").map((l) => { const [k, ...r] = l.split(":"); return [k.trim(), r.join(":").trim()]; }));
  return { title: meta.title, held_at: meta.held_at, body: m[2] };
}

async function main() {
  if (!fs.existsSync(FROM)) throw new Error(`--from <데모 DB>가 없어요: ${FROM}`);
  if (/ctxgit\.db$/.test(OUT) || OUT === FROM) throw new Error(`이 경로에는 쓰지 않아요: ${OUT}`);
  const before = hash(FROM);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  for (const ext of ["", "-wal", "-shm"]) {
    fs.rmSync(OUT + ext, { force: true });
    if (fs.existsSync(FROM + ext)) fs.copyFileSync(FROM + ext, OUT + ext);
  }
  process.env.GALPI_DB_PATH = OUT; // db.ts가 불러올 때 읽으니 import 전에
  await import("./env");
  const { addMember, createSession, createSpace, listSpaces, processSession } = await import("../src/lib/service");
  const { getHead } = await import("../src/lib/head");
  const { ingestPath } = await import("../src/lib/ingest");
  const { bindDoc, keepOnlyDocs } = await import("../src/lib/live/docs");

  for (const sc of SCENES) {
    const space = sc.space
      ? createSpace(sc.space, undefined, true)
      : listSpaces().find((s) => s.is_demo && s.name.includes("5조"));
    if (!space) throw new Error("5조 예시 스페이스가 없어요 (데모 DB가 맞는지 확인)");
    if (sc.space) sc.members.forEach((n, i) => addMember(space.id, n, i === 0 ? "owner" : "member"));
    const dir = path.join(DIR, sc.dir);
    for (const f of fs.readdirSync(dir).filter((x) => /^\d.*\.md$/.test(x)).sort()) {
      const { title, held_at, body } = parseFile(path.join(dir, f));
      const s = createSession(space.id, title, held_at, body);
      const r = await processSession(s.id);
      console.log(`${space.name} / ${title}: 커밋 ${r.commits} (확인 대기 ${r.pending}) · $${r.usage.cost_usd}`);
    }
    const bound: string[] = [];
    for (const f of [...sc.docs.map((d) => path.join(dir, d)), ...(sc.space ? [] : DEMO_DOCS)]) {
      const info = await ingestPath(f);
      bindDoc(space.id, info.id);
      bound.push(info.id);
      console.log(`  자료 ${info.id} "${info.title}" (사실 ${info.facts}개)`);
    }
    for (const id of keepOnlyDocs(space.id, bound)) console.log(`  자료 묶음 풂 ${id}`); // 전에 묶였던 것(owners.json은 DB 밖이라 남는다)
    const head = getHead(space.id).filter((n) => n.status !== "rejected");
    console.log(`  ${space.id} 지금 기록: ${head.map((n) => `[${n.type}/${n.status}${n.owner ? "/" + n.owner : ""}] ${n.title}`).slice(-12).join("\n    ")}`);
  }
  const after = hash(FROM);
  console.log(`\n→ ${OUT}\n원본 ${FROM} 해시 ${before} → ${after}${before === after ? " (그대로)" : " ⚠️ 바뀜"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
