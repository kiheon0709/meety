// 자료를 스페이스에 묶을 때 docs 행과 근거 조각(sources: doc_chunk·page)을 DB에 남긴다 (knowledge-design §1-2·§1-5).
// 사실·검색은 아직 data/ingest/ JSON에서 읽는다. 여기 행은 출처 표시·조각 단위 증분·연동(S5)이 쓸 자리.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, now } from "@/lib/db";
import type { DocKind, DocRow, DocSource, SourceKind } from "@/lib/types";
import { dataDir } from "./config";
import { readDoc } from "./read";
import { readIndex } from "./store";

export interface DocMeta {
  connector?: string;
  kind?: DocKind;
  externalId?: string;
  url?: string;
  version?: string; // 원본 쪽 버전 (노션 last_edited_time 등). 없으면 파일 sha256
  asOf?: string;
  acl?: unknown; // 원본 공유 범위 스냅샷 (S5가 채움, v1은 표시만)
}

// S5 integrations/upload.ts uploadsDir()와 같은 자리
const uploadsDir = () => process.env.GALPI_UPLOAD_DIR || path.join(path.dirname(dataDir()), "uploads");
const NOTION_FILE = /^notion-([0-9a-f]{32})\.md$/;

// 경로만 보고 어디서 온 자료인지: 업로드 폴더의 notion-<id>.md는 노션 페이지(S5 toFacts), 나머지 업로드는 upload, 그 밖은 folder
export function guessMeta(file: string): DocMeta {
  const rel = path.relative(uploadsDir(), file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { connector: "folder", kind: "doc" };
  const notion = path.basename(file).match(NOTION_FILE);
  if (notion) return { connector: "notion", kind: "page", externalId: notion[1], url: `https://www.notion.so/${notion[1]}` };
  return { connector: "upload", kind: "doc" };
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function recordDoc(spaceId: string, docId: string, meta: DocMeta = {}): void {
  const entry = readIndex()[docId];
  if (!entry) return;
  const file = path.resolve(entry.path);
  const m = { ...guessMeta(file), ...meta };
  const kind: SourceKind = m.kind === "page" ? "page" : "doc_chunk";
  const chunks = fs.existsSync(file) ? readDoc(file).chunks : null;
  const db = getDb();
  const t = now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO docs (space_id, id, kind, connector, external_id, external_url, title, as_of, version, fetched_at, acl_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT(space_id, id) DO UPDATE SET kind = excluded.kind, connector = excluded.connector, external_id = excluded.external_id,
         external_url = excluded.external_url, title = excluded.title, as_of = COALESCE(excluded.as_of, docs.as_of), version = excluded.version,
         fetched_at = excluded.fetched_at, acl_json = COALESCE(excluded.acl_json, docs.acl_json), status = 'active'`,
    ).run(spaceId, docId, m.kind ?? "doc", m.connector ?? "folder", m.externalId ?? entry.path, m.url ?? null, entry.title, m.asOf ?? null, m.version ?? entry.hash, t, m.acl === undefined ? null : JSON.stringify(m.acl));
    if (!chunks) return; // 원본 파일이 없으면 조각은 그대로 둔다

    // 조각 단위 증분: 본문(content_hash)이 같으면 행을 그대로 두고 순서·위치만 고친다. 사라진 조각은 gone=1 (지난 근거 링크 보존).
    const old = db.prepare(`SELECT id, content_hash FROM sources WHERE space_id = ? AND doc_id = ? AND gone = 0 ORDER BY idx`).all(spaceId, docId) as { id: number; content_hash: string }[];
    const byHash = new Map<string, number[]>();
    for (const o of old) byHash.set(o.content_hash, [...(byHash.get(o.content_hash) ?? []), o.id]);
    const kept = new Set<number>();
    const move = db.prepare(`UPDATE sources SET idx = ?, loc = ?, kind = ?, external_id = ?, external_url = ? WHERE id = ?`);
    const add = db.prepare(
      `INSERT INTO sources (session_id, idx, speaker, text, created_at, kind, space_id, doc_id, loc, external_id, external_url, content_hash, at)
       VALUES (NULL, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    chunks.forEach((c, i) => {
      const h = sha(c.text);
      const id = byHash.get(h)?.shift();
      if (id !== undefined) {
        kept.add(id);
        move.run(i + 1, c.loc, kind, m.externalId ?? null, m.url ?? null, id);
      } else add.run(i + 1, c.text, t, kind, spaceId, docId, c.loc, m.externalId ?? null, m.url ?? null, h, m.asOf ?? null);
    });
    const gone = db.prepare(`UPDATE sources SET gone = 1 WHERE id = ?`);
    for (const o of old) if (!kept.has(o.id)) gone.run(o.id);
  })();
}

// 묶음을 풀 때: 행은 지우지 않고 숨긴다 (지난 회의 근거 링크가 깨지지 않게)
export function forgetDoc(spaceId: string, docId: string): void {
  const db = getDb();
  db.prepare(`UPDATE docs SET status = 'gone' WHERE space_id = ? AND id = ?`).run(spaceId, docId);
  db.prepare(`UPDATE sources SET gone = 1 WHERE space_id = ? AND doc_id = ?`).run(spaceId, docId);
}

export function docRows(spaceId: string): DocRow[] {
  return getDb().prepare(`SELECT * FROM docs WHERE space_id = ? ORDER BY id`).all(spaceId) as DocRow[];
}

export function docSources(spaceId: string, docId: string, opts: { withGone?: boolean } = {}): DocSource[] {
  const q = `SELECT * FROM sources WHERE space_id = ? AND doc_id = ? ${opts.withGone ? "" : "AND gone = 0"} ORDER BY gone, idx`;
  return getDb().prepare(q).all(spaceId, docId) as DocSource[];
}
