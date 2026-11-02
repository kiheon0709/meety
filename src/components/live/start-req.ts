// 회의 시작 요청(StartMeetingReq)의 호스트·회의 종류·역할. 화면(NewMeetingForm)과 E2E 도구(scripts/e2e-live.ts)가 같이 쓴다
import type { Intensity, MeetingMode, RoleKind, StartMeetingReq } from "@/lib/live/contract";

// participation: 참여도 다이얼(0~10)의 초깃값 [기헌 결정 대기 중인 제안값]
export const MODES: Record<MeetingMode, { label: string; line: string; participation: number }> = {
  decision: { label: "결정 회의", line: "정한 것과 어긋나거나 담당이 비면 짚어요", participation: 5 },
  brainstorm: { label: "브레인스토밍", line: "제안·피드백·자료 찾기도 소리로 해요", participation: 8 },
  presentation: { label: "발표", line: "끼어들지 않고 손만 들어요", participation: 3 },
};

export const clampParticipation = (n: number) => Math.min(10, Math.max(0, Math.round(n)));
// 다이얼이 없던 회의(옛 화면·옛 두뇌)는 강도로 어림
const FROM_INTENSITY: Record<Intensity, number> = { high: 7, mid: 5, low: 2 };
export const participationOf = (o: { intensity: Intensity; participation?: number }) => (o.participation !== undefined ? clampParticipation(o.participation) : FROM_INTENSITY[o.intensity]);

export const ROLE_LABEL: Record<RoleKind, string> = {
  conflict: "지난 결정 확인",
  owner_gap: "업무 분담 제안",
  structure: "갈등 정리",
  quiet_member: "조용한 팀원",
  research: "팀 자료 리서치",
  feedback: "피드백",
  suggest: "제안",
};

export const ROLES: RoleKind[] = ["conflict", "owner_gap", "structure", "quiet_member", "research", "feedback", "suggest"];
export const allRoles = (): Record<RoleKind, boolean> => Object.fromEntries(ROLES.map((r) => [r, true])) as Record<RoleKind, boolean>;

// 호스트: 고른 사람이 참석자에 있으면 그 사람, 아니면 첫 참석자. 역할은 하나라도 끈 게 있을 때만 7개 다 싣는다 (다 켜져 있으면 두뇌가 회의 종류 기본값)
export function withHostMode<T extends StartMeetingReq>(
  req: T,
  o: { host?: string | null; mode: MeetingMode; roles?: StartMeetingReq["roles"]; participation?: number },
): T & Pick<StartMeetingReq, "host" | "mode" | "roles" | "participation"> {
  const ps = req.participants ?? [];
  const host = o.host && ps.includes(o.host) ? o.host : ps[0];
  const participation = clampParticipation(o.participation ?? MODES[o.mode].participation);
  const roles = o.roles && Object.values(o.roles).some((v) => v === false) ? { ...allRoles(), ...o.roles } : undefined;
  return { ...req, ...(host ? { host } : {}), mode: o.mode, participation, ...(roles ? { roles } : {}) };
}

// "conflict,research,-suggest" → { conflict: true, research: true, suggest: false }. 모르는 이름은 버린다
export function parseRoles(s: string | undefined): StartMeetingReq["roles"] {
  if (!s) return undefined;
  const out: Partial<Record<RoleKind, boolean>> = {};
  for (const raw of s.split(",").map((x) => x.trim())) {
    const off = raw.startsWith("-");
    const k = raw.replace(/^-/, "") as RoleKind;
    if (ROLES.includes(k)) out[k] = !off;
  }
  return out;
}
