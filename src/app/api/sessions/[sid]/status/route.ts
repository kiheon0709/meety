import { NextResponse } from "next/server";
import { getStage } from "@/lib/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const { sid } = await ctx.params;
  const s = getStage(sid);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(s, { headers: { "Cache-Control": "no-store" } });
}
