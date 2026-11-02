import type Database from "better-sqlite3";
import { getDb } from "./db";
import type { Change, Commit, CommitWithChanges, HeadNode, NodeFields } from "./types";

// HEAD는 저장된 진실이 아니라 commits 재생 결과다.
// 적용된(applied) 커밋과 확인 대기(pending) 커밋을 seq 순으로 재생한다. 거절·되돌린 커밋은 제외.
// 확인 대기 커밋도 재생하는 이유: 다음 회의 에이전트가 "지난번 정한 것"을 볼 수 있어야 한다.
// 대신 그 커밋이 만든/바꾼 노드에는 review_pending 표시가 붙는다.
export function rebuildHead(spaceId: string, db: Database.Database = getDb()): void {
  const commits = db
    .prepare(
      `SELECT * FROM commits WHERE space_id = ? AND status IN ('applied', 'pending') AND reverted = 0 ORDER BY seq ASC`,
    )
    .all(spaceId) as Commit[];

  const nodes = new Map<string, HeadNode>();
  let order = 0;

  const insert = (id: string, f: NodeFields, sourceIds: number[], c: Commit, supersedes: string | null) => {
    nodes.set(id, {
      id,
      space_id: spaceId,
      due: null,
      ...f,
      source_ids: sourceIds,
      superseded_by: null,
      supersedes,
      reject_reason: null,
      created_commit_id: c.id,
      updated_commit_id: c.id,
      sort_order: order++,
      review_pending: c.status === "pending" ? 1 : 0,
    });
  };
  const touch = (n: HeadNode, c: Commit) => {
    n.updated_commit_id = c.id;
    if (c.status === "pending") n.review_pending = 1;
  };

  for (const c of commits) {
    const changes = JSON.parse(c.changes_json) as Change[];
    for (const ch of changes) {
      switch (ch.op) {
        case "add":
          insert(ch.node_id, ch.node, ch.source_ids, c, null);
          break;
        case "update": {
          const n = nodes.get(ch.node_id);
          if (!n) break; // 앞선 커밋이 되돌려져 노드가 없으면 건너뜀
          Object.assign(n, stripUndefined(ch.after));
          if (ch.after.reject_reason !== undefined) n.reject_reason = ch.after.reject_reason;
          n.source_ids = [...new Set([...n.source_ids, ...ch.source_ids])];
          touch(n, c);
          break;
        }
        case "supersede": {
          const old = nodes.get(ch.node_id);
          if (old) {
            old.status = "superseded";
            old.superseded_by = ch.new_node_id;
            touch(old, c);
          }
          insert(ch.new_node_id, ch.node, ch.source_ids, c, old ? old.id : null);
          break;
        }
        case "withdraw": {
          const n = nodes.get(ch.node_id);
          if (!n) break;
          n.status = n.type === "claim" ? "rejected" : "withdrawn";
          n.reject_reason = ch.reason;
          n.source_ids = [...new Set([...n.source_ids, ...ch.source_ids])];
          touch(n, c);
          break;
        }
      }
    }
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM nodes WHERE space_id = ?`).run(spaceId);
    const ins = db.prepare(
      `INSERT INTO nodes (id, space_id, type, title, body, topic, owner, status, due, source_ids_json, superseded_by, supersedes, reject_reason, created_commit_id, updated_commit_id, sort_order, review_pending)
       VALUES (@id, @space_id, @type, @title, @body, @topic, @owner, @status, @due, @source_ids_json, @superseded_by, @supersedes, @reject_reason, @created_commit_id, @updated_commit_id, @sort_order, @review_pending)`,
    );
    for (const n of nodes.values()) {
      ins.run({ ...n, due: n.due ?? null, source_ids_json: JSON.stringify(n.source_ids) });
    }
  });
  tx();
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && k !== "reject_reason") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function getHead(spaceId: string): HeadNode[] {
  const rows = getDb()
    .prepare(`SELECT * FROM nodes WHERE space_id = ? ORDER BY sort_order ASC`)
    .all(spaceId) as (Omit<HeadNode, "source_ids"> & { source_ids_json: string })[];
  return rows.map(({ source_ids_json, ...r }) => ({ ...r, source_ids: JSON.parse(source_ids_json) }));
}

export function getCommits(spaceId: string, sessionId?: string): CommitWithChanges[] {
  const rows = (
    sessionId
      ? getDb().prepare(`SELECT * FROM commits WHERE space_id = ? AND session_id = ? ORDER BY seq ASC`).all(spaceId, sessionId)
      : getDb().prepare(`SELECT * FROM commits WHERE space_id = ? ORDER BY seq ASC`).all(spaceId)
  ) as Commit[];
  return rows.map(({ changes_json, ...c }) => ({ ...c, changes: JSON.parse(changes_json) as Change[] }));
}

// 에이전트에 넣을 압축 HEAD. 대체·철회된 노드는 제외해 토큰을 아낀다.
export function compactHead(nodes: HeadNode[]) {
  return nodes
    .filter((n) => n.status !== "superseded" && n.status !== "withdrawn")
    .map((n) => ({
      id: n.id,
      type: n.type,
      status: n.status,
      topic: n.topic,
      title: n.title,
      body: n.body,
      owner: n.owner ?? undefined,
      due: n.due ?? undefined,
      review_pending: n.review_pending ? true : undefined,
    }));
}
