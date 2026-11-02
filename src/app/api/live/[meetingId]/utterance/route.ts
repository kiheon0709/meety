import type { UtteranceReq } from "@/lib/live/contract";
import { bad, body, ok, withMeeting, type Ctx } from "@/lib/live/http";
import { onUtterance } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// echo: 미티가 말하던 동안 들어온 말 (음성 서버 final.echo를 그대로). barge: 미티를 끊은 말의 목소리 판정. 글 속 줄바꿈은 두뇌가 공백으로 바꾼다.
export async function POST(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, async (m) => {
    const b = await body<UtteranceReq>(req);
    if (!b || typeof b.id !== "number" || typeof b.text !== "string") return bad("id·text가 필요해요");
    // barge: 이 말이 미티를 끊은 말이면 그 목소리 판정 (member·other·unsure 말고는 버린다)
    const barge = b.barge === "member" || b.barge === "other" || b.barge === "unsure" ? b.barge : undefined;
    // turn: 말 끝 확률(음성 서버 Smart Turn final.turn, 계약 들어가기 전 확장) — 0~1 숫자만
    const turn = (b as { turn?: unknown }).turn;
    // echoSim(계약 제안): 화면이 잰 echo 말과 미티 문장의 겹침 0~1 — 두뇌가 미티 소리인지 사람 말인지 가를 때 같이 본다
    const echoSim = (b as { echoSim?: unknown }).echoSim;
    onUtterance(m, { id: b.id, t0: Number(b.t0) || 0, t1: Number(b.t1) || 0, text: b.text, speaker: b.speaker || undefined, echo: b.echo === true, ...(barge ? { barge } : {}), ...(typeof turn === "number" && turn >= 0 && turn <= 1 ? { turn } : {}), ...(typeof echoSim === "number" && echoSim >= 0 && echoSim <= 1 ? { echoSim } : {}) } as UtteranceReq);
    return ok();
  });
}
