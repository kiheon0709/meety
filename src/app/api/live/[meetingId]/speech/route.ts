import { ok, withMeeting, type Ctx } from "@/lib/live/http";
import { onSpeechStart } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// 계약 밖 확장: 음성 서버 speech_start를 그대로 넘기면 미티가 말을 시작하려던 걸 멈춘다.
// 안 불러도 동작한다(그때는 barge_in으로 끊긴다).
export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, (m) => {
    onSpeechStart(m);
    return ok();
  });
}
