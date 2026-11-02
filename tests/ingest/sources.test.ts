// 근거 조각 테이블 넓히기 (knowledge-design §1-2·§1-5) — 마이그레이션, 자료 조각 기록, 조각 단위 증분. 모델 없이.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, migrateSources } from "../../src/lib/db";
import { ingestFile } from "../../src/lib/ingest";
import type { Extractor } from "../../src/lib/ingest/extract";
import { docRows, docSources } from "../../src/lib/ingest/sources";
import { bindDoc, unbindDoc } from "../../src/lib/live/docs";
import { createSession, createSpace, getSources } from "../../src/lib/service";

const tmp = path.join(process.cwd(), "tests", ".tmp", `sources-${process.pid}`);
process.env.GALPI_INGEST_DIR = path.join(tmp, "data", "ingest");
process.env.GALPI_UPLOAD_DIR = path.join(tmp, "data", "uploads");

const lines: Extractor = async ({ chunks }) => ({
  facts: chunks.flatMap((c, i) => c.text.split("\n").map((l) => l.replace(/^[-#\s]+/, "").trim()).filter(Boolean).map((l) => ({ chunk: i, kind: "claim" as const, text: l, quote: l, keys: [] }))),
  usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 },
});

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

describe("sources 마이그레이션", () => {
  it("옛 표(session_id 필수)를 다시 만들어도 id·내용이 그대로고, 발화의 스페이스를 채운다", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL);
      CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), idx INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT);
      INSERT INTO sessions VALUES ('se_1', 'sp_a');
      INSERT INTO sources (id, session_id, idx, speaker, text) VALUES (7, 'se_1', 1, '기헌', '마감은 11/2'), (9, 'se_1', 2, '준영', '좋아요');`);
    migrateSources(db);
    const cols = db.prepare(`PRAGMA table_info(sources)`).all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === "session_id")?.notnull).toBe(0);
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["kind", "space_id", "doc_id", "loc", "external_id", "external_url", "content_hash", "at", "gone"]));
    expect(db.prepare(`SELECT id, idx, speaker, text, kind, space_id, gone FROM sources ORDER BY id`).all()).toEqual([
      { id: 7, idx: 1, speaker: "기헌", text: "마감은 11/2", kind: "utterance", space_id: "sp_a", gone: 0 },
      { id: 9, idx: 2, speaker: "준영", text: "좋아요", kind: "utterance", space_id: "sp_a", gone: 0 },
    ]);
    // 새 행 id는 옛 최댓값 다음 (AUTOINCREMENT 이어짐)
    db.prepare(`INSERT INTO sources (session_id, idx, speaker, text) VALUES ('se_1', 3, '지호', '네')`).run();
    expect((db.prepare(`SELECT MAX(id) m FROM sources`).get() as { m: number }).m).toBe(10);
    migrateSources(db); // 두 번 돌려도 그대로
    expect((db.prepare(`SELECT COUNT(*) n FROM sources`).get() as { n: number }).n).toBe(3);
  });

  it("파일 DB면 다시 만들기 전에 옆에 .bak-YYYYMMDD-HHMM 사본을 한 번 뜬다 (이미 새 꼴이면 안 뜸)", () => {
    const file = path.join(tmp, "old.db");
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL);
      CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), idx INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT);
      INSERT INTO sessions VALUES ('se_1', 'sp_a');
      INSERT INTO sources (session_id, idx, speaker, text) VALUES ('se_1', 1, '기헌', '마감은 11/2');`);
    const baks = () => fs.readdirSync(tmp).filter((f) => f.startsWith("old.db.bak-"));
    migrateSources(db);
    expect(baks()).toHaveLength(1);
    expect(baks()[0]).toMatch(/^old\.db\.bak-\d{8}-\d{4}$/);
    // 사본은 옛 꼴 그대로, 내용도 그대로
    const bak = new Database(path.join(tmp, baks()[0]), { readonly: true });
    expect((bak.prepare(`PRAGMA table_info(sources)`).all() as { name: string; notnull: number }[]).find((c) => c.name === "session_id")?.notnull).toBe(1);
    expect(bak.prepare(`SELECT text FROM sources`).all()).toEqual([{ text: "마감은 11/2" }]);
    bak.close();
    migrateSources(db); // 이미 새 꼴 → 사본 안 뜸
    expect(baks()).toHaveLength(1);
    db.close();
  });

  it("새 회의 발화는 kind=utterance, space_id가 채워진다", () => {
    const sp = createSpace("발화 팀");
    const ses = createSession(sp.id, "회의", "2026-10-30", "기헌: 마감은 11월 2일이에요\n준영: 좋아요");
    const s = getSources(ses.id);
    expect(s.map((x) => [x.kind, x.space_id])).toEqual([["utterance", sp.id], ["utterance", sp.id]]);
  });
});

describe("자료 조각 기록", () => {
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  it("묶으면 docs 행과 조각(doc_chunk)이 생기고, 다른 스페이스에는 없다", async () => {
    const a = createSpace("A");
    const b = createSpace("B");
    const file = path.join(tmp, "plan.md");
    write(file, "# 기획\n\n## 일정\n\n제출은 11/2.\n\n## 강도\n\n세 단계.\n");
    const info = (await ingestFile(file, { extractor: lines })).info;
    bindDoc(a.id, info.id);
    const [row] = docRows(a.id);
    expect(row).toMatchObject({ id: info.id, kind: "doc", connector: "folder", title: "기획", role: "ref", status: "active", external_url: null });
    expect(row.version).toMatch(/^[0-9a-f]{64}$/);
    expect(row.fetched_at).toBeTruthy();
    const chunks = docSources(a.id, info.id);
    expect(chunks.map((c) => [c.kind, c.loc])).toEqual([["doc_chunk", '"일정" 절'], ["doc_chunk", '"강도" 절']]);
    expect(chunks.every((c) => c.content_hash.length === 64 && c.speaker === "" && c.session_id === null)).toBe(true);
    expect(docRows(b.id)).toEqual([]);
    expect(docSources(b.id, info.id)).toEqual([]);
  });

  it("다시 읽으면 바뀐 조각만 새 행, 같은 조각은 id 유지, 없어진 조각은 숨김", async () => {
    const sp = createSpace("증분");
    const file = path.join(tmp, "plan.md");
    write(file, "# 기획\n\n## 일정\n\n제출은 11/2.\n\n## 강도\n\n세 단계.\n\n## 목소리\n\n아직 안 정함.\n");
    const id = (await ingestFile(file, { extractor: lines })).info.id;
    bindDoc(sp.id, id);
    const before = docSources(sp.id, id);
    write(file, "# 기획\n\n## 강도\n\n세 단계.\n\n## 일정\n\n제출은 11/2, 리허설은 11/1.\n");
    await ingestFile(file, { extractor: lines });
    bindDoc(sp.id, id);
    const after = docSources(sp.id, id);
    expect(after.map((c) => c.loc)).toEqual(['"강도" 절', '"일정" 절']);
    expect(after[0].id).toBe(before[1].id); // "강도"는 순서만 바뀜
    expect(after[1].id).not.toBe(before[0].id); // "일정"은 본문이 바뀜
    const gone = docSources(sp.id, id, { withGone: true }).filter((c) => c.gone);
    expect(gone.map((c) => c.loc).sort()).toEqual(['"목소리" 절', '"일정" 절']);
  });

  it("업로드 폴더의 notion-<id>.md는 노션 페이지(kind=page)로, 원문 주소를 단다", async () => {
    const sp = createSpace("노션");
    const pid = "0123456789abcdef0123456789abcdef";
    const file = path.join(process.env.GALPI_UPLOAD_DIR!, sp.id, `notion-${pid}.md`);
    write(file, "# 회의 규칙\n\n## 강도\n\n세 단계.\n");
    const id = (await ingestFile(file, { extractor: lines })).info.id;
    bindDoc(sp.id, id);
    expect(docRows(sp.id)[0]).toMatchObject({ kind: "page", connector: "notion", external_id: pid, external_url: `https://www.notion.so/${pid}` });
    expect(docSources(sp.id, id).map((c) => [c.kind, c.external_id])).toEqual([["page", pid]]);
  });

  it("묶음을 풀면 docs는 gone, 조각은 숨김 (행은 남음)", async () => {
    const sp = createSpace("풀기");
    const file = path.join(tmp, "a.md");
    write(file, "# A\n\n한 줄.\n");
    const id = (await ingestFile(file, { extractor: lines })).info.id;
    bindDoc(sp.id, id);
    unbindDoc(sp.id, id);
    expect(docRows(sp.id)[0].status).toBe("gone");
    expect(docSources(sp.id, id)).toEqual([]);
    expect(docSources(sp.id, id, { withGone: true })).toHaveLength(1);
    expect((getDb().prepare(`SELECT COUNT(*) n FROM sources WHERE doc_id = ?`).get(id) as { n: number }).n).toBe(1);
  });
});
