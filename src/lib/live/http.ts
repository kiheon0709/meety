// /api/live 라우트들이 같이 쓰는 것
import { NextResponse } from "next/server";
import { getMeeting, type Meeting } from "./meeting";

export type Ctx = { params: Promise<{ meetingId: string }> };

// 회의 번호만으로는 아무것도 못 하게, 시작할 때 화면에 준 controlToken을 함께 보내야 한다 (S9 V5·V6).
// 헤더 x-live-token 또는 ?token= (EventSource는 헤더를 못 붙여서). LIVE_INSECURE=1이면 끈다(급할 때 연결 시험용).
export function tokenOf(req: Request): string | undefined {
  return req.headers.get("x-live-token") ?? new URL(req.url).searchParams.get("token") ?? undefined;
}

export async function withMeeting(req: Request, ctx: Ctx, fn: (m: Meeting, token: string | undefined) => Promise<Response> | Response): Promise<Response> {
  const { meetingId } = await ctx.params;
  const m = getMeeting(meetingId);
  if (!m) return NextResponse.json({ error: "회의를 찾지 못했어요" }, { status: 404 });
  const token = tokenOf(req);
  if (process.env.LIVE_INSECURE !== "1" && token !== m.controlToken) return NextResponse.json({ error: "회의 열쇠(controlToken)가 맞지 않아요" }, { status: 401 });
  return fn(m, token);
}

export async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export const bad = (msg: string) => NextResponse.json({ error: msg }, { status: 400 });
export const ok = (data: object = {}) => NextResponse.json({ ok: true, ...data });
