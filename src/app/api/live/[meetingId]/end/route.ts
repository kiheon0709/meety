import { NextResponse } from "next/server";
import { withMeeting, type Ctx } from "@/lib/live/http";
import { endMeeting } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// 회의 끝 → EndMeetingRes { sessionId, items }
export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, async (m) => NextResponse.json(await endMeeting(m)));
}
