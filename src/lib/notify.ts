// 갈피가 먼저 말하는 바깥 채널. 지금은 디스코드 incoming webhook 하나.
// 웹훅 URL이 없으면 조용히 건너뛴다. DISCORD_DRY_RUN=1 이면 보내지 않고 콘솔에 찍는다.
import { discordWebhook } from "./integrations/connections";
import { safeFetch } from "./integrations/http";

export const APP_URL = (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "");

export interface DiscordPayload {
  title: string;
  lines: string[];
  url?: string;
  tone?: "blue" | "orange" | "green";
}

const COLOR = { blue: 0x0071e3, orange: 0xff9f0a, green: 0x1d7a5a };

export function buildDiscordBody(p: DiscordPayload) {
  const desc = p.lines.filter(Boolean).slice(0, 12).join("\n").slice(0, 3800);
  return {
    username: "미티",
    embeds: [{ title: p.title.slice(0, 250), description: desc, url: p.url, color: COLOR[p.tone ?? "blue"] }],
  };
}

export async function postDiscord(spaceId: string, p: DiscordPayload): Promise<"sent" | "skipped" | "dry" | "failed"> {
  const hook = discordWebhook(spaceId)?.trim(); // 연결(암호화)에서 꺼냄 — 옛 평문 칸은 이때 옮겨진다
  const body = buildDiscordBody(p);
  if (process.env.DISCORD_DRY_RUN === "1") {
    console.log("[discord dry-run]", JSON.stringify(body, null, 1));
    return "dry";
  }
  if (!hook || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(hook)) return "skipped";
  try {
    const r = await safeFetch("discord", hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

// 비동기로 보내되 실패해도 호출자를 막지 않는다.
export function postDiscordLater(spaceId: string, p: DiscordPayload): void {
  void postDiscord(spaceId, p).then((r) => {
    if (r === "failed") console.error("디스코드 웹훅 실패", spaceId);
  });
}
