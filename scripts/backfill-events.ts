// v0.4 이전에 처리된 스페이스에 갈피 활동 기록(events)을 소급해서 만든다. 이미 기록이 있는 스페이스는 건너뜀.
//   npx tsx scripts/backfill-events.ts   (dev 서버는 끄고)
import "./env";
import { getDb } from "../src/lib/db";
import { getCommits } from "../src/lib/head";
import { getBriefing, listMembers, listSessions, listSpaces } from "../src/lib/service";
import { logEvent } from "../src/lib/events";
import type { AgentEvent } from "../src/lib/types";

const db = getDb();
const setTime = (e: AgentEvent, iso: string) => db.prepare(`UPDATE events SET created_at = ? WHERE id = ?`).run(iso, e.id);

for (const sp of listSpaces()) {
  const has = (db.prepare(`SELECT COUNT(*) n FROM events WHERE space_id = ?`).get(sp.id) as { n: number }).n;
  if (has) {
    console.log(`${sp.name}: 이미 기록 ${has}개, 건너뜀`);
    continue;
  }
  const members = listMembers(sp.id);
  const everyone = members.map((m) => m.id);
  let made = 0;
  for (const s of listSessions(sp.id, "meeting")) {
    if (s.status !== "done") continue;
    // 회의 당일 저녁에 정리한 것으로 시각을 맞춘다 (실제 처리 시각은 시드 시점이라 의미가 없음).
    const base = new Date(`${s.held_at}T19:00:00+09:00`).getTime();
    let k = 0;
    const at = () => new Date(base + k++ * 15000).toISOString();
    const commits = getCommits(sp.id, s.id).filter((c) => !c.reverted && c.status !== "rejected");
    const n = (db.prepare(`SELECT COUNT(*) n FROM sources WHERE session_id = ?`).get(s.id) as { n: number }).n;
    const topics = s.topics_json ? (JSON.parse(s.topics_json) as { topics: string[] }).topics : [];
    setTime(logEvent({ space_id: sp.id, kind: "read", ref_type: "session", ref_id: s.id, title: `"${s.title}" ${n}마디를 읽었어요`, detail: topics.length ? `주제: ${topics.join(" · ")}` : null }), at());
    const applied = commits.filter((c) => c.status === "applied");
    const asked = commits.filter((c) => c.status === "pending");
    if (applied.length) setTime(logEvent({ space_id: sp.id, kind: "applied", ref_type: "session", ref_id: s.id, title: `업데이트 ${applied.length}개를 맥락에 반영했어요`, detail: applied.map((c) => c.message).join("\n") }), at());
    for (const c of asked) setTime(logEvent({ space_id: sp.id, kind: "asked", ref_type: "commit", ref_id: c.id, title: `한 번 봐주세요: ${c.message}`, detail: c.review_reason ? `${c.review_reason} 반대가 없으면 그대로 확정할게요.` : null, notify: everyone }), at());
    const usage = s.usage_json ? (JSON.parse(s.usage_json) as { skipped?: string[] }) : null;
    const dropped = (usage?.skipped ?? []).filter((x) => x.startsWith("검수에서 버림") || x.startsWith("출처 없음"));
    if (dropped.length) setTime(logEvent({ space_id: sp.id, kind: "dropped", ref_type: "session", ref_id: s.id, title: `${dropped.length}개는 근거가 약하거나 중복이라 버렸어요`, detail: dropped.map((d) => d.replace(/^검수에서 버림: |^출처 없음: /, "")).join("\n") }), at());
    for (const c of commits) for (const ch of c.changes) {
      if (ch.op !== "add" || ch.node.type !== "action" || !ch.node.owner) continue;
      const owner = members.find((m) => m.name === ch.node.owner);
      setTime(logEvent({ space_id: sp.id, kind: "todo", ref_type: "node", ref_id: ch.node_id, title: `${ch.node.owner} 담당 할 일이 생겼어요: ${ch.node.title}`, detail: ch.node.body || null, notify: owner ? [owner.id] : [] }), at());
    }
    made += k;
    const last = listSessions(sp.id, "meeting").filter((x) => x.status === "done").at(-1);
    const b = getBriefing(sp.id);
    if (b && last?.id === s.id) setTime(logEvent({ space_id: sp.id, kind: "briefing", ref_type: "briefing", ref_id: sp.id, title: "다음 회의 전 브리핑을 새로 썼어요", detail: null }), at());
  }
  // 알림 시각도 이벤트 시각으로
  db.prepare(`UPDATE notifications SET created_at = (SELECT created_at FROM events WHERE events.id = notifications.event_id) WHERE space_id = ?`).run(sp.id);
  console.log(`${sp.name}: 기록 ${made}개 생성`);
}
