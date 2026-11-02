import { NextResponse } from "next/server";
import { bad, body, ok, withMeeting, type Ctx } from "@/lib/live/http";
import { onRespond } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, async (m) => {
    const b = await body<{ actionId: string; accept: boolean }>(req);
    if (!b?.actionId || typeof b.accept !== "boolean") return bad("actionId·accept가 필요해요");
    if (!onRespond(m, b.actionId, b.accept)) return NextResponse.json({ error: "손든 항목을 찾지 못했어요" }, { status: 404 });
    return ok();
  });
}
