import Link from "next/link";
import { getCommits } from "@/lib/head";
import { listSessions, liveRecordOf } from "@/lib/service";
import { buildMeetingView } from "@/lib/meeting-view";
import { processSessionAction } from "@/lib/actions";
import { ProcessingButton } from "@/components/ProcessingButton";
import { PageHead } from "@/components/PageHead";
import { AgentMark } from "@/components/Logo";
import { Chevron, Empty, fmtDate } from "@/components/ui";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 회의 목록: 회의마다 바뀐 결정·새로 정함·할 일 수를 먼저 (누르면 회의 뒤 정리 화면)
export default async function SessionsPage({ params }: PageProps<"/s/[id]/sessions">) {
  const { id } = await params;
  const sessions = listSessions(id, "meeting").slice().reverse();
  const commits = getCommits(id);

  return (
    <div className="max-w-[920px] space-y-5">
      <PageHead
        title="회의"
        sub="회의를 누르면 무엇이 무엇으로 바뀌었는지 볼 수 있어요."
        aside={
          <div className="flex flex-wrap gap-2">
            <Link href={`/s/${id}/record`} className="btn btn-sm btn-secondary">
              녹음으로 정리
            </Link>
            <Link href={`/s/${id}/sessions/new`} className="btn btn-sm btn-secondary">
              녹취 붙여넣기
            </Link>
          </div>
        }
      />
      {sessions.length === 0 && (
        <Empty>
          회의가 없어요.{" "}
          <Link href={`/live/new?space=${encodeURIComponent(id)}`} className="text-agent underline underline-offset-4">
            미티와 첫 회의
          </Link>
        </Empty>
      )}
      <ul className="space-y-3">
        {sessions.map((s, i) => {
          const pending = commits.filter((c) => c.session_id === s.id && c.status === "pending").length;
          const v = s.status === "done" ? buildMeetingView(id, s.id) : null;
          const rec = liveRecordOf(s);
          const solo = rec?.participants.length === 1;
          return (
            <li key={s.id} className="fade-up card" style={S(i + 1)}>
              <div className="flex items-center gap-4 px-4 sm:px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3 tabular-nums">
                    {fmtDate(s.held_at)}
                    {rec && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--agent-soft)] text-agent font-semibold pl-0.5 pr-1.5">
                        <AgentMark size={14} /> {solo ? "1:1" : "미티와"}
                      </span>
                    )}
                  </div>
                  <Link href={`/s/${id}/sessions/${s.id}`} className="font-semibold text-[16.5px] hover:underline underline-offset-4 decoration-black/20">
                    {s.title}
                  </Link>
                  <div className="text-[12.5px] text-ink-3 mt-0.5 truncate">{(rec?.participants ?? []).join(", ") || s.participants}</div>
                  {v && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[12px] font-semibold">
                      {v.changes.length > 0 && <span className="rounded-full bg-agent text-white px-2 py-0.5">바뀐 결정 {v.changes.length}</span>}
                      <span className="rounded-full bg-black/5 text-ink-2 px-2 py-0.5">새로 정함 {v.newDecisions.length}</span>
                      <span className="rounded-full bg-black/5 text-ink-2 px-2 py-0.5">할 일 {v.todos.length}</span>
                      {pending > 0 && <span className="rounded-full bg-orange/15 text-amber-ink px-2 py-0.5">확인할 것 {pending}</span>}
                    </div>
                  )}
                  {v?.changes[0]?.from && (
                    <div className="mt-2 text-[13px] leading-snug">
                      <span className="text-ink-3 line-through">{v.changes[0].from.title}</span> <span className="text-agent font-bold">→</span> <span className="font-medium">{v.changes[0].to.title}</span>
                    </div>
                  )}
                  {s.status === "pending" && <div className="mt-1 text-[12.5px] text-amber-ink">아직 정리 안 함</div>}
                  {s.status === "processing" && <div className="mt-1 text-[12.5px] text-agent">정리 중</div>}
                  {s.status === "error" && <div className="mt-1 text-[12.5px] text-red">정리 실패: {s.error}</div>}
                </div>
                {s.status !== "done" && s.status !== "processing" ? (
                  <form action={processSessionAction} className="shrink-0">
                    <input type="hidden" name="session_id" value={s.id} />
                    <input type="hidden" name="space_id" value={id} />
                    <ProcessingButton className="btn btn-sm btn-agent">{s.status === "error" ? "다시 정리" : "정리하기"}</ProcessingButton>
                  </form>
                ) : (
                  <Link href={`/s/${id}/sessions/${s.id}`} className="text-ink-3 hover:text-ink transition" aria-label="정리 보기">
                    <Chevron />
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
