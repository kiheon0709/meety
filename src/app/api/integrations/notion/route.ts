import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections";
import { disconnectNotion } from "@/lib/integrations/notion";

export const dynamic = "force-dynamic";

// GET  /api/integrations/notion?spaceId= → 연결 상태 (토큰 없음)
// DELETE /api/integrations/notion?spaceId= → 끊기: 토큰 지우고 가져온 자료를 그 스페이스에서 뺌
async function guard(req: Request) {
  const spaceId = new URL(req.url).searchParams.get("spaceId") ?? "";
  const me = spaceId ? await getCurrentMember(spaceId) : undefined;
  return me ? spaceId : null;
}

export async function GET(req: Request) {
  const spaceId = await guard(req);
  if (!spaceId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const c = getConnection(spaceId, "notion");
  return NextResponse.json(c ? { connected: c.status === "ok", status: c.status, pages: Object.values((c.root.imported ?? {}) as object) } : { connected: false });
}

export async function DELETE(req: Request) {
  const spaceId = await guard(req);
  if (!spaceId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  disconnectNotion(spaceId);
  return NextResponse.json({ ok: true });
}
