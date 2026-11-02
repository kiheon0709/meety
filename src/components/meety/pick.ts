// 지금 캔버스에 무엇을 띄우나. 우선순위: 고정한 것 > 지금 말·손에 붙은 두뇌 show > 그 말·손의 근거로 스스로 >
// 혼자 온 show(리서치 카드처럼 소리 없이 보여 주는 것, ttl 동안) > 방금 바뀐 것 카드(8초)
import type { CanvasSpec } from "@/lib/live/contract";
import { pendingHands, showSpeech, type LiveState } from "@/components/live/state";
import { autoCanvas } from "./canvas";

export type Picked = { actionId: string; spec: CanvasSpec } | null;

export function pickCanvas(s: LiveState, o: { pinned?: string | null; closed?: string | null; liveShow: string | null; cardFresh?: string | null }): Picked {
  if (o.pinned) return s.shown.find((x) => x.actionId === o.pinned) ?? null;
  const sp = showSpeech(s) && s.speech?.status !== "preparing" ? s.speech : undefined;
  const hand = pendingHands(s)[0];
  const act = sp?.actionId ?? hand?.actionId;
  const card = o.cardFresh ? s.cards.find((c) => c.cardId === o.cardFresh) : undefined;
  let c: Picked = null;
  if (act && s.canvas?.actionId === act) c = s.canvas;
  else if (sp) c = withSpec(sp.actionId, autoCanvas({ evidence: sp.evidence }));
  else if (hand) c = withSpec(hand.actionId, autoCanvas({ evidence: hand.evidence }));
  else if (s.canvas && o.liveShow === s.canvas.actionId) c = s.canvas;
  else if (card) c = withSpec(card.cardId, autoCanvas({ evidence: [], card }));
  return c && c.actionId !== o.closed ? { actionId: c.actionId, spec: c.spec } : null;
}
const withSpec = (actionId: string, spec: CanvasSpec | null): Picked => (spec ? { actionId, spec } : null);
