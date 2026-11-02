import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/auth";
import { beginNotionAuth, NotionError } from "@/lib/integrations/notion";

export const dynamic = "force-dynamic";

// GET /api/integrations/notion/connect?spaceId= → 노션 인가 화면으로. 그 스페이스 멤버만
export async function GET(req: Request) {
  const spaceId = new URL(req.url).searchParams.get("spaceId") ?? "";
  const me = spaceId ? await getCurrentMember(spaceId) : undefined;
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.redirect(await beginNotionAuth(spaceId, me.id));
  } catch (e) {
    const status = e instanceof NotionError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
