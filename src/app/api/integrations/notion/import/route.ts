import { NextResponse } from "next/server";
import { canAccessSpace } from "@/lib/auth";
import { body } from "@/lib/live/http";
import { importNotionPage, NotionError } from "@/lib/integrations/notion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/notion/import {spaceId, page} → 그 스페이스 노션 연결로 페이지 하나를 자료로 (DocInfo)
export async function POST(req: Request) {
  const b = await body<{ spaceId?: string; page?: string }>(req);
  if (!b?.spaceId || !b.page) return NextResponse.json({ error: "프로젝트와 노션 페이지 주소가 필요해요" }, { status: 400 });
  if (!(await canAccessSpace(b.spaceId))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await importNotionPage(b.spaceId, b.page));
  } catch (e) {
    if (e instanceof NotionError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("노션 가져오기 실패:", (e as Error).message);
    return NextResponse.json({ error: "노션 페이지를 가져오지 못했어요" }, { status: 500 });
  }
}
