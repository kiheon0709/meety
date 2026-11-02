// 계정: 이메일+비밀번호, 서명 없는 랜덤 토큰 쿠키 (서버 테이블 조회). 데모 스페이스는 멤버 전환 쿠키 허용.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getDb, newId, now } from "./db";
import type { Member, User } from "./types";

const SESSION_COOKIE = "cg_session";
export const memberCookie = (spaceId: string) => `cg_member_${spaceId}`;

// ---------- password ----------
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- users ----------
export function findUserByEmail(email: string): User | undefined {
  return getDb().prepare(`SELECT * FROM users WHERE email = ?`).get(email.trim().toLowerCase()) as User | undefined;
}
export function getUserById(id: string): User | undefined {
  return getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as User | undefined;
}
export function createUser(email: string, name: string, password: string): User {
  const u: User = { id: newId("u"), email: email.trim().toLowerCase(), name: name.trim(), password_hash: hashPassword(password), created_at: now() };
  getDb().prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`).run(u.id, u.email, u.name, u.password_hash, u.created_at);
  return u;
}

// ---------- sessions ----------
export async function startSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  getDb().prepare(`INSERT INTO auth_sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).run(token, userId, expires, now());
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
}
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) getDb().prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
  jar.delete(SESSION_COOKIE);
}
export async function getUser(): Promise<User | undefined> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return undefined;
  const row = getDb().prepare(`SELECT user_id, expires_at FROM auth_sessions WHERE token = ?`).get(token) as { user_id: string; expires_at: string } | undefined;
  if (!row || row.expires_at < now()) return undefined;
  return getUserById(row.user_id);
}

// ---------- current member in a space ----------
// 로그인한 유저가 이 스페이스의 멤버면 그 멤버. 데모 스페이스는 전환 쿠키로 아무 멤버나.
export async function getCurrentMember(spaceId: string): Promise<Member | undefined> {
  const db = getDb();
  const space = db.prepare(`SELECT is_demo FROM spaces WHERE id = ?`).get(spaceId) as { is_demo: number } | undefined;
  if (!space) return undefined;
  const user = await getUser();
  if (user) {
    const m = db.prepare(`SELECT * FROM members WHERE space_id = ? AND user_id = ?`).get(spaceId, user.id) as Member | undefined;
    if (m) return m;
  }
  if (space.is_demo) {
    const jar = await cookies();
    const id = jar.get(memberCookie(spaceId))?.value;
    if (id) {
      const m = db.prepare(`SELECT * FROM members WHERE id = ? AND space_id = ?`).get(id, spaceId) as Member | undefined;
      if (m) return m;
    }
    return db.prepare(`SELECT * FROM members WHERE space_id = ? ORDER BY created_at ASC LIMIT 1`).get(spaceId) as Member | undefined;
  }
  return undefined;
}

export async function canAccessSpace(spaceId: string): Promise<boolean> {
  const db = getDb();
  const space = db.prepare(`SELECT is_demo FROM spaces WHERE id = ?`).get(spaceId) as { is_demo: number } | undefined;
  if (!space) return false;
  if (space.is_demo) return true;
  const user = await getUser();
  if (!user) return false;
  return !!db.prepare(`SELECT 1 FROM members WHERE space_id = ? AND user_id = ?`).get(spaceId, user.id);
}
