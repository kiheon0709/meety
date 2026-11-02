// 회의 뒤 정리 화면(uiux-redesign.md §5)이 보는 모양. 이 회의 커밋을 읽어 "바뀐 결정 카드"·안건별 요약·할 일로 나눈다.
// 새 모델 호출은 없다 — 정리 파이프라인이 이미 만든 커밋·HEAD·발화만 쓴다.
import { getCommits, getHead } from "./head";
import { getSession, getSourcesByIds, listApprovals, listSessions } from "./service";
import type { Approval, Change, CommitWithChanges, HeadNode, NodeType, Session, Source } from "./types";

export interface Quote {
  speaker: string;
  text: string;
  sessionTitle?: string;
  heldAt?: string;
}

// 제안 → 확인 → 확정: proposed(한 사람 의견) = 제안, 확인 대기 커밋 = 확인, 적용 = 확정
export type Step = "proposed" | "review" | "final";

export interface ChangeIssue {
  key: string;
  commit: CommitWithChanges;
  topic: string;
  kind: "supersede" | "flip" | "new";
  from?: { title: string; body: string; quote?: Quote };
  to: { title: string; body: string; nodeId: string };
  reason: string;
  quotes: Quote[];
  step: Step;
}

export interface TopicLine {
  nodeId: string;
  type: NodeType;
  title: string;
  status: string;
  changed?: boolean;
}

export interface Todo {
  nodeId: string;
  title: string;
  owner: string | null;
  due: string | null;
  status: string;
}

export interface MeetingView {
  session: Session;
  changes: ChangeIssue[];
  newDecisions: ChangeIssue[];
  pendingOther: CommitWithChanges[];
  topics: { topic: string; lines: TopicLine[] }[];
  todos: Todo[];
  approvals: Approval[];
  rejected: CommitWithChanges[];
}

// 상태가 "있던 것 → 접은 것"으로 뒤집힌 update만 바뀐 결정으로 본다 (열림 → 채택은 새로 정한 것)
const ALIVE = new Set(["agreed", "adopted", "active"]);
const DEAD = new Set(["withdrawn", "rejected", "broken", "superseded"]);

export function buildMeetingView(spaceId: string, sessionId: string): MeetingView | null {
  const session = getSession(sessionId);
  if (!session || session.space_id !== spaceId) return null;
  const commits = getCommits(spaceId, sessionId);
  const live = commits.filter((c) => (c.status === "applied" || c.status === "pending") && !c.reverted);
  const rejected = commits.filter((c) => c.status === "rejected" || c.reverted);
  const head = new Map(getHead(spaceId).map((n) => [n.id, n]));
  const sessions = new Map(listSessions(spaceId).map((s) => [s.id, s]));

  const allIds = [...new Set([...live.flatMap((c) => c.changes.flatMap((ch) => ch.source_ids)), ...[...head.values()].flatMap((n) => n.source_ids)])];
  const sources = new Map(getSourcesByIds(allIds).map((s) => [s.id, s]));
  const quote = (s: Source | undefined): Quote | undefined => {
    if (!s) return undefined;
    const se = s.session_id ? sessions.get(s.session_id) : undefined;
    return { speaker: s.speaker || "자료", text: s.text, sessionTitle: se?.title, heldAt: se?.held_at };
  };
  const quotesOf = (ids: number[]) =>
    ids
      .map((id) => sources.get(id))
      .filter((s): s is Source => !!s)
      .slice(0, 2)
      .map((s) => quote(s)!);
  // 옛 결정을 만든 회의의 발언 (이번 회의 것이 아닌 가장 이른 것)
  const originOf = (n: HeadNode | undefined) => quote(n?.source_ids.map((id) => sources.get(id)).find((s) => s && s.session_id !== sessionId));
  const stepOf = (c: CommitWithChanges, status?: string): Step => (c.status === "pending" ? "review" : status === "proposed" ? "proposed" : "final");

  const changes: ChangeIssue[] = [];
  const newDecisions: ChangeIssue[] = [];
  const inCards = new Set<string>();
  const topicMap = new Map<string, TopicLine[]>();
  const todos = new Map<string, Todo>();
  const line = (topic: string, l: TopicLine) => {
    const t = topic || "기타";
    const arr = topicMap.get(t) ?? [];
    const i = arr.findIndex((x) => x.nodeId === l.nodeId);
    if (i >= 0) arr[i] = { ...arr[i], ...l };
    else arr.push(l);
    topicMap.set(t, arr);
  };

  for (const c of live) {
    for (const ch of c.changes as Change[]) {
      if (ch.op === "supersede") {
        const old = head.get(ch.node_id);
        const cur = head.get(ch.new_node_id);
        changes.push({
          key: `${c.id}/${ch.new_node_id}`,
          commit: c,
          topic: ch.node.topic || old?.topic || "결정",
          kind: "supersede",
          from: old ? { title: old.title, body: old.body, quote: originOf(old) } : undefined,
          to: { title: ch.node.title, body: ch.node.body, nodeId: ch.new_node_id },
          reason: ch.reason,
          quotes: quotesOf(ch.source_ids),
          step: stepOf(c, cur?.status ?? ch.node.status),
        });
        inCards.add(c.id);
        line(ch.node.topic, { nodeId: ch.new_node_id, type: ch.node.type, title: ch.node.title, status: cur?.status ?? ch.node.status, changed: true });
      } else if (ch.op === "update") {
        const n = head.get(ch.node_id);
        if (!n) continue;
        const b = ch.before.status, a = ch.after.status;
        if (b && a && ALIVE.has(b) && DEAD.has(a)) {
          changes.push({
            key: `${c.id}/${ch.node_id}`,
            commit: c,
            topic: n.topic || "결정",
            kind: "flip",
            from: { title: n.title, body: n.body, quote: originOf(n) },
            to: { title: a === "rejected" ? "접기로 함" : a === "withdrawn" ? "철회함" : a === "broken" ? "전제가 깨짐" : "바뀜", body: ch.after.reject_reason ?? "", nodeId: n.id },
            reason: ch.reason,
            quotes: quotesOf(ch.source_ids),
            step: stepOf(c),
          });
          inCards.add(c.id);
        }
        if (n.type === "action") todos.set(n.id, { nodeId: n.id, title: n.title, owner: n.owner, due: n.due ?? null, status: n.status });
        else line(n.topic, { nodeId: n.id, type: n.type, title: n.title, status: n.status, changed: !!(b && a && ALIVE.has(b) && DEAD.has(a)) });
      } else if (ch.op === "add") {
        const n = head.get(ch.node_id);
        const f = { ...ch.node, ...(n ? { status: n.status, owner: n.owner, due: n.due, title: n.title } : {}) };
        if (f.type === "action") {
          todos.set(ch.node_id, { nodeId: ch.node_id, title: f.title, owner: f.owner, due: f.due ?? null, status: f.status });
          continue;
        }
        line(f.topic, { nodeId: ch.node_id, type: f.type, title: f.title, status: f.status });
        if (f.type === "decision") {
          newDecisions.push({
            key: `${c.id}/${ch.node_id}`,
            commit: c,
            topic: f.topic || "결정",
            kind: "new",
            to: { title: f.title, body: f.body, nodeId: ch.node_id },
            reason: ch.reason,
            quotes: quotesOf(ch.source_ids),
            step: stepOf(c, f.status),
          });
          if (c.status === "pending") inCards.add(c.id);
        }
      }
    }
  }

  return {
    session,
    changes,
    newDecisions,
    pendingOther: live.filter((c) => c.status === "pending" && !inCards.has(c.id)),
    topics: [...topicMap.entries()].map(([topic, lines]) => ({ topic, lines })),
    todos: [...todos.values()].sort((a, b) => Number(a.status === "done") - Number(b.status === "done")),
    approvals: listApprovals(live.map((c) => c.id)),
    rejected,
  };
}
