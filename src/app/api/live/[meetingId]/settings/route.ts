import type { Intensity } from "@/lib/live/contract";
import { bad, body, ok, withMeeting, type Ctx } from "@/lib/live/http";
import { onParticipation, onSettings } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// 화면에서 바꿈. 올리는 건 confirmed=true + 회의 열쇠(controlToken)가 있어야 한다.
export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, async (m, token) => {
    const b = await body<{ intensity?: Intensity; confirmed?: boolean; participation?: number }>(req);
    // 참여도 다이얼(0~10)이 오면 그것으로, 아니면 예전처럼 강도로
    if (b && typeof b.participation === "number" && Number.isFinite(b.participation)) return ok(onParticipation(m, b.participation, !!b.confirmed, { token, by: "screen" }));
    if (!b || !b.intensity || !["high", "mid", "low"].includes(b.intensity)) return bad("intensity 또는 participation이 필요해요");
    return ok(onSettings(m, b.intensity, !!b.confirmed, { token, by: "screen" }));
  });
}
