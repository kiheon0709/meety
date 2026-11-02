import { NextResponse } from "next/server";
import { canAccessSpace } from "@/lib/auth";
import { ensureBriefing, getBriefing } from "@/lib/service";

export const dynamic = "force-dynamic";

// 브리핑이 다시 써지는 동안 화면이 폴링한다.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await canAccessSpace(id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const state = ensureBriefing(id);
  const b = getBriefing(id);
  return NextResponse.json({ state, created_at: b?.created_at ?? null }, { headers: { "Cache-Control": "no-store" } });
}
