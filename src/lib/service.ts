// 서버 액션과 CLI 스크립트가 같이 쓰는 핵심 로직. React/Next 의존 없음.
import { getDb, newId, now } from "./db";
import { compactHead, getCommits, getHead, rebuildHead } from "./head";
import { addUsage, answerQuestion, extractCommits, extractTopics, generateBriefing, interpretFix, interpretTell, verifyCommits, type AgentChange, type AgentCommit, type Usage } from "./agent";
import { parseTranscript, speakersOf } from "./transcript";
import { josa, logEvent } from "./events";
import { APP_URL, postDiscordLater } from "./notify";
import { setDiscordWebhook } from "./integrations/connections";
import {
  NODE_STATUSES,
  type Approval,
  type ApprovalMode,
  type Change,
  type Comment,
  type HeadNode,
  type LiveRecord,
  type Member,
  type NodeFields,
  type Session,
  type Source,
  type Space,
  type Stage,
  type User,
} from "./types";

// ---------- Space ----------

export function listSpaces(): Space[] {
  return getDb().prepare(`SELECT * FROM spaces ORDER BY created_at ASC`).all() as Space[];
}

export function getSpace(id: string): Space | undefined {
  return getDb().prepare(`SELECT * FROM spaces WHERE id = ?`).get(id) as Space | undefined;
}

export function createSpace(name: string, owner?: { name: string; user_id?: string }, isDemo = false): Space {
  const s: Space = { id: newId("sp"), name, next_node_seq: 1, approval_mode: "any", approval_count: 1, review_hours: 48, discord_webhook: null, is_demo: isDemo ? 1 : 0, created_at: now() };
  getDb().prepare(`INSERT INTO spaces (id, name, next_node_seq, is_demo, created_at) VALUES (?, ?, ?, ?, ?)`).run(s.id, s.name, 1, s.is_demo, s.created_at);
  if (owner) addMember(s.id, owner.name, "owner", owner.user_id);
  return s;
}

export function listDemoSpaces(): Space[] {
  return getDb().prepare(`SELECT * FROM spaces WHERE is_demo = 1 ORDER BY created_at ASC`).all() as Space[];
}

// 로그인한 유저가 멤버인 스페이스
export function listSpacesForUser(userId: string): Space[] {
  return getDb()
    .prepare(`SELECT s.* FROM spaces s JOIN members m ON m.space_id = s.id WHERE m.user_id = ? ORDER BY s.created_at ASC`)
    .all(userId) as Space[];
}

export function updateSpaceSettings(id: string, patch: { name?: string; approval_mode?: ApprovalMode; approval_count?: number; review_hours?: number; discord_webhook?: string | null }): void {
  const db = getDb();
  // 디스코드 웹훅은 평문 칸이 아니라 연결(암호화)에 둔다 (security.md ⑩). null = 끊기, undefined = 그대로
  if (patch.discord_webhook !== undefined) setDiscordWebhook(id, patch.discord_webhook);
  if (patch.name) db.prepare(`UPDATE spaces SET name = ? WHERE id = ?`).run(patch.name, id);
  if (patch.approval_mode) db.prepare(`UPDATE spaces SET approval_mode = ? WHERE id = ?`).run(patch.approval_mode, id);
  if (patch.approval_count) db.prepare(`UPDATE spaces SET approval_count = ? WHERE id = ?`).run(patch.approval_count, id);
  if (patch.review_hours !== undefined && Number.isFinite(patch.review_hours)) db.prepare(`UPDATE spaces SET review_hours = ? WHERE id = ?`).run(Math.max(0, Math.round(patch.review_hours)), id);
}

// 확인 대기 업데이트의 자동 확정 시각. review_hours가 0이면 자동 확정 없음(null).
export function reviewDeadline(space: Space, from = Date.now()): string | null {
  const h = Number(space.review_hours ?? 48);
  return h > 0 ? new Date(from + h * 3600_000).toISOString() : null;
}

// ---------- Members ----------

const COLORS = ["sky", "violet", "emerald", "amber", "rose", "teal", "indigo", "orange"];

export function listMembers(spaceId: string): Member[] {
  return getDb().prepare(`SELECT * FROM members WHERE space_id = ? ORDER BY created_at ASC`).all(spaceId) as Member[];
}

export function getMember(id: string): Member | undefined {
  return getDb().prepare(`SELECT * FROM members WHERE id = ?`).get(id) as Member | undefined;
}

export function findMemberByName(spaceId: string, name: string): Member | undefined {
  return getDb().prepare(`SELECT * FROM members WHERE space_id = ? AND name = ?`).get(spaceId, name) as Member | undefined;
}

export function addMember(spaceId: string, name: string, role: "owner" | "member" = "member", userId?: string): Member {
  const existing = findMemberByName(spaceId, name);
  if (existing) {
    if (userId && !existing.user_id) linkMemberToUser(existing.id, userId);
    return existing;
  }
  const count = listMembers(spaceId).length;
  const m: Member = { id: newId("m"), space_id: spaceId, user_id: userId ?? null, name, role, is_decider: role === "owner" ? 1 : 0, color: COLORS[count % COLORS.length], created_at: now() };
  getDb()
    .prepare(`INSERT INTO members (id, space_id, user_id, name, role, is_decider, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(m.id, m.space_id, m.user_id, m.name, m.role, m.is_decider, m.color, m.created_at);
  return m;
}

// "녹취 속 이 이름이 나예요" — 미연결 멤버를 계정에 연결
export function linkMemberToUser(memberId: string, userId: string | null): void {
  getDb().prepare(`UPDATE members SET user_id = ? WHERE id = ?`).run(userId, memberId);
}

export function listMembersForUser(userId: string): Member[] {
  return getDb().prepare(`SELECT * FROM members WHERE user_id = ?`).all(userId) as Member[];
}

export function memberForUser(spaceId: string, userId: string): Member | undefined {
  return getDb().prepare(`SELECT * FROM members WHERE space_id = ? AND user_id = ?`).get(spaceId, userId) as Member | undefined;
}

// ---------- Invites ----------

export function getOrCreateInvite(spaceId: string, createdBy?: string): string {
  const db = getDb();
  const row = db.prepare(`SELECT token FROM invites WHERE space_id = ? ORDER BY created_at DESC LIMIT 1`).get(spaceId) as { token: string } | undefined;
  if (row) return row.token;
  const token = newId("inv") + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO invites (token, space_id, created_by, created_at) VALUES (?, ?, ?, ?)`).run(token, spaceId, createdBy ?? null, now());
  return token;
}

export function getInvite(token: string): { space_id: string } | undefined {
  return getDb().prepare(`SELECT space_id FROM invites WHERE token = ?`).get(token) as { space_id: string } | undefined;
}

export function joinSpace(spaceId: string, user: User): Member {
  const existing = memberForUser(spaceId, user.id);
  if (existing) return existing;
  return addMember(spaceId, user.name, "member", user.id);
}


export function removeMember(memberId: string): void {
  getDb().prepare(`DELETE FROM members WHERE id = ?`).run(memberId);
}

// 녹취의 화자 이름으로 멤버를 자동 등록 (초대 없이 데모가 돌아가도록)
function ensureMembersFromSpeakers(spaceId: string, speakers: string[]) {
  for (const s of speakers) if (s && s !== "?") addMember(spaceId, s);
}

// ---------- Sessions / Sources ----------

export function listSessions(spaceId: string, kind?: "meeting" | "discussion"): Session[] {
  return (
    kind
      ? getDb().prepare(`SELECT * FROM sessions WHERE space_id = ? AND kind = ? ORDER BY held_at ASC, created_at ASC`).all(spaceId, kind)
      : getDb().prepare(`SELECT * FROM sessions WHERE space_id = ? ORDER BY held_at ASC, created_at ASC`).all(spaceId)
  ) as Session[];
}

export function getSession(id: string): Session | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Session | undefined;
}

// 미티와 한 회의의 기록 (회의 끝에 두뇌가 남김). 화면은 읽기만 한다
export function saveLiveRecord(sessionId: string, rec: LiveRecord): void {
  getDb().prepare(`UPDATE sessions SET live_json = ? WHERE id = ?`).run(JSON.stringify(rec), sessionId);
}

export function liveRecordOf(s: Pick<Session, "live_json"> | undefined): LiveRecord | null {
  if (!s?.live_json) return null;
  try {
    return JSON.parse(s.live_json) as LiveRecord;
  } catch {
    return null;
  }
}

// 다음 회의 준비의 기본값: 이 프로젝트에서 가장 최근에 미티와 한 회의
export function lastLiveSession(spaceId: string): (Session & { record: LiveRecord }) | undefined {
  const s = getDb().prepare(`SELECT * FROM sessions WHERE space_id = ? AND live_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(spaceId) as Session | undefined;
  const record = liveRecordOf(s);
  return s && record ? { ...s, record } : undefined;
}

export function getSources(sessionId: string): Source[] {
  return getDb().prepare(`SELECT * FROM sources WHERE session_id = ? ORDER BY idx ASC`).all(sessionId) as Source[];
}

export function getSourcesByIds(ids: number[]): Source[] {
  if (!ids.length) return [];
  const q = `SELECT * FROM sources WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY session_id, idx`;
  return getDb().prepare(q).all(...ids) as Source[];
}

export function createSession(spaceId: string, title: string, heldAt: string, transcript: string): Session {
  const utts = parseTranscript(transcript);
  if (!utts.length) throw new Error("녹취에서 말을 찾지 못했습니다. '이름: 내용' 형식인지 확인하세요.");
  return createSessionFromUtterances(spaceId, title, heldAt, transcript, utts);
}

export function createSessionFromUtterances(spaceId: string, title: string, heldAt: string, transcript: string, utts: { idx: number; speaker: string; text: string }[]): Session {
  const speakers = speakersOf(utts);
  const s: Session = {
    id: newId("se"),
    space_id: spaceId,
    title,
    held_at: heldAt,
    participants: speakers.join(", "),
    transcript,
    status: "pending",
    kind: "meeting",
    stage: null,
    stage_detail: null,
    topics_json: null,
    error: null,
    usage_json: null,
    created_at: now(),
  };
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, space_id, title, held_at, participants, transcript, status, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'meeting', ?)`,
    ).run(s.id, s.space_id, s.title, s.held_at, s.participants, s.transcript, s.created_at);
    const ins = db.prepare(`INSERT INTO sources (session_id, idx, speaker, text, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const u of utts) ins.run(s.id, u.idx, u.speaker, u.text, s.created_at, s.space_id);
  })();
  ensureMembersFromSpeakers(spaceId, speakers);
  return s;
}

// 회의 밖 논의(댓글·수동 변경)의 원천을 담는 세션. 스페이스당 하나.
export function ensureDiscussionSession(spaceId: string): Session {
  const db = getDb();
  const found = db.prepare(`SELECT * FROM sessions WHERE space_id = ? AND kind = 'discussion'`).get(spaceId) as Session | undefined;
  if (found) return found;
  const s: Session = {
    id: newId("se"),
    space_id: spaceId,
    title: "회의 밖 논의",
    held_at: now().slice(0, 10),
    participants: "",
    transcript: "",
    status: "done",
    kind: "discussion",
    stage: null,
    stage_detail: null,
    topics_json: null,
    error: null,
    usage_json: null,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO sessions (id, space_id, title, held_at, participants, transcript, status, kind, created_at) VALUES (?, ?, ?, ?, '', '', 'done', 'discussion', ?)`,
  ).run(s.id, s.space_id, s.title, s.held_at, s.created_at);
  return s;
}

function addDiscussionSource(spaceId: string, speaker: string, text: string): number {
  const db = getDb();
  const ses = ensureDiscussionSession(spaceId);
  const next = (db.prepare(`SELECT COALESCE(MAX(idx), 0) + 1 AS n FROM sources WHERE session_id = ?`).get(ses.id) as { n: number }).n;
  const r = db.prepare(`INSERT INTO sources (session_id, idx, speaker, text, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?)`).run(ses.id, next, speaker, text, now(), spaceId);
  return Number(r.lastInsertRowid);
}

// ---------- Processing (agent pipeline) ----------

export interface ProcessResult {
  commits: number;
  pending: number;
  changes: number;
  skipped: string[];
  usage: Usage;
}

function setStage(sessionId: string, stage: Stage, detail?: string) {
  getDb().prepare(`UPDATE sessions SET stage = ?, stage_detail = ? WHERE id = ?`).run(stage, detail ?? null, sessionId);
}

// 화면이 바로 "정리 중"을 보이도록, 파이프라인 시작 전에 상태를 먼저 찍는다.
export function markQueued(sessionId: string) {
  getDb().prepare(`UPDATE sessions SET status = 'processing', stage = 'queued', stage_detail = NULL, error = NULL WHERE id = ? AND status != 'done'`).run(sessionId);
}

export function getStage(sessionId: string): { status: string; stage: Stage | null; stage_detail: string | null; error: string | null } | undefined {
  return getDb().prepare(`SELECT status, stage, stage_detail, error FROM sessions WHERE id = ?`).get(sessionId) as
    | { status: string; stage: Stage | null; stage_detail: string | null; error: string | null }
    | undefined;
}

// 세션 처리: ① 주제 → ② 추출 → ③ 검증 → ④ 저장(HEAD 재생) → ⑤ 브리핑. 각 단계가 sessions.stage 에 기록돼 화면이 폴링한다.
declare global {
  var __galpiProcessing: Set<string> | undefined;
}
const processingSpaces = (globalThis.__galpiProcessing ??= new Set());

export async function processSession(sessionId: string): Promise<ProcessResult> {
  const db = getDb();
  const session = getSession(sessionId);
  if (!session) throw new Error("세션 없음");
  if (session.status === "done") throw new Error("이미 처리된 세션");
  // 같은 프로젝트의 두 회의를 동시에 정리하면 항목 번호가 겹친다. 하나씩.
  if (processingSpaces.has(session.space_id)) {
    const other = db.prepare(`SELECT title FROM sessions WHERE space_id = ? AND status = 'processing' AND id != ?`).get(session.space_id, sessionId) as { title: string } | undefined;
    throw new Error(`"${other?.title ?? "다른 회의"}"를 정리하는 중이에요. 끝나면 다시 눌러 주세요.`);
  }
  processingSpaces.add(session.space_id);
  db.prepare(`UPDATE sessions SET status = 'processing', error = NULL WHERE id = ?`).run(sessionId);
  setStage(sessionId, "queued", "잠시만요");

  try {
    const sources = getSources(sessionId);
    const utterances = sources.map((s) => ({ idx: s.idx, speaker: s.speaker, text: s.text }));
    // 회의 사이에 화면에 남긴 댓글도 발화로 같이 읽는다 (번호는 회의 발화 뒤로 이어서).
    const comments = listUnconsumedComments(session.space_id);
    const commentsFrom = comments.length ? utterances.length + 1 : undefined;
    const commentUtts = comments.map((c, i) => ({ idx: utterances.length + 1 + i, speaker: c.speaker, text: `(회의 사이에 "${c.node_title}"에 남긴 댓글) ${c.text}` }));
    const allUtts = [...utterances, ...commentUtts];

    // ① 주제 파악 (Haiku)
    setStage(sessionId, "topics", `${utterances.length}마디${comments.length ? ` · 댓글 ${comments.length}개` : ""} 읽는 중`);
    const t = await extractTopics(allUtts);
    db.prepare(`UPDATE sessions SET topics_json = ? WHERE id = ?`).run(JSON.stringify({ topics: t.topics, one_line: t.one_line }), sessionId);
    let usage = t.usage;
    logEvent({
      space_id: session.space_id,
      kind: "read",
      ref_type: "session",
      ref_id: sessionId,
      title: `"${session.title}" ${utterances.length}마디${comments.length ? `와 댓글 ${comments.length}개` : ""}를 읽었어요`,
      detail: t.topics.length ? `주제: ${t.topics.join(" · ")}` : null,
    });

    // 재논의 감지: 이번 회의 주제가 이미 정한 안건·바뀐 결정의 주제와 겹치면 먼저 알려준다 (모델 호출 없음).
    noteRevisits(session.space_id, sessionId, session.title, t.topics);

    // ②~④ 조각 단위로: 긴 녹취(150마디 초과)는 나눠서, 앞 조각을 저장·재생한 뒤 다음 조각이 그 HEAD를 본다.
    const chunks = splitUtterances(allUtts, 150);
    const idxToId = new Map<number, number>(sources.map((s) => [s.idx, s.id]));
    for (const [i, c] of comments.entries()) if (c.source_id) idxToId.set(utterances.length + 1 + i, c.source_id);
    const skipped: string[] = [];
    const savedCommits: SavedCommit[] = [];
    let pending = 0;
    let saved = 0;
    let changeCount = 0;
    const topicSet = new Set(t.topics.map((x) => x.replace(/\s/g, "")));
    for (const [ci, chunk] of chunks.entries()) {
      const part = chunks.length > 1 ? ` (${ci + 1}/${chunks.length} 조각)` : "";
      // HEAD는 주제와 겹치는 노드 + 열린 안건·할 일을 우선 (전체가 작으면 전부)
      const head = getHead(session.space_id);
      const compact = compactHead(head);
      const related = compact.length > 60 ? compact.filter((n) => topicSet.has(n.topic.replace(/\s/g, "")) || n.status === "open" || n.type === "decision") : compact;
      setStage(sessionId, "extract", `주제 ${t.topics.slice(0, 4).join(" · ")}${t.topics.length > 4 ? " …" : ""} · 지난 맥락 ${related.length}개와 견주는 중${part}`);
      const ex = await extractCommits({ head: related, utterances: chunk, sessionTitle: session.title, heldAt: session.held_at, commentsFrom });
      usage = addUsage(usage, ex.usage);

      // ③ 자기검증 (Sonnet)
      setStage(sessionId, "verify", `업데이트 후보 ${ex.commits.length}개 검수 중${part}`);
      const v = await verifyCommits({ head: related, utterances: chunk, commits: ex.commits, heldAt: session.held_at });
      usage = addUsage(usage, v.usage);
      skipped.push(...v.dropped.map((d) => `검수에서 버림: ${d}`));
      promoteAgreed(v.commits, chunk);

      // ④ 저장
      setStage(sessionId, "save", `업데이트 ${v.commits.length}개 반영 중${part}`);
      const space = getSpace(session.space_id)!;
      const saver = makeCommitSaver(space, head, idxToId, skipped);
      const r = saver.saveAll(v.commits, sessionId);
      savedCommits.push(...r.savedCommits);
      pending += r.pending;
      saved += r.saved;
      changeCount += r.changeCount;
      if (chunks.length > 1) rebuildHead(session.space_id);
    }
    if (comments.length) markCommentsConsumed(comments.map((c) => c.id), sessionId);
    rebuildHead(session.space_id);
    logSaveEvents(session.space_id, sessionId, savedCommits, skipped);

    // ⑤ 브리핑 갱신 (실패해도 처리는 성공)
    setStage(sessionId, "briefing", "다음 회의 브리핑 쓰는 중");
    try {
      const b = await refreshBriefing(session.space_id);
      const bu = b.usage_json ? (JSON.parse(b.usage_json) as Usage) : null;
      if (bu) usage = addUsage(usage, bu);
    } catch (e) {
      skipped.push(`브리핑 실패: ${e instanceof Error ? e.message : String(e)}`);
    }

    db.prepare(`UPDATE sessions SET status = 'done', usage_json = ? WHERE id = ?`).run(JSON.stringify({ ...usage, skipped }), sessionId);
    setStage(sessionId, "done", `업데이트 ${saved}개 · 한 번 봐주세요 ${pending}개`);
    postDiscordLater(session.space_id, {
      title: `"${session.title}" 정리했어요 — 달라진 점 ${saved}개${pending ? ` · 한 번 봐주세요 ${pending}개` : ""}`,
      lines: savedCommits.map((c) => `${c.pending ? "⚠️ " : "• "}${c.message}`),
      url: `${APP_URL}/s/${session.space_id}/sessions/${sessionId}`,
      tone: pending ? "orange" : "blue",
    });
    return { commits: saved, pending, changes: changeCount, skipped, usage };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(`UPDATE sessions SET status = 'error', error = ? WHERE id = ?`).run(msg, sessionId);
    setStage(sessionId, "error", msg);
    logEvent({ space_id: session.space_id, kind: "error", ref_type: "session", ref_id: sessionId, title: `"${session.title}" 정리하다가 멈췄어요`, detail: msg });
    throw e;
  } finally {
    processingSpaces.delete(session.space_id);
  }
}

// 이번 회의 주제 중 "이미 정한 것"과 겹치는 주제를 찾아 "○월 ○일에 정했던 거예요"라고 남긴다.
function noteRevisits(spaceId: string, sessionId: string, sessionTitle: string, topics: string[]) {
  if (!topics.length) return;
  const norm = (s: string) => s.replace(/\s/g, "");
  const head = getHead(spaceId);
  const settled = head.filter((n) => (n.type === "question" && n.status === "resolved") || (n.type === "decision" && n.status === "superseded"));
  if (!settled.length) return;
  const sessions = new Map(listSessions(spaceId).map((s) => [s.id, s]));
  const commits = new Map(getCommits(spaceId).map((c) => [c.id, c]));
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const tp of topics) {
    const key = norm(tp);
    for (const n of settled) {
      const nt = norm(n.topic);
      if (!nt || seen.has(n.id)) continue;
      if (nt === key || (key.length >= 2 && (nt.includes(key) || key.includes(nt)))) {
        seen.add(n.id);
        const when = sessions.get(commits.get(n.updated_commit_id)?.session_id ?? "")?.held_at;
        hits.push(`${n.type === "question" ? "안건" : "결정"} "${n.title}" — ${when ? `${Number(when.slice(5, 7))}월 ${Number(when.slice(8, 10))}일에 ` : ""}${n.type === "question" ? "정리됐어요" : "바뀌었어요"}`);
      }
    }
  }
  if (!hits.length) return;
  logEvent({
    space_id: spaceId,
    kind: "read",
    ref_type: "session",
    ref_id: sessionId,
    title: `"${sessionTitle}"에서 전에 정했던 주제가 다시 나왔어요`,
    detail: hits.slice(0, 5).join("\n"),
  });
}

// 긴 녹취를 조각으로. 화자가 바뀌는 지점에서 자르고, 각 조각이 비슷한 길이가 되게 한다.
// 제안 상태 결정 바로 뒤(2마디 안)에 다른 사람이 분명히 동의하면 합의로 올린다. 정리 모델이 이걸 실행마다 다르게
// 판단해서(시나리오 A "리허설은 일요일 저녁" → "좋아요, 일요일 저녁으로 하죠") 코드로 고정한다. 동의 발화는 근거에 더한다.
// 화자를 모르는 발화("?")는 다른 사람으로 본다 — "좋아요, …로 하죠"를 제안한 사람이 스스로 하는 일은 드물다.
const AGREE = /^(네|넵|예|좋아요|좋습니다|좋아|그래요|그래|그러죠|그렇게 (하죠|해요|하자|합시다)|그걸로 (하죠|하자|해요|가죠)|동의(해요|합니다)?|찬성(이요|입니다)?)(?=$|[\s,.!~])/;
const NOT_AGREE = /(근데|그런데|하지만|아니|말고|별로|글쎄|반대|대신)/;
export function promoteAgreed(commits: AgentCommit[], utterances: { idx: number; speaker: string; text: string }[]): number {
  const byIdx = new Map(utterances.map((u, i) => [u.idx, i]));
  let promoted = 0;
  for (const c of commits) {
    for (const ch of c.changes) {
      if ((ch.op !== "add" && ch.op !== "supersede") || ch.node?.type !== "decision" || ch.node.status !== "proposed") continue;
      const pos = ch.source_idxs.map((i) => byIdx.get(i)).filter((x): x is number => x !== undefined);
      if (!pos.length) continue;
      const proposers = new Set(pos.map((p) => utterances[p].speaker).filter((s) => s && s !== "?"));
      const last = Math.max(...pos);
      for (const u of utterances.slice(last + 1, last + 3)) {
        const t = u.text.trim();
        const known = u.speaker && u.speaker !== "?";
        if (known && proposers.has(u.speaker)) continue;
        if (!AGREE.test(t) || NOT_AGREE.test(t)) continue;
        ch.node.status = "agreed";
        if (!ch.source_idxs.includes(u.idx)) ch.source_idxs.push(u.idx);
        promoted++;
        break;
      }
    }
  }
  return promoted;
}

export function splitUtterances<T extends { speaker: string }>(utts: T[], max: number): T[][] {
  if (utts.length <= max) return [utts];
  const n = Math.ceil(utts.length / max);
  const target = Math.ceil(utts.length / n);
  const out: T[][] = [];
  let cur: T[] = [];
  for (let i = 0; i < utts.length; i++) {
    cur.push(utts[i]);
    const next = utts[i + 1];
    if (cur.length >= target && (!next || next.speaker !== utts[i].speaker) && out.length < n - 1) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface SavedCommit {
  id: string;
  message: string;
  pending: boolean;
  review_reason: string | null;
  changes: Change[];
}

// 에이전트 출력(AgentCommit[])을 검사해 commits 테이블에 넣는다. 파이프라인과 "갈피에게 말하기"가 같이 쓴다.
// - 근거 발화 없음 / HEAD에 없는 노드 / 허용 안 되는 상태 → 버리고 skipped에 이유
// - 게이트(needs_review) 또는 낮은 확신 → 확인 대기 + 자동 확정 기한
function makeCommitSaver(space: Space, head: HeadNode[], idxToId: Map<number, number>, skipped: string[]) {
  const db = getDb();
  const headIds = new Map(head.map((n) => [n.id, n]));
  let seqNode = space.next_node_seq;
  const nextNodeId = () => `n${seqNode++}`;
  const skip = (msg: string) => {
    skipped.push(msg);
    return null;
  };
  const toChange = (c: AgentChange): Change | null => {
      const sourceIds = c.source_idxs.map((i) => idxToId.get(i)).filter((x): x is number => typeof x === "number");
      if (!sourceIds.length) return skip(`출처 없음: ${c.op} ${c.node?.title ?? c.node_id ?? ""}`);
      if (c.op === "add") {
        if (!c.node) return skip(`add에 node 없음`);
        return { op: "add", node_id: nextNodeId(), node: normalizeNode(c.node), source_ids: sourceIds, reason: c.reason };
      }
      const target = c.node_id ? headIds.get(c.node_id) : undefined;
      if (!target) return skip(`${c.op}: HEAD에 없는 노드 ${c.node_id}`);
      if (c.op === "update") {
        if (!c.patch) return skip(`update에 patch 없음 (${c.node_id})`);
        const after: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        for (const k of ["title", "body", "topic", "owner", "status", "due", "reject_reason"] as const) {
          const val = c.patch[k];
          if (val === null || val === undefined) continue;
          if (k === "status" && !NODE_STATUSES[target.type].includes(val)) {
            skipped.push(`허용 안 되는 상태 ${target.type}:${val} (${c.node_id})`);
            continue;
          }
          after[k] = val;
          before[k] = (target as unknown as Record<string, unknown>)[k] ?? null;
        }
        if (!Object.keys(after).length) return skip(`update에 유효한 변경 없음 (${c.node_id})`);
        return { op: "update", node_id: target.id, before, after, source_ids: sourceIds, reason: c.reason };
      }
      if (c.op === "supersede") {
        if (!c.node) return skip(`supersede에 node 없음 (${c.node_id})`);
        return { op: "supersede", node_id: target.id, new_node_id: nextNodeId(), node: normalizeNode(c.node), source_ids: sourceIds, reason: c.reason };
      }
      return { op: "withdraw", node_id: target.id, source_ids: sourceIds, reason: c.reason };
    };

  // 합의된(agreed) 결정을 대체·철회하거나, 상태·제목·내용을 바꾸는 변경인가
  const touchesAgreed = (ch: Change): boolean => {
    if (ch.op === "add") return false;
    const target = headIds.get(ch.node_id);
    if (!target || target.type !== "decision" || target.status !== "agreed") return false;
    if (ch.op === "update") return ["status", "title", "body"].some((k) => k in ch.after);
    return true;
  };

  const saveAll = (commits: AgentCommit[], sessionId: string, authorMemberId?: string) => {
    const savedCommits: SavedCommit[] = [];
    let changeCount = 0;
    let pending = 0;
    let saved = 0;
    db.transaction(() => {
      let seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM commits WHERE space_id = ?`).get(space.id) as { m: number }).m;
      for (const ac of commits) {
        const changes = ac.changes.map(toChange).filter((x): x is Change => x !== null);
        if (!changes.length) {
          skipped.push(`빈 업데이트 버림: ${ac.message}`);
          continue;
        }
        seq += 1;
        saved += 1;
        changeCount += changes.length;
        // 게이트 2조건 외에, 모델 스스로 확신이 낮다고 한 커밋도 한 번 봐달라고 한다.
        const lowConf = typeof ac.confidence === "number" && ac.confidence < 0.6;
        // 합의된 결정을 뒤집는 변경은 모델이 needs_review를 빼도 코드가 무조건 검토로 둔다 (S9 V3)
        const overturns = changes.some(touchesAgreed);
        const needsReview = !!ac.needs_review || lowConf || overturns;
        if (needsReview) pending += 1;
        const reason = ac.needs_review ? ac.review_reason : overturns ? "같이 정한 결정을 바꾸는 변경이라 한 번 봐 주세요." : lowConf ? "녹취가 또렷하지 않아서 제가 맞게 읽었는지 확신이 없어요." : null;
        const cid = newId("c");
        db.prepare(
          `INSERT INTO commits (id, space_id, session_id, seq, message, status, needs_review, review_reason, reverted, changes_json, author_member_id, review_deadline, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        ).run(cid, space.id, sessionId, seq, ac.message, needsReview ? "pending" : "applied", needsReview ? 1 : 0, reason, JSON.stringify(changes), authorMemberId ?? null, needsReview ? reviewDeadline(space) : null, now());
        savedCommits.push({ id: cid, message: ac.message, pending: needsReview, review_reason: reason, changes });
      }
      db.prepare(`UPDATE spaces SET next_node_seq = ? WHERE id = ?`).run(seqNode, space.id);
    })();
    if (saved) markBriefingStale(space.id);
    return { savedCommits, pending, saved, changeCount };
  };
  return { toChange, saveAll };
}

// ---------- "고쳐주세요" ----------

// 틀린 업데이트를 되돌리고, 같은 발화 + 팀원의 지적으로 갈피가 다시 정리한다.
export async function fixCommit(spaceId: string, member: Member, commitId: string, text: string): Promise<TellResult> {
  const space = getSpace(spaceId);
  if (!space) throw new Error("스페이스 없음");
  const commit = getCommits(spaceId).find((c) => c.id === commitId);
  if (!commit) throw new Error("업데이트 없음");
  const sourceIds = [...new Set(commit.changes.flatMap((ch) => ch.source_ids))];
  const sources = getSourcesByIds(sourceIds);
  const utterances = sources.map((s, i) => ({ idx: i + 1, speaker: s.speaker, text: s.text }));
  const correctionSourceId = addDiscussionSource(spaceId, member.name, `(업데이트 "${commit.message}"에 대해) ${text}`);
  utterances.push({ idx: utterances.length + 1, speaker: member.name, text: `[지적] ${text}` });
  const idxToId = new Map<number, number>(sources.map((s, i) => [i + 1, s.id]));
  idxToId.set(utterances.length, correctionSourceId);

  if (!commit.reverted) setCommitState(commitId, "revert", member);
  const head = getHead(spaceId);
  const original = `${commit.message}\n${commit.changes.map((ch) => `- ${ch.op} ${"node" in ch ? ch.node.title : ch.node_id}${ch.op === "update" ? " " + JSON.stringify(ch.after) : ""} (이유: ${ch.reason})`).join("\n")}`;
  const r = await interpretFix({ head: compactHead(head), speaker: member.name, correction: text, original, utterances });
  if (!r.commits.length || !r.commits.some((c) => c.changes.length)) {
    logEvent({ space_id: spaceId, kind: "reverted", actor: "agent", ref_type: "commit", ref_id: commitId, title: `${josa(member.name, "이/가")} 알려줘서 되돌리고 그대로 뒀어요: ${commit.message}`, detail: `${member.name}: "${text}"\n${r.understood}` });
    return { ok: true, understood: r.understood, message: "되돌리고 그대로 뒀어요.", commit_id: commitId, pending: false, skipped: [], cost_usd: r.usage.cost_usd };
  }
  const skipped: string[] = [];
  const saver = makeCommitSaver(space, head, idxToId, skipped);
  const { savedCommits } = saver.saveAll(r.commits, commit.session_id, member.id);
  if (!savedCommits.length) {
    setCommitState(commitId, "unrevert", member);
    return { ok: false, understood: `${r.understood} 그런데 맞는 항목을 찾지 못해서 원래대로 두었어요.`, skipped, cost_usd: r.usage.cost_usd };
  }
  rebuildHead(spaceId);
  const everyone = listMembers(spaceId).map((m) => m.id);
  for (const c of savedCommits) {
    logEvent({ space_id: spaceId, kind: "applied", actor: "agent", ref_type: "commit", ref_id: c.id, title: `${josa(member.name, "이/가")} 알려줘서 다시 정리했어요: ${c.message}`, detail: `${member.name}: "${text}"`, notify: [] });
    if (c.pending) logEvent({ space_id: spaceId, kind: "asked", ref_type: "commit", ref_id: c.id, title: `한 번 봐주세요: ${c.message}`, detail: `${c.review_reason ?? "같이 정한 걸 바꾸는 변경이에요."} 반대가 없으면 그대로 확정할게요.`, notify: everyone });
  }
  const first = savedCommits[0];
  return { ok: true, understood: r.understood, message: first.message, commit_id: first.id, pending: first.pending, skipped, cost_usd: r.usage.cost_usd };
}

// ---------- "갈피에게 물어보기" ----------

export interface AskResult {
  answer: string;
  confident: boolean;
  refs: { href: string; label: string; kind: "node" | "source" }[];
  cost_usd: number;
}

// 질문에서 2글자 이상 한글·영문 조각을 뽑아 발화·항목과 맞춘다 (임베딩 없이 키워드로).
function keywords(q: string): string[] {
  const words = q.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2);
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    for (let i = 0; i + 2 <= w.length && i < 4; i++) out.add(w.slice(i, i + 2));
  }
  return [...out];
}

export async function askGalpi(spaceId: string, question: string): Promise<AskResult> {
  const space = getSpace(spaceId);
  if (!space) throw new Error("스페이스 없음");
  const head = getHead(spaceId);
  const kws = keywords(question);
  const score = (text: string) => kws.reduce((a, k) => a + (text.includes(k) ? (k.length >= 3 ? 2 : 1) : 0), 0);
  const nodes = head.map((n) => ({
    id: n.id, type: n.type, status: n.status, topic: n.topic, title: n.title, body: n.body, owner: n.owner ?? undefined, due: n.due ?? undefined, supersedes: n.supersedes ?? undefined, superseded_by: n.superseded_by ?? undefined,
  }));
  // 발화: 질문과 겹치는 항목의 근거 발화 + 키워드가 들어간 발화, 상위 40개
  const hot = head.filter((n) => score(`${n.title} ${n.body} ${n.topic}`) > 0);
  const hotSourceIds = new Set(hot.flatMap((n) => n.source_ids));
  const db = getDb();
  const all = db.prepare(`SELECT s.id, s.idx, s.speaker, s.text, se.title AS session_title, se.held_at FROM sources s JOIN sessions se ON se.id = s.session_id WHERE se.space_id = ?`).all(spaceId) as { id: number; idx: number; speaker: string; text: string; session_title: string; held_at: string }[];
  const ranked = all
    .map((s) => ({ s, sc: score(s.text) * 2 + (hotSourceIds.has(s.id) ? 3 : 0) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 40)
    .map((x) => x.s)
    .sort((a, b) => a.held_at.localeCompare(b.held_at) || a.idx - b.idx);
  const utterances = ranked.map((s, i) => ({ idx: i + 1, speaker: s.speaker, text: `(${s.held_at} ${s.session_title}) ${s.text}` }));
  const r = await answerQuestion({ spaceName: space.name, question, nodes, utterances });
  const refs: AskResult["refs"] = [];
  for (const id of r.node_ids.slice(0, 3)) {
    const n = head.find((x) => x.id === id);
    if (n) refs.push({ href: `/s/${spaceId}/${n.type === "question" ? "issues" : "n"}/${n.id}`, label: n.title, kind: "node" });
  }
  for (const i of r.source_idxs.slice(0, 3)) {
    const s = ranked[i - 1];
    if (s) refs.push({ href: `/s/${spaceId}/sessions/${(db.prepare(`SELECT session_id FROM sources WHERE id = ?`).get(s.id) as { session_id: string }).session_id}#u${s.idx}`, label: `${s.speaker}: "${s.text.slice(0, 40)}${s.text.length > 40 ? "…" : ""}"`, kind: "source" });
  }
  return { answer: r.answer, confident: r.confident, refs, cost_usd: r.usage.cost_usd };
}

// ---------- "갈피에게 말하기" ----------

export interface TellResult {
  ok: boolean;
  understood: string;
  message?: string;
  commit_id?: string;
  pending?: boolean;
  skipped: string[];
  cost_usd: number;
}

// 팀원의 한 줄을 갈피가 읽어 업데이트로 바꾼다. 출처는 그 한 줄(회의 밖 논의 발화).
export async function tellGalpi(spaceId: string, member: Member, text: string, focusNodeId?: string | null): Promise<TellResult> {
  const space = getSpace(spaceId);
  if (!space) throw new Error("스페이스 없음");
  const head = getHead(spaceId);
  const compact = compactHead(head);
  const focus = focusNodeId ? head.find((n) => n.id === focusNodeId) : undefined;
  const related = compact.length > 60 ? compact.filter((n) => n.status === "open" || n.type === "decision" || n.type === "action" || (focus && n.topic === focus.topic)) : compact;
  const r = await interpretTell({ head: related, speaker: member.name, text, focus: focus ? { id: focus.id, title: focus.title } : null });
  if (!r.commits.length || !r.commits.some((c) => c.changes.length)) {
    return { ok: false, understood: r.understood, skipped: [], cost_usd: r.usage.cost_usd };
  }
  const sourceId = addDiscussionSource(spaceId, member.name, text);
  const ses = ensureDiscussionSession(spaceId);
  const skipped: string[] = [];
  const saver = makeCommitSaver(space, head, new Map([[1, sourceId]]), skipped);
  // 모델이 source_idxs를 비우거나 다른 번호를 써도 출처는 이 한 줄이다.
  const commits = r.commits.map((c) => ({ ...c, changes: c.changes.map((ch) => ({ ...ch, source_idxs: [1] })) }));
  const { savedCommits } = saver.saveAll(commits, ses.id, member.id);
  if (!savedCommits.length) return { ok: false, understood: `${r.understood} 그런데 맞는 항목을 찾지 못해서 반영하지 못했어요.`, skipped, cost_usd: r.usage.cost_usd };
  rebuildHead(spaceId);
  const everyone = listMembers(spaceId).map((m) => m.id);
  for (const c of savedCommits) {
    if (c.pending) logEvent({ space_id: spaceId, kind: "asked", ref_type: "commit", ref_id: c.id, title: `한 번 봐주세요: ${c.message}`, detail: `${member.name}: "${text}"\n${c.review_reason ?? "같이 정한 걸 바꾸는 변경이에요."} 반대가 없으면 그대로 확정할게요.`, notify: everyone });
    else logEvent({ space_id: spaceId, kind: "manual", actor: member.id, ref_type: "commit", ref_id: c.id, title: c.message, detail: `${member.name}: "${text}"`, notify: [] });
    for (const ch of c.changes) {
      if (ch.op === "add" && ch.node.type === "action" && ch.node.owner) {
        const owner = listMembers(spaceId).find((m) => m.name === ch.node.owner);
        logEvent({ space_id: spaceId, kind: "todo", ref_type: "node", ref_id: ch.node_id, title: `${ch.node.owner} 담당 할 일이 생겼어요: ${ch.node.title}`, detail: ch.node.body || null, notify: owner ? [owner.id] : [] });
      }
    }
  }
  const first = savedCommits[0];
  return { ok: true, understood: r.understood, message: first.message, commit_id: first.id, pending: first.pending, skipped, cost_usd: r.usage.cost_usd };
}

function normalizeNode(n: NodeFields): NodeFields {
  const allowed = NODE_STATUSES[n.type];
  const due = n.type === "action" && n.due && /^\d{4}-\d{2}-\d{2}$/.test(n.due) ? n.due : null;
  return { ...n, status: allowed.includes(n.status) ? n.status : allowed[0], owner: n.owner || null, due };
}

// 저장 단계가 끝난 뒤 갈피가 한 일을 피드에 남긴다: 반영 / 물어봄 / 버림 / 새 할 일.
function logSaveEvents(spaceId: string, sessionId: string, saved: { id: string; message: string; pending: boolean; review_reason: string | null; changes: Change[] }[], skipped: string[]) {
  const members = listMembers(spaceId);
  const everyone = members.map((m) => m.id);
  const applied = saved.filter((c) => !c.pending);
  const asked = saved.filter((c) => c.pending);
  if (applied.length) {
    logEvent({
      space_id: spaceId,
      kind: "applied",
      ref_type: "session",
      ref_id: sessionId,
      title: `업데이트 ${applied.length}개를 맥락에 반영했어요`,
      detail: applied.map((c) => c.message).join("\n"),
    });
  }
  for (const c of asked) {
    logEvent({
      space_id: spaceId,
      kind: "asked",
      ref_type: "commit",
      ref_id: c.id,
      title: `한 번 봐주세요: ${c.message}`,
      detail: c.review_reason ? `${c.review_reason} 반대가 없으면 그대로 확정할게요.` : "같이 정한 걸 바꾸는 변경이라 물어볼게요. 반대가 없으면 그대로 확정할게요.",
      notify: everyone,
    });
  }
  if (!applied.length && !asked.length) {
    logEvent({ space_id: spaceId, kind: "applied", ref_type: "session", ref_id: sessionId, title: "이 회의로 바뀐 맥락은 없었어요", detail: null });
  }
  const dropped = skipped.filter((x) => x.startsWith("검수에서 버림") || x.startsWith("출처 없음"));
  if (dropped.length) {
    logEvent({
      space_id: spaceId,
      kind: "dropped",
      ref_type: "session",
      ref_id: sessionId,
      title: `${dropped.length}개는 근거가 약하거나 중복이라 버렸어요`,
      detail: dropped.map((d) => d.replace(/^검수에서 버림: |^출처 없음: /, "")).join("\n"),
    });
  }
  // 새로 생긴 할 일 → 담당자에게
  for (const c of saved) {
    for (const ch of c.changes) {
      if (ch.op !== "add" || ch.node.type !== "action" || !ch.node.owner) continue;
      const owner = members.find((m) => m.name === ch.node.owner);
      logEvent({
        space_id: spaceId,
        kind: "todo",
        ref_type: "node",
        ref_id: ch.node_id,
        title: `${ch.node.owner} 담당 할 일이 생겼어요: ${ch.node.title}`,
        detail: ch.node.body || null,
        notify: owner ? [owner.id] : [],
      });
    }
  }
}

// ---------- Manual commits (사람이 직접 만드는 업데이트) ----------

// 댓글·채택·담당자 지정처럼 사람이 화면에서 만드는 변경. 에이전트 커밋과 같은 로그에 들어간다.
export function manualCommit(spaceId: string, member: Member, message: string, build: (nextNodeId: () => string, sourceId: number) => Change[], sourceText: string): string {
  const db = getDb();
  const space = getSpace(spaceId)!;
  let seqNode = space.next_node_seq;
  const nextNodeId = () => `n${seqNode++}`;
  const sourceId = addDiscussionSource(spaceId, member.name, sourceText);
  const changes = build(nextNodeId, sourceId);
  const ses = ensureDiscussionSession(spaceId);
  const lastSeq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM commits WHERE space_id = ?`).get(spaceId) as { m: number }).m;
  const id = newId("c");
  db.transaction(() => {
    db.prepare(
      `INSERT INTO commits (id, space_id, session_id, seq, message, status, needs_review, review_reason, reverted, changes_json, author_member_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'applied', 0, NULL, 0, ?, ?, ?)`,
    ).run(id, spaceId, ses.id, lastSeq + 1, message, JSON.stringify(changes), member.id, now());
    db.prepare(`UPDATE spaces SET next_node_seq = ? WHERE id = ?`).run(seqNode, spaceId);
  })();
  rebuildHead(spaceId);
  markBriefingStale(spaceId);
  logEvent({ space_id: spaceId, kind: "manual", actor: member.id, ref_type: "commit", ref_id: id, title: message, detail: null });
  return id;
}

// 안건의 후보 답(의견) 하나를 채택: 의견 adopted + 결정 add + 안건 resolved + 나머지 후보 rejected
export function adoptClaim(spaceId: string, member: Member, questionId: string, claimId: string, otherClaimIds: string[]): string {
  const head = new Map(getHead(spaceId).map((n) => [n.id, n]));
  const q = head.get(questionId);
  const c = head.get(claimId);
  if (!q || !c) throw new Error("안건 또는 의견 없음");
  return manualCommit(
    spaceId,
    member,
    `"${q.title}" 안건을 ${c.owner ? c.owner + "의 " : ""}의견 "${c.title}"으로 정함`,
    (nextNodeId, sid) => {
      const changes: Change[] = [
        { op: "add", node_id: nextNodeId(), node: { type: "decision", title: c.title, body: c.body, topic: q.topic, owner: null, status: "agreed" }, source_ids: [sid], reason: `${member.name}이(가) 안건 화면에서 채택` },
        { op: "update", node_id: claimId, before: { status: c.status }, after: { status: "adopted" }, source_ids: [sid], reason: "채택됨" },
        { op: "update", node_id: questionId, before: { status: q.status }, after: { status: "resolved" }, source_ids: [sid], reason: "답이 정해짐" },
      ];
      for (const oid of otherClaimIds) {
        const o = head.get(oid);
        if (o && o.status === "open") changes.push({ op: "update", node_id: oid, before: { status: "open", reject_reason: null }, after: { status: "rejected", reject_reason: `"${c.title}" 채택으로 보류` }, source_ids: [sid], reason: "다른 후보 채택" });
      }
      return changes;
    },
    `${member.name}: "${q.title}"은(는) "${c.title}"으로 가자.`,
  );
}

// 안건에 후보 답(의견) 제안 — 회의 밖에서 나온 아이디어를 갈래로 올린다.
export function proposeClaim(spaceId: string, member: Member, questionId: string, title: string, body: string): string {
  const q = getHead(spaceId).find((x) => x.id === questionId);
  if (!q) throw new Error("안건 없음");
  return manualCommit(
    spaceId,
    member,
    `"${q.title}"에 ${member.name}이(가) 후보 제안: ${title}`,
    (nextNodeId, sid) => [{ op: "add", node_id: nextNodeId(), node: { type: "claim", title, body, topic: q.topic, owner: member.name, status: "open" }, source_ids: [sid], reason: "안건 화면에서 제안" }],
    `${member.name}: ${title}${body ? ` — ${body}` : ""}`,
  );
}

export function setNodeOwner(spaceId: string, member: Member, nodeId: string, owner: string | null): string {
  const n = getHead(spaceId).find((x) => x.id === nodeId);
  if (!n) throw new Error("항목 없음");
  return manualCommit(
    spaceId,
    member,
    owner ? `"${n.title}" 담당을 ${owner}(으)로 정함` : `"${n.title}" 담당 해제`,
    (_, sid) => [{ op: "update", node_id: nodeId, before: { owner: n.owner }, after: { owner }, source_ids: [sid], reason: `${member.name}이(가) 지정` }],
    `${member.name}: "${n.title}" 담당은 ${owner ?? "없음"}.`,
  );
}

export function closeNode(spaceId: string, member: Member, nodeId: string, note: string): string {
  const n = getHead(spaceId).find((x) => x.id === nodeId);
  if (!n) throw new Error("항목 없음");
  const done = n.type === "action" ? "done" : n.type === "question" ? "resolved" : null;
  if (!done) throw new Error("닫을 수 없는 항목");
  return manualCommit(
    spaceId,
    member,
    `"${n.title}" ${n.type === "action" ? "완료" : "해결"}${note ? ` — ${note}` : ""}`,
    (_, sid) => [{ op: "update", node_id: nodeId, before: { status: n.status }, after: { status: done }, source_ids: [sid], reason: note || `${member.name}이(가) 닫음` }],
    `${member.name}: "${n.title}" ${note || (n.type === "action" ? "완료했어요." : "정리됐어요.")}`,
  );
}

// ---------- Approvals (동의 모으기) ----------

export function listPendingCommits(spaceId: string) {
  return getCommits(spaceId).filter((c) => c.status === "pending" && !c.reverted);
}

// 기한이 하루 안으로 다가온(또는 지난) 열린 할 일을 담당자에게 한 번만 알린다. 페이지 진입마다 불러도 싸다.
export function remindDueActions(spaceId: string): number {
  const db = getDb();
  const limit = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT id, title, owner, due FROM nodes WHERE space_id = ? AND type = 'action' AND status = 'open' AND due IS NOT NULL AND due <= ?`).all(spaceId, limit) as { id: string; title: string; owner: string | null; due: string }[];
  if (!rows.length) return 0;
  const already = new Set((db.prepare(`SELECT ref_id FROM events WHERE space_id = ? AND kind = 'due'`).all(spaceId) as { ref_id: string }[]).map((r) => r.ref_id));
  const members = listMembers(spaceId);
  const today = now().slice(0, 10);
  let n = 0;
  for (const r of rows) {
    if (already.has(r.id)) continue;
    const owner = members.find((m) => m.name === r.owner);
    const late = r.due < today;
    logEvent({ space_id: spaceId, kind: "due", ref_type: "node", ref_id: r.id, title: late ? `기한이 지났어요: ${r.title}` : `내일까지예요: ${r.title}`, detail: `${r.owner ? `${r.owner} 담당 · ` : ""}기한 ${r.due}`, notify: owner ? [owner.id] : [] });
    n += 1;
  }
  return n;
}

// "이의 없으면 확정": 기한이 지났고 반대가 하나도 없는 확인 대기 업데이트를 갈피가 확정한다.
// 기한이 없던 옛 업데이트에는 지금부터 기한을 매긴다(바로 확정하지 않음). 페이지 진입마다 불러도 싸다.
export function settleDueCommits(spaceId: string): number {
  const db = getDb();
  const space = getSpace(spaceId);
  if (!space) return 0;
  const pending = db.prepare(`SELECT id, message, review_deadline FROM commits WHERE space_id = ? AND status = 'pending' AND reverted = 0`).all(spaceId) as { id: string; message: string; review_deadline: string | null }[];
  if (!pending.length) return 0;
  const nowIso = now();
  let settled = 0;
  const votes = listApprovals(pending.map((c) => c.id));
  for (const c of pending) {
    if (!c.review_deadline) {
      const d = reviewDeadline(space);
      if (d) db.prepare(`UPDATE commits SET review_deadline = ? WHERE id = ?`).run(d, c.id);
      continue;
    }
    if (c.review_deadline > nowIso) continue;
    if (votes.some((v) => v.commit_id === c.id && v.vote === "reject")) continue;
    db.prepare(`UPDATE commits SET status = 'applied' WHERE id = ?`).run(c.id);
    logEvent({ space_id: spaceId, kind: "settled", ref_type: "commit", ref_id: c.id, title: `반대가 없어서 확정했어요: ${c.message}`, detail: `${Math.round(space.review_hours ?? 48)}시간 동안 반대가 없었어요. 되돌리고 싶으면 업데이트에서 되돌리기를 누르세요.` });
    settled += 1;
  }
  if (settled) {
    rebuildHead(spaceId);
    markBriefingStale(spaceId);
  }
  return settled;
}

export function listApprovals(commitIds: string[]): Approval[] {
  if (!commitIds.length) return [];
  return getDb().prepare(`SELECT * FROM approvals WHERE commit_id IN (${commitIds.map(() => "?").join(",")}) ORDER BY created_at ASC`).all(...commitIds) as Approval[];
}

export type Verdict = "applied" | "rejected" | "pending" | "conflict";

// 설정에 따라 지금까지의 표로 결론을 낸다.
export function evaluateApprovals(space: Space, members: Member[], votes: Approval[]): { verdict: Verdict; needed: number; approves: number; rejects: number } {
  const relevant = space.approval_mode === "deciders" ? votes.filter((v) => members.find((m) => m.id === v.member_id)?.is_decider) : votes;
  const approves = relevant.filter((v) => v.vote === "approve").length;
  const rejects = relevant.filter((v) => v.vote === "reject").length;
  const needed = space.approval_mode === "count" ? Math.max(1, space.approval_count) : 1;
  let verdict: Verdict = "pending";
  if (space.approval_mode === "count") {
    if (rejects > 0 && approves < needed) verdict = "conflict";
    else if (approves >= needed) verdict = "applied";
  } else {
    if (approves >= 1 && rejects === 0) verdict = "applied";
    else if (rejects >= 1 && approves === 0) verdict = "rejected";
    else if (approves >= 1 && rejects >= 1) verdict = "conflict";
  }
  return { verdict, needed, approves, rejects };
}

export function castVote(commitId: string, member: Member, vote: "approve" | "reject", note?: string): Verdict {
  const db = getDb();
  const c = db.prepare(`SELECT space_id, status, message FROM commits WHERE id = ?`).get(commitId) as { space_id: string; status: string; message: string } | undefined;
  if (!c) throw new Error("업데이트 없음");
  // 다른 프로젝트 사람의 표는 받지 않는다 (예시 스페이스 멤버가 남의 팀 업데이트를 확정하던 구멍)
  if (member.space_id !== c.space_id) throw new Error("이 프로젝트 사람만 동의·반대할 수 있어요");
  db.prepare(
    `INSERT INTO approvals (id, commit_id, member_id, vote, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(commit_id, member_id) DO UPDATE SET vote = excluded.vote, note = excluded.note, created_at = excluded.created_at`,
  ).run(newId("a"), commitId, member.id, vote, note ?? null, now());
  const space = getSpace(c.space_id)!;
  const { verdict } = evaluateApprovals(space, listMembers(c.space_id), listApprovals([commitId]));
  if (verdict === "applied") db.prepare(`UPDATE commits SET status = 'applied' WHERE id = ?`).run(commitId);
  else if (verdict === "rejected") db.prepare(`UPDATE commits SET status = 'rejected' WHERE id = ?`).run(commitId);
  else db.prepare(`UPDATE commits SET status = 'pending' WHERE id = ?`).run(commitId);
  rebuildHead(c.space_id);
  markBriefingStale(c.space_id);
  const others = listMembers(c.space_id).map((m) => m.id).filter((id) => id !== member.id);
  logEvent({ space_id: c.space_id, kind: "voted", actor: member.id, ref_type: "commit", ref_id: commitId, title: `${josa(member.name, "이/가")} ${vote === "approve" ? "동의했어요" : "반대했어요"}: ${c.message}`, detail: note ?? null, notify: vote === "reject" ? others : [] });
  if (verdict === "applied" && c.status !== "applied") logEvent({ space_id: c.space_id, kind: "settled", ref_type: "commit", ref_id: commitId, title: `동의가 모여서 확정했어요: ${c.message}`, detail: null });
  if (verdict === "rejected" && c.status !== "rejected") logEvent({ space_id: c.space_id, kind: "settled", ref_type: "commit", ref_id: commitId, title: `반대가 있어서 맥락에서 뺐어요: ${c.message}`, detail: null });
  if (verdict === "conflict") {
    logEvent({ space_id: c.space_id, kind: "asked", ref_type: "commit", ref_id: commitId, title: `의견이 엇갈려요. 결론을 내 주세요: ${c.message}`, detail: null, notify: others });
    postDiscordLater(c.space_id, { title: "의견이 엇갈려요 — 결론이 필요해요", lines: [c.message, `${member.name}: ${vote === "approve" ? "동의" : "반대"}${note ? ` · ${note}` : ""}`], url: `${APP_URL}/s/${c.space_id}/c/${commitId}`, tone: "orange" });
  }
  return verdict;
}

export function setCommitState(commitId: string, action: "revert" | "unrevert" | "approve" | "reject", member?: Member): void {
  const db = getDb();
  const c = db.prepare(`SELECT space_id, message FROM commits WHERE id = ?`).get(commitId) as { space_id: string; message: string } | undefined;
  if (!c) throw new Error("커밋 없음");
  if (member && member.space_id !== c.space_id) throw new Error("이 프로젝트 사람만 바꿀 수 있어요");
  const sql = {
    revert: `UPDATE commits SET reverted = 1 WHERE id = ?`,
    unrevert: `UPDATE commits SET reverted = 0 WHERE id = ?`,
    approve: `UPDATE commits SET status = 'applied' WHERE id = ?`,
    reject: `UPDATE commits SET status = 'rejected' WHERE id = ?`,
  }[action];
  db.prepare(sql).run(commitId);
  rebuildHead(c.space_id);
  markBriefingStale(c.space_id);
  const who = member ? josa(member.name, "이/가") : "누군가";
  const verb = { revert: "되돌렸어요", unrevert: "되돌리기를 취소했어요", approve: "다시 반영했어요", reject: "뺐어요" }[action];
  logEvent({ space_id: c.space_id, kind: "reverted", actor: member?.id ?? "agent", ref_type: "commit", ref_id: commitId, title: `${who} ${verb}: ${c.message}`, detail: null });
}

// ---------- Comments (안건 댓글 = 회의 밖 논의) ----------

export function listComments(spaceId: string, nodeId: string): Comment[] {
  return getDb().prepare(`SELECT * FROM comments WHERE space_id = ? AND node_id = ? ORDER BY created_at ASC`).all(spaceId, nodeId) as Comment[];
}

export function countComments(spaceId: string): Map<string, number> {
  const rows = getDb().prepare(`SELECT node_id, COUNT(*) AS n FROM comments WHERE space_id = ? GROUP BY node_id`).all(spaceId) as { node_id: string; n: number }[];
  return new Map(rows.map((r) => [r.node_id, r.n]));
}

// 갈피가 아직 안 읽은 댓글 (다음 회의 정리 때 발화로 같이 들어간다)
export function listUnconsumedComments(spaceId: string): (Comment & { speaker: string; node_title: string })[] {
  return getDb()
    .prepare(
      `SELECT c.*, m.name AS speaker, COALESCE(n.title, '') AS node_title FROM comments c
       JOIN members m ON m.id = c.member_id
       LEFT JOIN nodes n ON n.space_id = c.space_id AND n.id = c.node_id
       WHERE c.space_id = ? AND c.consumed_by IS NULL ORDER BY c.created_at ASC`,
    )
    .all(spaceId) as (Comment & { speaker: string; node_title: string })[];
}

export function markCommentsConsumed(ids: string[], sessionId: string): void {
  if (!ids.length) return;
  getDb().prepare(`UPDATE comments SET consumed_by = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(sessionId, ...ids);
}

export function addComment(spaceId: string, member: Member, nodeId: string, text: string): Comment {
  const sourceId = addDiscussionSource(spaceId, member.name, text);
  const c: Comment = { id: newId("cm"), space_id: spaceId, node_id: nodeId, member_id: member.id, source_id: sourceId, text, consumed_by: null, created_at: now() };
  getDb()
    .prepare(`INSERT INTO comments (id, space_id, node_id, member_id, source_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(c.id, c.space_id, c.node_id, c.member_id, c.source_id, c.text, c.created_at);
  return c;
}

// ---------- Briefing ----------

export interface Briefing {
  space_id: string;
  head_commit_id: string | null;
  content: string;
  usage_json: string | null;
  stale: number; // 1이면 맥락이 바뀐 뒤라 갈피가 다시 쓰는 중
  created_at: string;
}

export function getBriefing(spaceId: string): Briefing | undefined {
  return getDb().prepare(`SELECT * FROM briefings WHERE space_id = ?`).get(spaceId) as Briefing | undefined;
}

export function hasContext(spaceId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM commits WHERE space_id = ? AND status IN ('applied','pending') AND reverted = 0 LIMIT 1`).get(spaceId);
}

// 맥락이 바뀌면 브리핑을 지우지 않고 "낡음"으로 표시한 뒤, 잠시 후 갈피가 다시 쓴다 (연속 변경은 한 번으로 묶임).
declare global {
  var __galpiBriefTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
  var __galpiBriefRunning: Set<string> | undefined;
}
const briefTimers = (globalThis.__galpiBriefTimers ??= new Map());
const briefRunning = (globalThis.__galpiBriefRunning ??= new Set());

export function markBriefingStale(spaceId: string, delayMs = 30_000): void {
  getDb().prepare(`UPDATE briefings SET stale = 1 WHERE space_id = ?`).run(spaceId);
  scheduleBriefing(spaceId, delayMs);
}

export function scheduleBriefing(spaceId: string, delayMs = 30_000): void {
  const prev = briefTimers.get(spaceId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(async () => {
    briefTimers.delete(spaceId);
    if (briefRunning.has(spaceId)) {
      scheduleBriefing(spaceId, 10_000);
      return;
    }
    const b = getBriefing(spaceId);
    if (b && !b.stale) return;
    if (!hasContext(spaceId)) return;
    briefRunning.add(spaceId);
    try {
      await refreshBriefing(spaceId);
    } catch (e) {
      console.error("브리핑 자동 갱신 실패", spaceId, e);
    } finally {
      briefRunning.delete(spaceId);
    }
  }, delayMs);
  t.unref?.();
  briefTimers.set(spaceId, t);
}

// 화면에서 부른다: 브리핑이 없거나 낡았는데 예약이 없으면(서버 재시작 등) 곧 다시 쓰게 한다.
export function ensureBriefing(spaceId: string): "fresh" | "writing" | "none" {
  const b = getBriefing(spaceId);
  if (b && !b.stale) return "fresh";
  if (!hasContext(spaceId)) return "none";
  if (!briefTimers.has(spaceId) && !briefRunning.has(spaceId)) scheduleBriefing(spaceId, 2_000);
  return "writing";
}

export async function refreshBriefing(spaceId: string): Promise<Briefing> {
  const space = getSpace(spaceId);
  if (!space) throw new Error("스페이스 없음");
  const head = getHead(spaceId);
  const commits = getCommits(spaceId).filter((c) => (c.status === "applied" || c.status === "pending") && !c.reverted);
  const lastSession = commits.at(-1)?.session_id;
  const recent = commits.filter((c) => c.session_id === lastSession).map((c) => c.message);
  const { content, usage } = await generateBriefing({ head, recentCommitMessages: recent, spaceName: space.name });
  const b: Briefing = { space_id: spaceId, head_commit_id: commits.at(-1)?.id ?? null, content, usage_json: JSON.stringify(usage), stale: 0, created_at: now() };
  getDb()
    .prepare(`INSERT OR REPLACE INTO briefings (space_id, head_commit_id, content, usage_json, stale, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
    .run(b.space_id, b.head_commit_id, b.content, b.usage_json, b.created_at);
  logEvent({ space_id: spaceId, kind: "briefing", ref_type: "briefing", ref_id: spaceId, title: "다음 회의 전 브리핑을 새로 썼어요", detail: firstLines(content) });
  postDiscordLater(spaceId, { title: "다음 회의 전 브리핑을 새로 썼어요", lines: firstLines(content, 6).split("\n").map((l) => `• ${l}`), url: `${APP_URL}/s/${spaceId}/briefing`, tone: "green" });
  return b;
}

function firstLines(md: string, n = 3): string {
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .slice(0, n)
    .map((l) => l.replace(/^[-*]\s+/, "").replace(/\*\*/g, ""))
    .join("\n");
}
