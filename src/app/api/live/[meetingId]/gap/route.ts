import { bad, body, ok, withMeeting, type Ctx } from "@/lib/live/http";
import { onGap } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, async (m) => {
    const b = await body<{ after_id: number; ms: number }>(req);
    if (!b || typeof b.after_id !== "number" || typeof b.ms !== "number") return bad("after_id·ms가 필요해요");
    onGap(m, b.after_id, b.ms);
    return ok();
  });
}
