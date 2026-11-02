import { describe, expect, it } from "vitest";
import { getDb, newId, now } from "../src/lib/db";
import { rebuildHead } from "../src/lib/head";
import { buildMeetingView } from "../src/lib/meeting-view";
import { addMember, createSpace, lastLiveSession, liveRecordOf, saveLiveRecord } from "../src/lib/service";
import type { Change, LiveRecord, Space } from "../src/lib/types";

// 회의 뒤 정리 화면(S10)이 커밋을 바뀐 결정 카드·안건별 요약·할 일로 나누는지
function space() {
  const sp = createSpace("mv");
  for (const n of ["기헌", "준영"]) addMember(sp.id, n);
  return sp;
}
function session(sp: Space, title: string, said: string) {
  const id = newId("se");
  getDb().prepare(`INSERT INTO sessions (id, space_id, title, held_at, participants, transcript, status, kind, created_at) VALUES (?, ?, ?, '2026-10-20', '기헌, 준영', '', 'done', 'meeting', ?)`).run(id, sp.id, title, now());
  const r = getDb().prepare(`INSERT INTO sources (session_id, idx, speaker, text, created_at, space_id) VALUES (?, 1, '기헌', ?, ?, ?)`).run(id, said, now(), sp.id);
  return { id, src: Number(r.lastInsertRowid) };
}
let seq = 0;
function commit(sp: Space, ses: string, changes: Change[], status = "applied") {
  getDb()
    .prepare(`INSERT INTO commits (id, space_id, session_id, seq, message, status, needs_review, reverted, changes_json, created_at) VALUES (?, ?, ?, ?, 'm', ?, ?, 0, ?, ?)`)
    .run(newId("c"), sp.id, ses, ++seq, status, status === "pending" ? 1 : 0, JSON.stringify(changes), now());
}
const node = (title: string, type: "decision" | "action" | "claim" = "decision", status = "agreed", topic = "주제") => ({ type, title, body: `${title} 이유`, topic, owner: null, status });

describe("회의 뒤 정리 (buildMeetingView)", () => {
  it("supersede는 전에는 → 이번 회의에서 카드가 되고, 기존 논리는 옛 회의 발언을 단다", () => {
    const sp = space();
    const s1 = session(sp, "회의 1", "요약 서비스로 하자");
    commit(sp, s1.id, [{ op: "add", node_id: "n1", node: node("요약 서비스"), source_ids: [s1.src], reason: "" }]);
    const s2 = session(sp, "회의 2", "변화 추적으로 바꾸자");
    commit(sp, s2.id, [{ op: "supersede", node_id: "n1", new_node_id: "n2", node: node("변화 추적"), source_ids: [s2.src], reason: "요약은 겹친다" }], "pending");
    commit(sp, s2.id, [{ op: "add", node_id: "n3", node: { ...node("화면 설계", "action", "open"), owner: "준영" }, source_ids: [s2.src], reason: "" }]);
    rebuildHead(sp.id);

    const v = buildMeetingView(sp.id, s2.id)!;
    expect(v.changes).toHaveLength(1);
    const c = v.changes[0];
    expect(c.from?.title).toBe("요약 서비스");
    expect(c.to.title).toBe("변화 추적");
    expect(c.step).toBe("review");
    expect(c.quotes[0].text).toBe("변화 추적으로 바꾸자");
    expect(c.from?.quote).toMatchObject({ text: "요약 서비스로 하자", sessionTitle: "회의 1" });
    expect(v.todos).toEqual([expect.objectContaining({ title: "화면 설계", owner: "준영" })]);
    expect(v.topics.map((t) => t.topic)).toEqual(["주제"]);
    expect(v.pendingOther).toHaveLength(0); // 바뀐 결정 카드에 이미 확인 버튼이 있다
  });

  it("채택된 의견을 접은 update는 바뀐 결정, 열림 → 채택은 아니다", () => {
    const sp = space();
    const s1 = session(sp, "회의 1", "a");
    commit(sp, s1.id, [
      { op: "add", node_id: "n1", node: node("녹음 버튼", "claim", "adopted"), source_ids: [s1.src], reason: "" },
      { op: "add", node_id: "n2", node: node("붙여넣기", "claim", "open"), source_ids: [s1.src], reason: "" },
    ]);
    const s2 = session(sp, "회의 2", "b");
    commit(sp, s2.id, [
      { op: "update", node_id: "n1", before: { status: "adopted" }, after: { status: "rejected", reject_reason: "품질" }, source_ids: [s2.src], reason: "접음" },
      { op: "update", node_id: "n2", before: { status: "open" }, after: { status: "adopted" }, source_ids: [s2.src], reason: "채택" },
    ]);
    rebuildHead(sp.id);
    const v = buildMeetingView(sp.id, s2.id)!;
    expect(v.changes.map((c) => [c.kind, c.from?.title, c.to.title])).toEqual([["flip", "녹음 버튼", "접기로 함"]]);
    expect(v.changes[0].step).toBe("final");
  });

  it("다른 프로젝트의 회의는 안 보여 준다", () => {
    const a = space();
    const b = space();
    const s = session(a, "회의", "x");
    expect(buildMeetingView(b.id, s.id)).toBeNull();
  });
});

describe("회의 기록 (live_json)", () => {
  it("저장하고 가장 최근 것을 다음 회의 기본값으로 읽는다", () => {
    const sp = space();
    const s1 = session(sp, "회의 1", "x");
    const s2 = session(sp, "회의 2", "y");
    const rec = (p: string[]): LiveRecord => ({ agenda: [], checklist: [{ agenda: "영상", expected: "담당", status: "no_owner" }], participants: p, participation: 7, meety: [] });
    saveLiveRecord(s1.id, rec(["기헌", "준영"]));
    getDb().prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`).run("2099-01-01T00:00:00.000Z", s2.id);
    saveLiveRecord(s2.id, rec(["기헌"]));
    const last = lastLiveSession(sp.id)!;
    expect(last.id).toBe(s2.id);
    expect(last.record.participants).toEqual(["기헌"]);
    expect(liveRecordOf({ live_json: "{깨짐" })).toBeNull();
  });
});

describe("회의 기록 만들기 (liveRecordFrom)", () => {
  it("말함·손 듦·따로 알림·합의 카드만 추리고, 설정 대답(ack)은 뺀다", async () => {
    const { liveRecordFrom } = await import("../src/lib/live/record");
    const ev = (e: object) => ({ at: 0, ev: e });
    const m = {
      agenda: [{ title: "영상", expected: ["순서"] }],
      participants: ["기헌", "준영", "태은"],
      host: "기헌",
      mode: "decision",
      participation: 5,
      roles: {},
      docIds: ["d1"],
      events: [
        ev({ type: "speak", actionId: "a1", kind: "conflict", text: "10월 1일에 정했어요", sentences: [], evidence: [{ label: "회의 1", quote: "q" }] }),
        ev({ type: "speak", actionId: "a1", kind: "conflict", text: "중복", sentences: [], evidence: [] }),
        ev({ type: "speak", actionId: "a2", kind: "ack", text: "네, 조용히 할게요", sentences: [], evidence: [] }),
        ev({ type: "hand_raise", actionId: "a3", kind: "owner_gap", preview: "누가 맡나요?", evidence: [] }),
        ev({ type: "private", actionId: "a4", kind: "quiet_member", to: "태은", text: "덧붙일 생각?", evidence: [] }),
        ev({ type: "change_card", cardId: "c1", title: "영상", from: "3분", to: "5분", evidence: [] }),
      ],
    } as unknown as Parameters<typeof liveRecordFrom>[0];
    const r = liveRecordFrom(m, [{ agenda: "영상", expected: "순서", status: "done", evidence: [{ label: "x", quote: "1번부터" }] }]);
    expect(r.meety.map((x) => [x.channel, x.kind])).toEqual([
      ["speak", "conflict"],
      ["hand", "owner_gap"],
      ["private", "quiet_member"],
      ["card", "card"],
    ]);
    expect(r.meety[2].to).toBe("태은");
    expect(r.checklist[0]).toMatchObject({ status: "done", quote: "1번부터" });
    expect(r.docIds).toEqual(["d1"]);
  });
});
