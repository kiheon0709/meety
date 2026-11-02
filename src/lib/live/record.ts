// 회의 끝에 세션에 같이 남기는 미티 회의 기록 (docs/architecture/uiux-redesign.md §8).
// 두뇌가 낸 이벤트를 그대로 훑어 "미티가 한 일"만 추린다 — 판단은 하지 않는다.
import type { LiveRecord } from "../types";
import type { ChecklistItem } from "./contract";
import type { Meeting } from "./meeting";

export function liveRecordFrom(m: Meeting, items: ChecklistItem[]): LiveRecord {
  const meety: LiveRecord["meety"] = [];
  const seen = new Set<string>();
  const ev = (e: { label: string; quote?: string }[] | undefined) => (e ?? []).slice(0, 2).map((x) => ({ label: x.label, ...(x.quote ? { quote: x.quote } : {}) }));
  for (const { ev: e } of m.events) {
    if (e.type === "speak" && e.kind !== "ack" && !seen.has(e.actionId)) {
      seen.add(e.actionId);
      meety.push({ kind: e.kind, channel: "speak", text: e.text, evidence: ev(e.evidence) });
    } else if (e.type === "hand_raise" && !seen.has(e.actionId)) {
      seen.add(e.actionId);
      meety.push({ kind: e.kind, channel: "hand", text: e.preview, evidence: ev(e.evidence) });
    } else if (e.type === "private" && !seen.has(e.actionId)) {
      seen.add(e.actionId);
      meety.push({ kind: e.kind, channel: "private", text: e.text, to: e.to });
    } else if (e.type === "change_card") {
      meety.push({ kind: "card", channel: "card", text: cardText(e), evidence: ev(e.evidence) });
    }
  }
  return {
    agenda: m.agenda,
    checklist: items.map((i) => ({ agenda: i.agenda, expected: i.expected, status: i.status, ...(i.note ? { note: i.note } : {}), ...(i.evidence[0]?.quote ? { quote: i.evidence[0].quote } : {}) })),
    participants: m.participants,
    ...(m.host ? { host: m.host } : {}),
    ...(m.mode ? { mode: m.mode } : {}),
    participation: m.participation,
    roles: m.roles,
    docIds: m.docIds,
    meety,
  };
}

// 합의 카드 한 줄: 제목에 내용이 이미 들어 있으면 한 번만 (11/2 처음부터 시험: "모집 예산: 포스터 인쇄 3만 원 …: 포스터 인쇄 3만 원 …")
export function cardText(c: { title: string; from?: string; to: string }): string {
  const tail = `: ${c.to}`;
  const head = c.title.endsWith(tail) ? c.title.slice(0, -tail.length) : c.title;
  if (head.includes(c.to)) return c.from ? `${head} (전엔 ${c.from})` : head;
  return `${head}: ${c.from ? `${c.from} → ` : ""}${c.to}`;
}
