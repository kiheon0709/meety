// 팀원 역할 7개와 참여도 다이얼 (docs/architecture/brain-design.md §2-3·2-4·2-6).
// 다이얼 하나(0~10)가 역할마다 어느 채널로 낼지·말 차례 강도·쿨다운·우선순위 엄격함·판단 리듬을 한 번에 정한다.
// 얼마나 자주 말할지에 고정 횟수 제한은 없다 — 팀이 StartMeetingReq.budget을 켤 때만 굴러가는 창으로 센다.
import type { ActionKind, Intensity, MeetingMode, RoleKind } from "./contract";

export const ROLE_KINDS: RoleKind[] = ["conflict", "owner_gap", "structure", "quiet_member", "research", "feedback", "suggest"];

// 높을수록 먼저 (소리 슬롯은 하나). 다이얼이 높으면 이 순서 대신 먼저 준비된 것부터(평평)
export const PRIORITY: Record<RoleKind, number> = { conflict: 7, owner_gap: 6, structure: 5, quiet_member: 4, research: 3, feedback: 2, suggest: 1 };

// 역할을 어디로 내나: 소리 / 손들기 / 카드(소리 없음) / 사설(당사자 화면에만) / 끔
export type Channel = "voice" | "hand" | "card" | "private" | "off";

export interface Profile {
  participation: number;
  intensity: Intensity; // 말 차례: 2 이하 손들기만(low), 3~6 gap 800(mid), 7 이상 gap 300(high)
  channel: Record<RoleKind, Channel>;
  cooldownScale: number; // 스스로 꺼낸 말 뒤 쉬는 시간 = TIMING.cooldownMs × 이 값
  flatPriority: boolean; // 7 이상: 우선순위보다 먼저 준비된 것부터
  rhythm: "batch" | "final"; // 3 이하: 발화를 모아서 한 번에 판단 (brain-design §2-7)
}

// 다이얼 → 역할별 채널 [제안]. 낮으면 손들기·카드 위주, 높으면 제안·피드백·리서치도 소리로
function channelFor(role: RoleKind, p: number): Channel {
  switch (role) {
    case "conflict":
      return p <= 2 ? "hand" : "voice";
    case "owner_gap":
      return p <= 4 ? "hand" : "voice";
    case "feedback":
      return p <= 3 ? "off" : p <= 5 ? "hand" : "voice";
    case "research":
      return p >= 8 ? "voice" : "card"; // voice면 카드와 함께 한 문장 말함
    case "structure":
      return p <= 3 ? "off" : p <= 6 ? "hand" : "voice";
    case "quiet_member":
      return p <= 1 ? "off" : "private";
    case "suggest":
      return p <= 4 ? "off" : p <= 7 ? "card" : "voice";
  }
}

export function profileOf(participation: number): Profile {
  const p = Math.max(0, Math.min(10, Math.round(participation)));
  return {
    participation: p,
    intensity: p <= 2 ? "low" : p <= 6 ? "mid" : "high",
    channel: Object.fromEntries(ROLE_KINDS.map((r) => [r, channelFor(r, p)])) as Record<RoleKind, Channel>,
    cooldownScale: p <= 4 ? 1.5 : p <= 6 ? 1 : p <= 8 ? 0.6 : 0.4,
    flatPriority: p >= 7,
    rhythm: p <= 3 ? "batch" : "final",
  };
}

// 다이얼 초깃값: participation이 있으면 그것, 없으면 mode, 그것도 없으면 intensity에서 [제안: decision 5 · brainstorm 8 · presentation 3 / high 7 · mid 5 · low 2]
export const MODE_DIAL: Record<MeetingMode, number> = { decision: 5, brainstorm: 8, presentation: 3 };
export const INTENSITY_DIAL: Record<Intensity, number> = { high: 7, mid: 5, low: 2 };
export function dialFrom(req: { participation?: number; mode?: MeetingMode; intensity: Intensity }): { participation: number; explicit: boolean } {
  if (typeof req.participation === "number" && Number.isFinite(req.participation)) return { participation: Math.max(0, Math.min(10, req.participation)), explicit: true };
  if (req.mode) return { participation: MODE_DIAL[req.mode], explicit: true };
  return { participation: INTENSITY_DIAL[req.intensity], explicit: false };
}

// 켜진 역할: 다이얼 채널이 끔이 아닌 것. roles로 덮어쓴다(true인데 다이얼이 끔이면 손들기·카드로 켠다)
export function resolveRoles(profile: Profile, roles: Partial<Record<RoleKind, boolean>> | undefined): Record<RoleKind, boolean> {
  return Object.fromEntries(ROLE_KINDS.map((r) => [r, roles?.[r] ?? profile.channel[r] !== "off"])) as Record<RoleKind, boolean>;
}
export function channelOf(profile: Profile, roles: Record<RoleKind, boolean>, kind: ActionKind): Channel {
  const r = kind as RoleKind;
  if (!ROLE_KINDS.includes(r) || !roles[r]) return "off";
  const ch = profile.channel[r];
  if (ch !== "off") return ch;
  return r === "research" || r === "suggest" ? "card" : r === "quiet_member" ? "private" : "hand";
}

// (선택) 팀이 켠 자발 소리 상한 — 굴러가는 창
export interface Budget {
  voicePer10Min: number;
  maxSentences: number;
  windowMin: number;
}
export function resolveBudget(b: { voicePer10Min?: number; maxSentences?: number } | undefined): Budget | undefined {
  if (!b) return undefined;
  const num = (x: unknown, min: number, max: number) => (typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : undefined);
  const voicePer10Min = num(b.voicePer10Min, 0, 60);
  const maxSentences = num(b.maxSentences, 1, 6);
  if (voicePer10Min === undefined && maxSentences === undefined) return undefined;
  return { voicePer10Min: voicePer10Min ?? 60, maxSentences: maxSentences ?? 6, windowMin: 10 };
}
// 어긋남은 되돌리기 비용이 가장 커서 상한을 빌릴 수 있다: 창 안에서 limit의 2배(최소 2번)까지 소리로, 그다음은 손들기
export const CONFLICT_BORROW = 2;
// 스스로 꺼내는 말(소리 슬롯을 쓰는 역할)과 한 번 말하면 쓰는 상한 몫
export const VOICE_COST: Partial<Record<ActionKind, number>> = { conflict: 1, owner_gap: 0.5, feedback: 1, structure: 1, research: 0.5, suggest: 1 };

export function usedBudget(ledger: { at: number; cost: number }[], now: number, windowMin: number): number {
  const from = now - windowMin * 60_000;
  return ledger.filter((x) => x.at > from).reduce((a, x) => a + x.cost, 0);
}
export function voiceAllowed(kind: ActionKind, used: number, budget: Budget | undefined): boolean {
  const cost = VOICE_COST[kind];
  if (cost === undefined || !budget) return true; // 부름 대답·설정 대답, 또는 상한을 안 켠 회의
  const limit = kind === "conflict" ? Math.max(CONFLICT_BORROW, budget.voicePer10Min * 2) * (budget.voicePer10Min > 0 ? 1 : 0) : budget.voicePer10Min;
  return used + cost <= limit;
}
