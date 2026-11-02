import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/auth";
import { body } from "@/lib/live/http";
import { exportDecisions } from "@/lib/integrations/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/export {spaceId} → 승인된 결정을 연결된 곳(노션 결정 DB·디스코드)으로. 멱등: 여러 번 눌러도 하나
export async function POST(req: Request) {
  const b = await body<{ spaceId?: string }>(req);
  const me = b?.spaceId ? await getCurrentMember(b.spaceId) : undefined;
  if (!b?.spaceId || !me) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await exportDecisions(b.spaceId));
}
