import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// 기본은 프로젝트의 data/ctxgit.db. 배포(볼륨)나 테스트는 GALPI_DB_PATH로 바꾼다.
const DB_PATH = process.env.GALPI_DB_PATH ?? path.join(process.cwd(), "data", "ctxgit.db");

// 근거 조각. 발화(utterance)와 자료 조각(doc_chunk·page …)이 같은 테이블 — 자료 조각은 session_id가 없다.
// 발화 전용 칸(session_id·idx·speaker)은 그대로, 자료 조각은 idx = 조각 순서, speaker = ''.
const SOURCES_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  idx INTEGER NOT NULL,
  speaker TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created_at TEXT,
  kind TEXT NOT NULL DEFAULT 'utterance',
  space_id TEXT,
  doc_id TEXT,
  loc TEXT,
  external_id TEXT,
  external_url TEXT,
  content_hash TEXT,
  at TEXT,
  gone INTEGER NOT NULL DEFAULT 0
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  next_node_seq INTEGER NOT NULL DEFAULT 1,
  approval_mode TEXT NOT NULL DEFAULT 'any',
  approval_count INTEGER NOT NULL DEFAULT 1,
  review_hours INTEGER NOT NULL DEFAULT 48,
  discord_webhook TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_decider INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'stone',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS members_space ON members(space_id);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  title TEXT NOT NULL,
  held_at TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  kind TEXT NOT NULL DEFAULT 'meeting',
  stage TEXT,
  stage_detail TEXT,
  topics_json TEXT,
  error TEXT,
  usage_json TEXT,
  live_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (${SOURCES_COLUMNS});
CREATE INDEX IF NOT EXISTS sources_session ON sources(session_id, idx);
CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT,
  reverted INTEGER NOT NULL DEFAULT 0,
  changes_json TEXT NOT NULL,
  author_member_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commits_space_seq ON commits(space_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL REFERENCES commits(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  vote TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(commit_id, member_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  node_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  source_id INTEGER,
  text TEXT NOT NULL,
  consumed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_node ON comments(space_id, node_id);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  owner TEXT,
  status TEXT NOT NULL,
  due TEXT,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  superseded_by TEXT,
  supersedes TEXT,
  reject_reason TEXT,
  created_commit_id TEXT NOT NULL,
  updated_commit_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  review_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id, id)
);
CREATE INDEX IF NOT EXISTS nodes_space ON nodes(space_id, sort_order);
CREATE TABLE IF NOT EXISTS briefings (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id),
  head_commit_id TEXT,
  content TEXT NOT NULL,
  usage_json TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'agent',
  ref_type TEXT,
  ref_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_space ON events(space_id, created_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_member ON notifications(member_id, read_at);
-- 연동 (S5, docs/architecture/integration.md §3). 토큰은 token_enc에 암호화해서만 (src/lib/integrations/crypto.ts)
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  connector TEXT NOT NULL,
  installed_by TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  token_enc TEXT,
  root_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(space_id, connector)
);
-- 내보낸 것: 같은 노드를 같은 곳에 두 번 만들지 않게 idempotency_key 유니크
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  node_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  target TEXT NOT NULL,
  external_id TEXT,
  external_url TEXT,
  node_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  error TEXT,
  claimed_at TEXT,
  pushed_at TEXT,
  created_at TEXT NOT NULL
);
-- 자료 한 덩어리 (S4, docs/architecture/knowledge-design.md §1-2). 같은 자료를 두 스페이스가 쓰면 행이 둘 — 스페이스끼리 나눠 쓰지 않는다.
-- 이름은 S5 connections·exports와 맞춘다 (connector, external_id, external_url). kind: doc | page | calendar | issues | channel
CREATE TABLE IF NOT EXISTS docs (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  connector TEXT NOT NULL,
  external_id TEXT,
  external_url TEXT,
  title TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'ref',
  as_of TEXT,
  version TEXT,
  fetched_at TEXT NOT NULL,
  acl_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (space_id, id)
);
`;

// 옛 sources(session_id NOT NULL)는 자료 조각을 못 넣으므로 한 번 다시 만든다. id는 그대로 옮긴다 (commits.source_ids가 가리킴).
// 발화의 space_id는 세션에서 채운다. 다시 만들기 전에 같은 폴더에 <파일>.bak-YYYYMMDD-HHMM 사본을 뜬다 (원본 DB를 그 자리에서 바꾸므로).
export function migrateSources(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(sources)`).all() as { name: string; notnull: number }[];
  if (!cols.length || cols.some((c) => c.name === "session_id" && c.notnull === 0)) return;
  backupBeforeMigrate(db);
  const keep = ["id", "session_id", "idx", "speaker", "text", "created_at"].filter((c) => cols.some((x) => x.name === c)).join(", ");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE sources_new (${SOURCES_COLUMNS})`);
      db.exec(`INSERT INTO sources_new (${keep}) SELECT ${keep} FROM sources`);
      db.exec(`UPDATE sources_new SET space_id = (SELECT space_id FROM sessions WHERE sessions.id = sources_new.session_id)`);
      db.exec(`DROP TABLE sources`);
      db.exec(`ALTER TABLE sources_new RENAME TO sources`);
      db.exec(`CREATE INDEX IF NOT EXISTS sources_session ON sources(session_id, idx)`);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// VACUUM INTO는 WAL에 남은 것까지 한 시점으로 묶어 새 파일에 쓴다. 메모리 DB는 뜰 파일이 없다.
function backupBeforeMigrate(db: Database.Database): string | null {
  if (db.memory || !db.name) return null;
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  let file = `${db.name}.bak-${stamp}`;
  for (let i = 2; fs.existsSync(file); i++) file = `${db.name}.bak-${stamp}-${i}`;
  db.prepare(`VACUUM INTO ?`).run(file);
  console.warn(`sources 표를 새 꼴로 바꾸기 전에 DB 사본을 떴어요: ${file}`);
  return file;
}

// 기존 DB에 새 컬럼 보강 (CREATE IF NOT EXISTS 는 컬럼을 안 더해주므로)
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ["spaces", "approval_mode", "ALTER TABLE spaces ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'any'"],
  ["spaces", "approval_count", "ALTER TABLE spaces ADD COLUMN approval_count INTEGER NOT NULL DEFAULT 1"],
  ["spaces", "is_demo", "ALTER TABLE spaces ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0"],
  ["spaces", "review_hours", "ALTER TABLE spaces ADD COLUMN review_hours INTEGER NOT NULL DEFAULT 48"],
  ["spaces", "discord_webhook", "ALTER TABLE spaces ADD COLUMN discord_webhook TEXT"],
  ["nodes", "due", "ALTER TABLE nodes ADD COLUMN due TEXT"],
  ["members", "user_id", "ALTER TABLE members ADD COLUMN user_id TEXT"],
  ["sessions", "kind", "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting'"],
  ["sessions", "stage", "ALTER TABLE sessions ADD COLUMN stage TEXT"],
  ["sessions", "stage_detail", "ALTER TABLE sessions ADD COLUMN stage_detail TEXT"],
  ["sessions", "topics_json", "ALTER TABLE sessions ADD COLUMN topics_json TEXT"],
  ["sessions", "live_json", "ALTER TABLE sessions ADD COLUMN live_json TEXT"],
  ["sources", "created_at", "ALTER TABLE sources ADD COLUMN created_at TEXT"],
  ["commits", "author_member_id", "ALTER TABLE commits ADD COLUMN author_member_id TEXT"],
  ["commits", "review_deadline", "ALTER TABLE commits ADD COLUMN review_deadline TEXT"],
  ["briefings", "stale", "ALTER TABLE briefings ADD COLUMN stale INTEGER NOT NULL DEFAULT 0"],
  ["comments", "consumed_by", "ALTER TABLE comments ADD COLUMN consumed_by TEXT"],
];

declare global {
  var __ctxgitDb: Database.Database | undefined;
}

export function getDb(): Database.Database {
  if (globalThis.__ctxgitDb) return globalThis.__ctxgitDb;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // nodes 는 재생 가능한 투영이라, 옛 스키마(id 단독 PK)면 그냥 버리고 다시 만든다.
  const nodeCols = db.prepare(`PRAGMA table_info(nodes)`).all() as { name: string; pk: number }[];
  if (nodeCols.length && !nodeCols.some((c) => c.name === "space_id" && c.pk > 0)) db.exec(`DROP TABLE nodes`);
  db.exec(SCHEMA);
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
  migrateSources(db);
  // 팀장 = 결정권자 (기헌 10/31). 결정권을 따로 켜고 끄던 칸은 남기되 팀장에 맞춘다 — 확인 방식 "팀장만"이 이 칸을 본다
  db.exec(`UPDATE members SET is_decider = CASE WHEN role = 'owner' THEN 1 ELSE 0 END WHERE is_decider != (role = 'owner')`);
  db.exec(`CREATE INDEX IF NOT EXISTS sources_doc ON sources(space_id, doc_id)`);
  globalThis.__ctxgitDb = db;
  return db;
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function now(): string {
  return new Date().toISOString();
}
