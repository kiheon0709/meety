// 갈피가 한 일(읽음·반영·버림·물어봄·브리핑)과 사람이 한 일(동의·되돌림·직접 고침)을 한 줄씩 남긴다.
// 홈 피드 = 이 표를 시간순으로 보여주는 것. 알림 = 이 중 특정 멤버에게 가야 하는 것.
import { getDb, newId, now } from "./db";
import type { AgentEvent, EventKind, Member, Notification } from "./types";

export interface LogEventInput {
  space_id: string;
  kind: EventKind;
  actor?: string; // 기본 'agent'
  ref_type?: AgentEvent["ref_type"];
  ref_id?: string | null;
  title: string;
  detail?: string | null;
  notify?: string[]; // 알림을 받을 member id
}

export function logEvent(input: LogEventInput): AgentEvent {
  const db = getDb();
  const e: AgentEvent = {
    id: newId("ev"),
    space_id: input.space_id,
    kind: input.kind,
    actor: input.actor ?? "agent",
    ref_type: input.ref_type ?? null,
    ref_id: input.ref_id ?? null,
    title: input.title,
    detail: input.detail ?? null,
    created_at: now(),
  };
  db.prepare(`INSERT INTO events (id, space_id, kind, actor, ref_type, ref_id, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.id, e.space_id, e.kind, e.actor, e.ref_type, e.ref_id, e.title, e.detail, e.created_at,
  );
  const targets = [...new Set((input.notify ?? []).filter((m) => m && m !== e.actor))];
  if (targets.length) {
    const ins = db.prepare(`INSERT INTO notifications (id, space_id, member_id, event_id, read_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`);
    for (const m of targets) ins.run(newId("nt"), e.space_id, m, e.id, e.created_at);
  }
  return e;
}

export interface FeedItem extends AgentEvent {
  actor_member: Member | null;
}

function withActors(rows: AgentEvent[]): FeedItem[] {
  const ids = [...new Set(rows.map((r) => r.actor).filter((a) => a !== "agent"))];
  const members = ids.length
    ? (getDb().prepare(`SELECT * FROM members WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Member[])
    : [];
  const byId = new Map(members.map((m) => [m.id, m]));
  return rows.map((r) => ({ ...r, actor_member: byId.get(r.actor) ?? null }));
}

export function listFeed(spaceId: string, limit = 60): FeedItem[] {
  const rows = getDb().prepare(`SELECT * FROM events WHERE space_id = ? ORDER BY created_at DESC LIMIT ?`).all(spaceId, limit) as AgentEvent[];
  return withActors(rows);
}

export function listFeedForSpaces(spaceIds: string[], limit = 40): FeedItem[] {
  if (!spaceIds.length) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM events WHERE space_id IN (${spaceIds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`)
    .all(...spaceIds, limit) as AgentEvent[];
  return withActors(rows);
}

export interface NotificationItem extends Notification {
  event: FeedItem;
}

export function listNotifications(memberIds: string[], limit = 30): NotificationItem[] {
  if (!memberIds.length) return [];
  const rows = getDb()
    .prepare(`SELECT n.*, e.id AS e_id FROM notifications n JOIN events e ON e.id = n.event_id WHERE n.member_id IN (${memberIds.map(() => "?").join(",")}) ORDER BY n.created_at DESC LIMIT ?`)
    .all(...memberIds, limit) as (Notification & { e_id: string })[];
  const evIds = rows.map((r) => r.e_id);
  const events = evIds.length ? (getDb().prepare(`SELECT * FROM events WHERE id IN (${evIds.map(() => "?").join(",")})`).all(...evIds) as AgentEvent[]) : [];
  const feed = new Map(withActors(events).map((e) => [e.id, e]));
  return rows.map(({ e_id, ...n }) => ({ ...n, event: feed.get(e_id)! })).filter((n) => n.event);
}

export function countUnread(memberIds: string[]): number {
  if (!memberIds.length) return 0;
  const r = getDb().prepare(`SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND member_id IN (${memberIds.map(() => "?").join(",")})`).get(...memberIds) as { n: number };
  return r.n;
}

export function markAllRead(memberIds: string[]): void {
  if (!memberIds.length) return;
  getDb().prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND member_id IN (${memberIds.map(() => "?").join(",")})`).run(now(), ...memberIds);
}

// 받침 유무로 "이/가", "은/는" 고르기. 이름 뒤에 붙는 조사.
export function josa(word: string, pair: "이/가" | "은/는" | "을/를" | "과/와"): string {
  const last = word.charCodeAt(word.length - 1);
  const hasBatchim = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 !== 0 : false;
  const [a, b] = pair.split("/");
  return word + (hasBatchim ? a : b);
}
