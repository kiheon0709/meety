import { bad, body, ok, withMeeting, type Ctx } from "@/lib/live/http";
import { onPartial, onPreAnswer } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// 받아쓰기 중간 결과 (brain-design §2-7·§8-12 제안). 화면이 받는 partial을 그대로 넘긴다(약 0.8초 간격). stable은 음성 서버가 준 안정 글자 수(계약 partial.stable, 없으면 0 — 아무것도 안 봄). 어긋남 미리 판단은 참여도 7 이상에서만, 부름·1:1 대답 미리 만들기는 늘
export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, async (m) => {
    const b = await body<{ id: number; text: string; stable?: number }>(req);
    if (!b || typeof b.id !== "number" || typeof b.text !== "string") return bad("id·text가 필요해요");
    const stable = typeof b.stable === "number" && b.stable >= 0 ? b.stable : undefined;
    const text = b.text.slice(0, 2000);
    onPreAnswer(m, b.id, text, stable);
    void onPartial(m, b.id, text, stable).catch(() => {});
    return ok();
  });
}
