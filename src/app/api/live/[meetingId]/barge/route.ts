import { body, ok, withMeeting, type Ctx } from "@/lib/live/http";
import { onBarge } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, async (m) => {
    // playedMs(계약 BargeReq): 재생 시작부터 끊김까지. id: 끊은 말 — 그 utterance.barge가 other이거나 안 오면(잡음) 2초 미만일 때 다시 말한다
    // actionId(계약 제안): 화면이 그때 틀고 있던 미티 말 — 있으면 그 말을 끊긴 말로 (없으면 두뇌가 화면 줄을 흉내 내 고른다)
    const b = await body<{ id?: number; playedMs?: number; actionId?: string }>(req);
    const played = typeof b?.playedMs === "number" && Number.isFinite(b.playedMs) && b.playedMs >= 0 ? b.playedMs : undefined;
    onBarge(m, played, typeof b?.id === "number" ? b.id : undefined, typeof b?.actionId === "string" ? b.actionId : undefined);
    return ok();
  });
}
