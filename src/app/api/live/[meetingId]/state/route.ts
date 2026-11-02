import { NextResponse } from "next/server";
import { withMeeting, type Ctx } from "@/lib/live/http";
import { snapshot } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// 확인용 디버그 JSON (화면은 쓰지 않는다). 개발 중이거나 LIVE_DEBUG=1일 때만, 회의 열쇠가 있어야 (S9 V6)
export async function GET(req: Request, ctx: Ctx) {
  if (process.env.NODE_ENV === "production" && process.env.LIVE_DEBUG !== "1") return NextResponse.json({ error: "not found" }, { status: 404 });
  return withMeeting(req, ctx, (m) => NextResponse.json(snapshot(m), { headers: { "Cache-Control": "no-store" } }));
}
