import { NextResponse } from "next/server";
import { finishNotionAuth } from "@/lib/integrations/notion";
import { APP_URL } from "@/lib/notify";

export const dynamic = "force-dynamic";

// GET /api/integrations/notion/callback?code&state&iss → 토큰을 암호화해 저장하고 설정 화면으로
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) return NextResponse.json({ error: q.get("error") ?? "code·state가 없어요" }, { status: 400 });
  try {
    const { spaceId } = await finishNotionAuth({ code, state, iss: q.get("iss") });
    return NextResponse.redirect(`${APP_URL}/s/${encodeURIComponent(spaceId)}/settings?notion=ok`);
  } catch (e) {
    console.error("노션 연결 실패:", (e as Error).message); // 토큰·code는 찍지 않는다
    return NextResponse.json({ error: "노션 연결을 마치지 못했어요" }, { status: 400 });
  }
}
