import { NextResponse } from "next/server";
import { withMeeting, type Ctx } from "@/lib/live/http";
import { info } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// 회의 설정과 현재 상태 (다른 기기에서 같은 회의 열기) → MeetingInfo
export async function GET(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, (m) => NextResponse.json(info(m), { headers: { "Cache-Control": "no-store" } }));
}
