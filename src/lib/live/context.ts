// 맥락 층. 고정 층(회의 시작 때 한 번 만드는 묶음, 캐시됨)과 굴러가는 층(최근 발화 + 그 이전 요약).
import { compactHead, getCommits, getHead } from "../head";
import { getSession, getSourcesByIds, getSpace } from "../service";
import { STATUS_LABEL, TYPE_LABEL, type HeadNode } from "../types";
import type { AgendaItem, DocFact, Evidence } from "./contract";
import { FIXED_FACTS_MAX, factsFor, listDocs } from "./docs";

export interface NodeRef {
  id: string;
  type: HeadNode["type"];
  status: string;
  topic: string;
  title: string;
  body: string;
  owner?: string;
  due?: string; // 할 일의 기한 (YYYY-MM-DD)
  heldAt?: string; // 이 노드가 생긴 회의 날짜
  meeting?: string; // 그 회의 제목
  quote?: string; // 근거 발화 원문
}

export interface ContextBundle {
  spaceName: string;
  nodes: Map<string, NodeRef>;
  facts: Map<string, DocFact>;
  docTitles: Map<string, string>;
  // 사실이 많으면 고정 층엔 안 넣고 발화마다 찾아서 굴러가는 층에 넣는다
  searchFacts: boolean;
  text: string; // 모델에 넣는 고정 층
}

const KEEP_STATUS = new Set(["agreed", "proposed", "open", "adopted", "rejected", "active", "broken"]);

export function buildContext(input: { spaceId: string; title: string; agenda: AgendaItem[]; participants: string[]; docIds: string[] }): ContextBundle {
  const space = getSpace(input.spaceId);
  const head = getHead(input.spaceId);
  const compact = compactHead(head);
  const commitSession = new Map(getCommits(input.spaceId).map((c) => [c.id, c.session_id]));
  const byId = new Map(head.map((n) => [n.id, n]));

  const nodes = new Map<string, NodeRef>();
  for (const c of compact) {
    if (!KEEP_STATUS.has(c.status)) continue;
    const full = byId.get(c.id)!;
    const ses = getSession(commitSession.get(full.created_commit_id) ?? "");
    const src = getSourcesByIds(full.source_ids.slice(0, 1))[0];
    nodes.set(c.id, {
      id: c.id,
      type: c.type,
      status: c.status,
      topic: c.topic,
      title: c.title,
      body: c.body,
      owner: c.owner,
      due: c.due ?? undefined,
      heldAt: ses?.held_at,
      meeting: ses?.title,
      quote: src ? `${src.speaker}: ${src.text}` : undefined,
    });
  }

  const facts = new Map<string, DocFact>();
  for (const f of factsFor(input.docIds)) facts.set(f.id, f);
  const docTitles = new Map(listDocs().filter((d) => input.docIds.includes(d.id)).map((d) => [d.id, d.title]));
  const searchFacts = facts.size > FIXED_FACTS_MAX;

  const lines: string[] = [];
  lines.push(`## 이 회의`, `프로젝트: ${space?.name ?? input.spaceId}`, `제목: ${input.title}`, `참여자: ${input.participants.join(", ") || "(모름)"}`);
  lines.push(``, `## 안건과 기대 산출물`);
  input.agenda.forEach((a, i) => lines.push(`${i + 1}. ${a.title}${a.expected.length ? ` — 나와야 할 것: ${a.expected.join(", ")}` : ""}`));

  const order: HeadNode["type"][] = ["decision", "claim", "question", "action", "assumption", "fact"];
  lines.push(``, `## 팀이 지금까지 정한 것 (기록)`);
  if (!nodes.size) lines.push("(기록 없음)");
  for (const t of order) {
    for (const n of nodes.values()) {
      if (n.type !== t) continue;
      const when = n.heldAt ? ` · ${n.heldAt} ${n.meeting ?? ""}` : "";
      const who = n.owner ? ` · ${n.owner}` : "";
      const due = n.due ? ` · 기한 ${shortDate(n.due)}` : "";
      lines.push(`- [${n.id}] ${TYPE_LABEL[n.type]}(${STATUS_LABEL[n.status] ?? n.status}) · ${n.topic}${who}${due}${when}: ${n.title} — ${n.body}`);
    }
  }
  if (facts.size && !searchFacts) {
    lines.push(``, `## 자료에 적힌 사실`);
    for (const f of facts.values()) lines.push(factLine(f, docTitles));
  }
  return { spaceName: space?.name ?? "", nodes, facts, docTitles, searchFacts, text: lines.join("\n") };
}

// 날짜가 잡힌 할 일(열림): 그 날짜는 팀이 정한 일정이라 어긋남의 근거가 된다 (E2E day2 10/30: 리허설이 결정이 아니라 할 일로 정리됨)
export function isScheduled(n: Pick<NodeRef, "type" | "status" | "due">): boolean {
  return n.type === "action" && n.status === "open" && !!n.due;
}

// 어긋남의 근거가 되는 기록: 합의된 결정, 날짜가 잡힌 할 일
export function isConfirmed(n: Pick<NodeRef, "type" | "status" | "due">): boolean {
  return (n.type === "decision" && n.status === "agreed") || isScheduled(n);
}

export function factLine(f: DocFact, titles: Map<string, string>): string {
  return `- [${f.id}] (${titles.get(f.docId) ?? f.docId} · ${f.loc}) ${f.text}`;
}

function shortDate(d?: string): string {
  if (!d) return "";
  const m = d.match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : d;
}

export function evidenceFor(ctx: ContextBundle, nodeIds: string[], factIds: string[]): Evidence[] {
  const out: Evidence[] = [];
  for (const id of nodeIds) {
    const n = ctx.nodes.get(id);
    if (!n) continue;
    const when = n.heldAt ? `${shortDate(n.heldAt)} 회의` : "기록";
    const who = n.type === "claim" && n.owner ? `${n.owner} 의견 — ` : "";
    out.push({ label: `${when} — ${who}${n.title}`, quote: n.quote, nodeId: n.id });
  }
  for (const id of factIds) {
    const f = ctx.facts.get(id);
    if (!f) continue;
    out.push({ label: `${ctx.docTitles.get(f.docId) ?? "자료"} — ${f.loc}`, quote: f.quote, docId: f.docId, loc: f.loc });
  }
  return out;
}

// ── 굴러가는 층 ─────────────────────────────────────────────
export interface Utt {
  id: number;
  t0: number;
  t1: number;
  text: string;
  speaker?: string;
  echo?: boolean; // 미티가 말하던 동안 들어온 말 (판단에서 뺀다)
  turn?: number; // 말 끝 확률 (음성 서버 Smart Turn, final.turn) — 낮으면 말이 덜 끝났을 수 있다
  receivedAt: number;
}

export const RECENT_SEC = 120;

export function uttLine(u: Utt): string {
  return `#${u.id} ${u.speaker ?? "?"}: ${u.text}`;
}

// 아직 요약 안 된 발화는 원문으로 두고, 그중 2분보다 오래된 것은 요약으로 넘길 후보. 시간은 발화의 t1(회의 시작 기준 초).
export function splitRecent(utts: Utt[], summarizedUpTo: number, recentSec = RECENT_SEC): { recent: Utt[]; toSummarize: Utt[] } {
  if (!utts.length) return { recent: [], toSummarize: [] };
  const nowT = utts[utts.length - 1].t1;
  const recent = utts.filter((u) => u.id > summarizedUpTo);
  return { recent, toSummarize: recent.filter((u) => u.t1 < nowT - recentSec) };
}
