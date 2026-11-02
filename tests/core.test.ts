import { describe, expect, it } from "vitest";
import { getDb, newId, now } from "../src/lib/db";
import { getHead, rebuildHead } from "../src/lib/head";
import { addMember, castVote, createSpace, evaluateApprovals, hasContext, listMembers, markBriefingStale, reviewDeadline, settleDueCommits, splitUtterances, updateSpaceSettings, listApprovals, getBriefing } from "../src/lib/service";
import { josa, listFeed, logEvent, countUnread, markAllRead } from "../src/lib/events";
import { plain } from "../src/lib/plain";
import type { Change, Member, Space } from "../src/lib/types";

function space(name = "t") {
  const sp = createSpace(name);
  for (const n of ["기헌", "준영", "태은", "지호"]) addMember(sp.id, n);
  return sp;
}
function session(sp: Space) {
  const db = getDb();
  const id = newId("se");
  db.prepare(`INSERT INTO sessions (id, space_id, title, held_at, participants, transcript, status, kind, created_at) VALUES (?, ?, 't', '2026-10-20', '', '', 'done', 'meeting', ?)`).run(id, sp.id, now());
  const r = db.prepare(`INSERT INTO sources (session_id, idx, speaker, text, created_at) VALUES (?, 1, '기헌', 'x', ?)`).run(id, now());
  return { id, sourceId: Number(r.lastInsertRowid) };
}
function commit(sp: Space, ses: string, seq: number, changes: Change[], opts: { status?: string; deadline?: string | null } = {}) {
  const id = newId("c");
  getDb()
    .prepare(`INSERT INTO commits (id, space_id, session_id, seq, message, status, needs_review, review_reason, reverted, changes_json, review_deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`)
    .run(id, sp.id, ses, seq, `c${seq}`, opts.status ?? "applied", opts.status === "pending" ? 1 : 0, JSON.stringify(changes), opts.deadline ?? null, now());
  return id;
}
const node = (title: string, type: "decision" | "action" | "question" = "decision", status = "agreed") => ({ type, title, body: "", topic: "t", owner: null, status, due: null });

describe("현재 상태 재생 (rebuildHead)", () => {
  it("add → supersede → withdraw가 바뀐 길로 남는다", () => {
    const sp = space();
    const { id: ses, sourceId } = session(sp);
    commit(sp, ses, 1, [{ op: "add", node_id: "n1", node: node("A"), source_ids: [sourceId], reason: "" }]);
    commit(sp, ses, 2, [{ op: "supersede", node_id: "n1", new_node_id: "n2", node: node("B"), source_ids: [sourceId], reason: "" }]);
    commit(sp, ses, 3, [{ op: "withdraw", node_id: "n2", source_ids: [sourceId], reason: "접음" }]);
    rebuildHead(sp.id);
    const h = Object.fromEntries(getHead(sp.id).map((n) => [n.id, n]));
    expect(h.n1.status).toBe("superseded");
    expect(h.n1.superseded_by).toBe("n2");
    expect(h.n2.supersedes).toBe("n1");
    expect(h.n2.status).toBe("withdrawn");
    expect(h.n2.reject_reason).toBe("접음");
  });

  it("되돌린 커밋과 거절된 커밋은 재생에서 빠지고, 확인 대기는 배지만 붙는다", () => {
    const sp = space();
    const { id: ses, sourceId } = session(sp);
    const c1 = commit(sp, ses, 1, [{ op: "add", node_id: "n1", node: node("A"), source_ids: [sourceId], reason: "" }]);
    commit(sp, ses, 2, [{ op: "add", node_id: "n2", node: node("B"), source_ids: [sourceId], reason: "" }], { status: "rejected" });
    commit(sp, ses, 3, [{ op: "add", node_id: "n3", node: node("C"), source_ids: [sourceId], reason: "" }], { status: "pending" });
    getDb().prepare(`UPDATE commits SET reverted = 1 WHERE id = ?`).run(c1);
    rebuildHead(sp.id);
    const ids = getHead(sp.id).map((n) => n.id);
    expect(ids).toEqual(["n3"]);
    expect(getHead(sp.id)[0].review_pending).toBe(1);
  });

  it("update는 이전값·이후값을 적용하고 due를 유지한다", () => {
    const sp = space();
    const { id: ses, sourceId } = session(sp);
    commit(sp, ses, 1, [{ op: "add", node_id: "n1", node: { ...node("할 일", "action", "open"), owner: "지호", due: "2026-11-01" }, source_ids: [sourceId], reason: "" }]);
    commit(sp, ses, 2, [{ op: "update", node_id: "n1", before: { status: "open" }, after: { status: "done" }, source_ids: [sourceId], reason: "" }]);
    rebuildHead(sp.id);
    const n = getHead(sp.id)[0];
    expect(n.status).toBe("done");
    expect(n.due).toBe("2026-11-01");
    expect(n.owner).toBe("지호");
  });
});

describe("동의 규칙 (evaluateApprovals)", () => {
  const sp = (mode: Space["approval_mode"], count = 1): Space => ({ id: "s", name: "", next_node_seq: 1, approval_mode: mode, approval_count: count, review_hours: 48, discord_webhook: null, is_demo: 0, created_at: "" });
  const m = (id: string, decider = 0): Member => ({ id, space_id: "s", user_id: null, name: id, role: "member", is_decider: decider, color: "stone", created_at: "" });
  const v = (member_id: string, vote: "approve" | "reject") => ({ id: member_id + vote, commit_id: "c", member_id, vote, note: null, created_at: "" });
  it("누구나 한 명: 동의 1 → 반영, 반대만 → 빠짐, 둘 다 → 엇갈림", () => {
    const members = [m("a"), m("b")];
    expect(evaluateApprovals(sp("any"), members, [v("a", "approve")]).verdict).toBe("applied");
    expect(evaluateApprovals(sp("any"), members, [v("a", "reject")]).verdict).toBe("rejected");
    expect(evaluateApprovals(sp("any"), members, [v("a", "approve"), v("b", "reject")]).verdict).toBe("conflict");
  });
  it("결정권자만: 결정권 없는 표는 무시", () => {
    const members = [m("a", 1), m("b", 0)];
    expect(evaluateApprovals(sp("deciders"), members, [v("b", "approve")]).verdict).toBe("pending");
    expect(evaluateApprovals(sp("deciders"), members, [v("a", "approve"), v("b", "reject")]).verdict).toBe("applied");
  });
  it("N명 이상: 모자라면 대기, 반대 있고 모자라면 엇갈림", () => {
    const members = [m("a"), m("b"), m("c")];
    expect(evaluateApprovals(sp("count", 2), members, [v("a", "approve")]).verdict).toBe("pending");
    expect(evaluateApprovals(sp("count", 2), members, [v("a", "approve"), v("b", "approve")]).verdict).toBe("applied");
    expect(evaluateApprovals(sp("count", 2), members, [v("a", "approve"), v("b", "reject")]).verdict).toBe("conflict");
  });
});

describe("이의 없으면 확정 (settleDueCommits)", () => {
  it("기한 지남·반대 없음만 확정하고, 기한 없는 건 기한을 매긴다", () => {
    const sp = space();
    const { id: ses, sourceId } = session(sp);
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const add = (seq: number, deadline: string | null) => commit(sp, ses, seq, [{ op: "add", node_id: `n${seq}`, node: node(`d${seq}`), source_ids: [sourceId], reason: "" }], { status: "pending", deadline });
    const a = add(1, past), b = add(2, past), c = add(3, future), d = add(4, null);
    updateSpaceSettings(sp.id, { approval_mode: "count", approval_count: 2 }); // 반대 1표로 바로 안 빠지게
    const jiho = listMembers(sp.id).find((m) => m.name === "지호")!;
    castVote(b, jiho, "reject");
    expect(settleDueCommits(sp.id)).toBe(1);
    const st = Object.fromEntries((getDb().prepare(`SELECT id, status, review_deadline FROM commits WHERE space_id = ?`).all(sp.id) as { id: string; status: string; review_deadline: string | null }[]).map((r) => [r.id, r]));
    expect(st[a].status).toBe("applied");
    expect(st[b].status).toBe("pending");
    expect(st[c].status).toBe("pending");
    expect(st[d].status).toBe("pending");
    expect(st[d].review_deadline).toBeTruthy();
    expect(getHead(sp.id).find((n) => n.id === "n1")?.review_pending).toBe(0);
    expect(listFeed(sp.id).some((e) => e.kind === "settled")).toBe(true);
  });
  it("review_hours가 0이면 기한이 없다", () => {
    const sp = space();
    updateSpaceSettings(sp.id, { review_hours: 0 });
    const s2 = { ...sp, review_hours: 0 };
    expect(reviewDeadline(s2)).toBeNull();
    expect(reviewDeadline(sp)).toBeTruthy();
  });
});

describe("기록·알림 (events)", () => {
  it("알림은 받는 사람에게만 가고 읽으면 0이 된다", () => {
    const sp = space();
    const [a, b] = listMembers(sp.id);
    logEvent({ space_id: sp.id, kind: "todo", title: "x", notify: [a.id, b.id], actor: a.id });
    expect(countUnread([a.id])).toBe(0); // 본인이 한 일은 본인에게 안 감
    expect(countUnread([b.id])).toBe(1);
    markAllRead([b.id]);
    expect(countUnread([b.id])).toBe(0);
    expect(listApprovals([])).toEqual([]);
  });
  it("조사와 우리말 정리", () => {
    expect(josa("기헌", "이/가")).toBe("기헌이");
    expect(josa("지호", "이/가")).toBe("지호가");
    expect(plain("이미 agreed 상태인 결정(n37)을 뒤집는 변경이다.")).toBe("이미 합의된 결정을 뒤집는 변경이다.");
  });
});

describe("긴 녹취 나누기 (splitUtterances)", () => {
  it("150 이하면 한 조각, 넘으면 비슷한 길이로 화자 경계에서 자른다", () => {
    const u = (n: number) => Array.from({ length: n }, (_, i) => ({ speaker: i % 3 === 0 ? "a" : "b", text: "" }));
    expect(splitUtterances(u(150), 150)).toHaveLength(1);
    const parts = splitUtterances(u(400), 150);
    expect(parts).toHaveLength(3);
    expect(parts.flat()).toHaveLength(400);
    for (const p of parts) expect(p.length).toBeGreaterThan(100);
    for (let i = 0; i < parts.length - 1; i++) expect(parts[i].at(-1)!.speaker).not.toBe(parts[i + 1][0].speaker);
  });
});

describe("브리핑 낡음 표시", () => {
  it("맥락이 없으면 hasContext=false, 낡음 표시는 기존 브리핑에만 붙는다", () => {
    const sp = space();
    expect(hasContext(sp.id)).toBe(false);
    getDb().prepare(`INSERT INTO briefings (space_id, head_commit_id, content, usage_json, stale, created_at) VALUES (?, NULL, '- a', NULL, 0, ?)`).run(sp.id, now());
    markBriefingStale(sp.id, 60_000);
    expect(getBriefing(sp.id)?.stale).toBe(1);
    const { id: ses, sourceId } = session(sp);
    commit(sp, ses, 1, [{ op: "add", node_id: "n1", node: node("A"), source_ids: [sourceId], reason: "" }]);
    expect(hasContext(sp.id)).toBe(true);
  });
});
