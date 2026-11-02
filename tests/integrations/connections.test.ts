// 연결 저장 (S5) — 토큰은 암호화로만, 다른 스페이스 행에 옮기면 안 풀림, 디스코드 웹훅 옮기기
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/lib/db";
import { discordStatus, discordWebhook, getConnection, listConnections, putConnection, readSecret, removeConnection, setDiscordWebhook } from "../../src/lib/integrations/connections";
import { createSpace, updateSpaceSettings } from "../../src/lib/service";

const TOKEN = "secret_ntn_TESTTOKEN_0123456789abcdef";
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jkl";

describe("연결 저장", () => {
  it("토큰은 DB에 평문으로 없고, 꺼내면 같다", () => {
    const a = createSpace("A");
    putConnection(a.id, "notion", { installedBy: "m1", scopes: "read", secret: { access_token: TOKEN }, root: { pages: [] } });
    const raw = getDb().prepare(`SELECT * FROM connections WHERE space_id = ?`).get(a.id) as Record<string, string>;
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    expect(raw.token_enc).toMatch(/^v1:/);
    expect(readSecret<{ access_token: string }>(a.id, "notion")?.access_token).toBe(TOKEN);
  });

  it("밖으로 내보내는 모양(ConnectionInfo)에는 토큰 칸이 없다", () => {
    const a = createSpace("A");
    putConnection(a.id, "notion", { secret: { access_token: TOKEN } });
    const s = JSON.stringify([getConnection(a.id, "notion"), listConnections(a.id)]);
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain("token_enc");
  });

  it("암호문을 다른 스페이스 행으로 옮겨 붙이면 풀리지 않는다", () => {
    const a = createSpace("A");
    const b = createSpace("B");
    putConnection(a.id, "notion", { secret: { access_token: TOKEN } });
    putConnection(b.id, "notion", { secret: { access_token: "b-token" } });
    const db = getDb();
    const enc = (db.prepare(`SELECT token_enc FROM connections WHERE space_id = ?`).get(a.id) as { token_enc: string }).token_enc;
    db.prepare(`UPDATE connections SET token_enc = ? WHERE space_id = ?`).run(enc, b.id);
    expect(() => readSecret(b.id, "notion")).toThrow();
  });

  it("끊으면 토큰이 남지 않는다", () => {
    const a = createSpace("A");
    putConnection(a.id, "notion", { secret: { access_token: TOKEN } });
    removeConnection(a.id, "notion");
    expect(readSecret(a.id, "notion")).toBeNull();
    expect(getDb().prepare(`SELECT count(*) n FROM connections WHERE space_id = ?`).get(a.id)).toEqual({ n: 0 });
  });

  it("열쇠 파일은 저장소 밖 권한 600", () => {
    const a = createSpace("A");
    putConnection(a.id, "notion", { secret: { x: 1 } });
    const st = fs.statSync(process.env.MEETY_TOKEN_KEY_FILE!);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("디스코드 웹훅 → 연결", () => {
  it("설정에서 저장하면 평문 칸은 비고 연결에 암호화로", () => {
    const a = createSpace("A");
    updateSpaceSettings(a.id, { discord_webhook: HOOK });
    const sp = getDb().prepare(`SELECT discord_webhook FROM spaces WHERE id = ?`).get(a.id) as { discord_webhook: string | null };
    expect(sp.discord_webhook).toBeNull();
    expect(discordWebhook(a.id)).toBe(HOOK);
    expect(discordStatus(a.id)).toEqual({ connected: true, hint: "…/webhooks/1234…/****" });
    updateSpaceSettings(a.id, { discord_webhook: undefined });
    expect(discordWebhook(a.id)).toBe(HOOK);
    updateSpaceSettings(a.id, { discord_webhook: null });
    expect(discordWebhook(a.id)).toBeNull();
  });

  it("옛 평문 칸에 있던 웹훅은 처음 읽을 때 연결로 옮겨진다", () => {
    const a = createSpace("A");
    getDb().prepare(`UPDATE spaces SET discord_webhook = ? WHERE id = ?`).run(HOOK, a.id);
    expect(discordWebhook(a.id)).toBe(HOOK);
    expect((getDb().prepare(`SELECT discord_webhook FROM spaces WHERE id = ?`).get(a.id) as { discord_webhook: string | null }).discord_webhook).toBeNull();
  });

  it.each(["http://discord.com/api/webhooks/1/x", "https://evil.com/api/webhooks/1/x", "https://discord.com.evil.com/api/webhooks/1/x", "https://discord.com/api/other/1/x"])("웹훅이 아닌 주소는 거절: %s", (u) => {
    const a = createSpace("A");
    expect(() => setDiscordWebhook(a.id, u)).toThrow();
    expect(discordWebhook(a.id)).toBeNull();
  });
});
