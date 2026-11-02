"use server";

import { todayLocal } from "./date";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import * as svc from "./service";
import { markAllRead } from "./events";
import { canAccessSpace, createUser, endSession, findUserByEmail, getCurrentMember, getUser, memberCookie, startSession, verifyPassword } from "./auth";
import type { ApprovalMode } from "./types";
import { disconnectNotion, importNotionPage } from "./integrations/notion";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

// ---------- 계정 ----------

export async function signUpAction(_prev: { error?: string } | undefined, formData: FormData): Promise<{ error?: string }> {
  const email = str(formData, "email");
  const name = str(formData, "name");
  const password = String(formData.get("password") ?? "");
  const next = str(formData, "next") || "/home";
  if (!email || !name || password.length < 6) return { error: "이름, 이메일, 6자 이상 비밀번호가 필요해요." };
  if (findUserByEmail(email)) return { error: "이미 가입된 이메일이에요. 로그인해 주세요." };
  const u = createUser(email, name, password);
  await startSession(u.id);
  redirect(next);
}

export async function signInAction(_prev: { error?: string } | undefined, formData: FormData): Promise<{ error?: string }> {
  const email = str(formData, "email");
  const password = String(formData.get("password") ?? "");
  const next = str(formData, "next") || "/home";
  const u = findUserByEmail(email);
  if (!u || !verifyPassword(password, u.password_hash)) return { error: "이메일 또는 비밀번호가 맞지 않아요." };
  await startSession(u.id);
  redirect(next);
}

export async function markNotificationsReadAction() {
  const user = await getUser();
  if (!user) return;
  const ids = (svc.listMembersForUser(user.id)).map((m) => m.id);
  markAllRead(ids);
  revalidatePath("/notifications");
}

export async function signOutAction() {
  await endSession();
  redirect("/");
}

// ---------- 프로젝트 · 멤버 ----------

export async function createSpaceAction(formData: FormData) {
  const user = await getUser();
  if (!user) redirect("/login?next=/home");
  const name = str(formData, "name");
  if (!name) return;
  const s = svc.createSpace(name, { name: user.name, user_id: user.id });
  redirect(`/s/${s.id}`);
}

export async function joinAction(formData: FormData) {
  const token = str(formData, "token");
  const user = await getUser();
  if (!user) redirect(`/login?next=/join/${token}`);
  const inv = svc.getInvite(token);
  if (!inv) redirect("/home");
  svc.joinSpace(inv.space_id, user);
  redirect(`/s/${inv.space_id}`);
}

export async function claimMemberAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const memberId = str(formData, "member_id");
  const user = await getUser();
  if (!user || !(await canAccessSpace(spaceId))) return;
  // 이 스페이스의, 아직 아무 계정과도 연결되지 않은(또는 내) 멤버만 가져올 수 있다
  const target = svc.getMember(memberId);
  if (!target || target.space_id !== spaceId || (target.user_id && target.user_id !== user.id)) return;
  // 이미 다른 멤버로 연결돼 있으면 그 연결은 풀고 옮긴다 (한 사람 = 한 멤버)
  const mine = svc.memberForUser(spaceId, user.id);
  if (mine && mine.id !== memberId) svc.linkMemberToUser(mine.id, null);
  svc.linkMemberToUser(memberId, user.id);
  revalidatePath(`/s/${spaceId}`, "layout");
}

export async function addMemberAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const name = str(formData, "name");
  const me = await getCurrentMember(spaceId);
  if (!me || !name) return;
  svc.addMember(spaceId, name);
  revalidatePath(`/s/${spaceId}`, "layout");
}

export async function removeMemberAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me || !sameSpaceMember(spaceId, str(formData, "member_id"))) return;
  svc.removeMember(str(formData, "member_id"));
  revalidatePath(`/s/${spaceId}`, "layout");
}

export async function updateSettingsAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  const mode = str(formData, "approval_mode") as ApprovalMode;
  const count = Number(str(formData, "approval_count") || 1);
  const name = str(formData, "name");
  const rh = str(formData, "review_hours");
  // 웹훅 칸은 비워 두면 그대로, "연결 끊기"를 누르면 끊음. 주소는 화면에 다시 안 보여 준다(비밀)
  const hook = formData.has("discord_disconnect") ? null : str(formData, "discord_webhook") || undefined;
  try {
    svc.updateSpaceSettings(spaceId, { name: name || undefined, approval_mode: mode || undefined, approval_count: Number.isFinite(count) ? count : undefined, review_hours: rh === "" ? undefined : Number(rh), discord_webhook: hook });
  } catch {
    return; // 디스코드 웹훅 주소가 아님 — 저장하지 않음
  }
  const members = svc.listMembers(spaceId);
  const space = svc.getSpace(spaceId)!;
  for (const c of svc.listPendingCommits(spaceId)) {
    const { verdict } = svc.evaluateApprovals(space, members, svc.listApprovals([c.id]));
    if (verdict === "applied") svc.setCommitState(c.id, "approve");
    else if (verdict === "rejected") svc.setCommitState(c.id, "reject");
  }
  revalidatePath(`/s/${spaceId}`, "layout");
}

// 데모 스페이스 전용: "나는 누구" 전환
export async function switchMemberAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const memberId = str(formData, "member_id");
  const next = str(formData, "next") || `/s/${spaceId}`;
  const jar = await cookies();
  jar.set(memberCookie(spaceId), memberId, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath(`/s/${spaceId}`, "layout");
  redirect(next);
}

// ---------- 회의 입력 · 처리 ----------

function kickOff(sessionId: string) {
  // 응답을 먼저 보내고 백그라운드에서 파이프라인. 진행 상태는 sessions.stage 폴링.
  svc.markQueued(sessionId);
  after(async () => {
    try {
      await svc.processSession(sessionId);
    } catch {
      /* 세션에 기록됨 */
    }
  });
}

export async function createSessionAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  const title = str(formData, "title") || defaultTitle();
  const heldAt = str(formData, "held_at") || todayLocal();
  const transcript = String(formData.get("transcript") ?? "");
  const s = svc.createSession(spaceId, title, heldAt, transcript);
  kickOff(s.id);
  revalidatePath(`/s/${spaceId}`, "layout");
  redirect(`/s/${spaceId}/sessions/${s.id}`);
}

// 녹음 화면에서 온 발화 목록(JSON)
export async function saveRecordingAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  const title = str(formData, "title") || defaultTitle();
  const heldAt = todayLocal();
  const raw = String(formData.get("utterances") ?? "[]");
  const list = (JSON.parse(raw) as { speaker: string; text: string }[]).filter((u) => u.text.trim());
  if (!list.length) redirect(`/s/${spaceId}/record?empty=1`);
  const utts = list.map((u, i) => ({ idx: i + 1, speaker: u.speaker || "회의", text: u.text.trim() }));
  const transcript = utts.map((u) => `${u.speaker}: ${u.text}`).join("\n");
  const s = svc.createSessionFromUtterances(spaceId, title, heldAt, transcript, utts);
  kickOff(s.id);
  revalidatePath(`/s/${spaceId}`, "layout");
  redirect(`/s/${spaceId}/sessions/${s.id}`);
}

export async function processSessionAction(formData: FormData) {
  const sessionId = str(formData, "session_id");
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me || svc.getSession(sessionId)?.space_id !== spaceId) return;
  kickOff(sessionId);
  revalidatePath(`/s/${spaceId}`, "layout");
  redirect(`/s/${spaceId}/sessions/${sessionId}`);
}

// 폼으로 받은 member_id가 이 스페이스 사람인지 (다른 프로젝트 멤버를 건드리지 못하게)
function sameSpaceMember(spaceId: string, memberId: string): boolean {
  return svc.getMember(memberId)?.space_id === spaceId;
}

function defaultTitle() {
  const d = new Date();
  return `${d.getMonth() + 1}월 ${d.getDate()}일 회의`;
}

// ---------- 업데이트 · 동의 ----------

export async function commitStateAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  svc.setCommitState(str(formData, "commit_id"), str(formData, "action") as "revert" | "unrevert" | "approve" | "reject", me);
  revalidatePath(`/s/${spaceId}`, "layout");
}

export async function voteAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  svc.castVote(str(formData, "commit_id"), me, str(formData, "vote") as "approve" | "reject", str(formData, "note") || undefined);
  revalidatePath(`/s/${spaceId}`, "layout");
}

// "갈피에게 말하기" — 한 줄을 갈피가 읽어 업데이트로. useActionState로 결과를 화면에 돌려준다.
export async function tellAction(_prev: svc.TellResult | null, formData: FormData): Promise<svc.TellResult | null> {
  const spaceId = str(formData, "space_id");
  const text = str(formData, "text");
  const me = await getCurrentMember(spaceId);
  if (!me || !text) return null;
  try {
    const r = await svc.tellGalpi(spaceId, me, text, str(formData, "node_id") || null);
    revalidatePath(`/s/${spaceId}`, "layout");
    return r;
  } catch (e) {
    return { ok: false, understood: `처리하다가 멈췄어요: ${e instanceof Error ? e.message : String(e)}`, skipped: [], cost_usd: 0 };
  }
}

// "고쳐주세요" — 틀린 업데이트를 되돌리고 갈피가 다시 정리
export async function fixAction(_prev: svc.TellResult | null, formData: FormData): Promise<svc.TellResult | null> {
  const spaceId = str(formData, "space_id");
  const text = str(formData, "text");
  const me = await getCurrentMember(spaceId);
  if (!me || !text) return null;
  try {
    const r = await svc.fixCommit(spaceId, me, str(formData, "commit_id"), text);
    revalidatePath(`/s/${spaceId}`, "layout");
    return r;
  } catch (e) {
    return { ok: false, understood: `처리하다가 멈췄어요: ${e instanceof Error ? e.message : String(e)}`, skipped: [], cost_usd: 0 };
  }
}

// "갈피에게 물어보기"
export async function askAction(_prev: svc.AskResult | null, formData: FormData): Promise<svc.AskResult | null> {
  const spaceId = str(formData, "space_id");
  const q = str(formData, "question");
  const me = await getCurrentMember(spaceId);
  if (!me || !q) return null;
  try {
    return await svc.askGalpi(spaceId, q);
  } catch (e) {
    return { answer: `답하다가 멈췄어요: ${e instanceof Error ? e.message : String(e)}`, confident: false, refs: [], cost_usd: 0 };
  }
}

// ---------- 안건 ----------

export async function addCommentAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  const text = str(formData, "text");
  if (!me || !text) return;
  svc.addComment(spaceId, me, str(formData, "node_id"), text);
  revalidatePath(`/s/${spaceId}`, "layout");
}

export async function adoptClaimAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  const cid = svc.adoptClaim(spaceId, me, str(formData, "question_id"), str(formData, "claim_id"), str(formData, "other_claim_ids").split(",").filter(Boolean));
  revalidatePath(`/s/${spaceId}`, "layout");
  redirect(`/s/${spaceId}/c/${cid}`);
}

export async function proposeClaimAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  const title = str(formData, "title");
  if (!me || !title) return;
  svc.proposeClaim(spaceId, me, str(formData, "question_id"), title, str(formData, "body"));
  revalidatePath(`/s/${spaceId}`, "layout");
}

export async function setOwnerAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  svc.setNodeOwner(spaceId, me, str(formData, "node_id"), str(formData, "owner") || null);
  revalidatePath(`/s/${spaceId}`, "layout");
}

export async function closeNodeAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  svc.closeNode(spaceId, me, str(formData, "node_id"), str(formData, "note"));
  revalidatePath(`/s/${spaceId}`, "layout");
}

// ── 노션 (S5 연동) ──
export async function importNotionAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  try {
    await importNotionPage(spaceId, str(formData, "page"));
  } catch (e) {
    console.error("노션 가져오기 실패:", (e as Error).message);
  }
  revalidatePath(`/s/${spaceId}/settings`);
}

export async function disconnectNotionAction(formData: FormData) {
  const spaceId = str(formData, "space_id");
  const me = await getCurrentMember(spaceId);
  if (!me) return;
  disconnectNotion(spaceId);
  revalidatePath(`/s/${spaceId}/settings`);
}
