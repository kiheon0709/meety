import { NextResponse } from "next/server";
import { canAccessSpace } from "@/lib/auth";
import type { Intensity, MeetingMode, StartMeetingReq, StartMeetingRes } from "@/lib/live/contract";
import { allowedDocIds, refreshDocs } from "@/lib/live/docs";
import { bad, body } from "@/lib/live/http";
import { startMeeting } from "@/lib/live/meeting";
import { ROLE_KINDS } from "@/lib/live/roles";

export const dynamic = "force-dynamic";

const INTENSITIES: Intensity[] = ["high", "mid", "low"];
const MODES: MeetingMode[] = ["decision", "brainstorm", "presentation"];

// 응답에 controlToken(계약 확장)이 붙는다. 화면은 이후 모든 /api/live/{id}/* 요청에 x-live-token(또는 ?token=)으로 보낸다.
export async function POST(req: Request) {
  const b = await body<StartMeetingReq & { budgetUsd?: number }>(req);
  if (!b?.spaceId || !b.title || !Array.isArray(b.agenda) || !INTENSITIES.includes(b.intensity)) return bad("spaceId·title·agenda·intensity가 필요해요");
  if (b.budgetUsd !== undefined && !(typeof b.budgetUsd === "number" && b.budgetUsd > 0 && b.budgetUsd <= 50)) return bad("budgetUsd는 0보다 크고 50 이하인 숫자예요");
  if (b.mode !== undefined && !MODES.includes(b.mode)) return bad("mode는 decision·brainstorm·presentation 가운데 하나예요");
  if (b.participation !== undefined && !(typeof b.participation === "number" && b.participation >= 0 && b.participation <= 10)) return bad("participation은 0~10 숫자예요");
  if (b.shadow !== undefined && !(Array.isArray(b.shadow) && b.shadow.every((k) => ROLE_KINDS.includes(k)))) return bad("shadow는 역할 이름 목록이에요");
  if (b.roles !== undefined && !(b.roles && typeof b.roles === "object" && Object.entries(b.roles).every(([k, v]) => ROLE_KINDS.includes(k as never) && typeof v === "boolean"))) return bad("roles는 {역할: true/false}예요");
  if (!(await canAccessSpace(b.spaceId))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await refreshDocs(allowedDocIds(b.spaceId, b.docIds ?? []));
  const m = startMeeting(b);
  const res: StartMeetingRes & { controlToken: string } = { meetingId: m.id, controlToken: m.controlToken };
  return NextResponse.json(res);
}
