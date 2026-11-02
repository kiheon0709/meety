// 가짜 녹취 3개로 스페이스 하나를 만든다 (처리는 안 함).
//   npx tsx scripts/seed.ts          → 기존 DB 유지하고 추가
//   npx tsx scripts/seed.ts --reset  → DB 비우고 다시
//   npx tsx scripts/seed.ts --dev-user → 개발용 계정(dev@galpi.local / galpi-dev-2026)을 만들고 예시 스페이스의 "기헌"에 연결
import "./env";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";
import { addMember, createSession, createSpace, linkMemberToUser, findMemberByName, updateSpaceSettings } from "../src/lib/service";
import { createUser, findUserByEmail } from "../src/lib/auth";

const SPACE_NAME = "심화프로젝트랩 5조 · 미티";

function parseFile(file: string) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`front matter 없음: ${file}`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const [k, ...rest] = line.split(":");
    meta[k.trim()] = rest.join(":").trim();
  }
  return { title: meta.title, held_at: meta.held_at, body: m[2] };
}

const db = getDb();
if (process.argv.includes("--reset")) {
  db.exec(
    `DELETE FROM approvals; DELETE FROM comments; DELETE FROM invites; DELETE FROM briefings; DELETE FROM nodes; DELETE FROM commits; DELETE FROM sources; DELETE FROM docs; DELETE FROM sessions; DELETE FROM members; DELETE FROM spaces;`,
  );
  console.log("DB 초기화");
}

const space = createSpace(SPACE_NAME, undefined, true);
for (const name of ["기헌", "준영", "태은", "지호"]) addMember(space.id, name, name === "기헌" ? "owner" : "member");
updateSpaceSettings(space.id, { approval_mode: "count", approval_count: 2 });

const dir = path.join(process.cwd(), "data", "transcripts");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
  const { title, held_at, body } = parseFile(path.join(dir, f));
  const s = createSession(space.id, title, held_at, body);
  console.log(`세션 생성: ${s.id}  ${held_at}  ${title}  (${s.participants})`);
}
console.log(`스페이스: ${space.id}  ${space.name}  (멤버 기헌·준영·태은·지호, 동의 방식: 2명 이상)`);

if (process.argv.includes("--dev-user")) {
  const u = findUserByEmail("dev@galpi.local") ?? createUser("dev@galpi.local", "기헌", "galpi-dev-2026");
  const m = findMemberByName(space.id, "기헌");
  if (m) linkMemberToUser(m.id, u.id);
  console.log(`개발용 계정 ${u.email} → 멤버 기헌에 연결`);
}
