import { NextResponse } from "next/server";
import { canAccessSpace } from "@/lib/auth";
import { docsForSpace } from "@/lib/live/docs";

export const dynamic = "force-dynamic";

// GET /api/live/docs?spaceId=… → 그 스페이스가 쓸 수 있는 자료(DocInfo[]). 스페이스를 안 주면 아무것도 안 준다 (S9 V9)
export async function GET(req: Request) {
  const spaceId = new URL(req.url).searchParams.get("spaceId");
  if (!spaceId) return NextResponse.json([]);
  if (!(await canAccessSpace(spaceId))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(docsForSpace(spaceId));
}
