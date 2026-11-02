import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, CircleCheck, CircleDashed, CircleAlert } from "lucide-react";
import { getHead } from "@/lib/head";
import { getCurrentMember } from "@/lib/auth";
import { getSources, getSpace, listMembers, liveRecordOf } from "@/lib/service";
import { buildMeetingView, type MeetingView } from "@/lib/meeting-view";
import { processSessionAction } from "@/lib/actions";
import { CommitCard } from "@/components/CommitCard";
import { ProcessingStatus } from "@/components/ProcessingStatus";
import { ChangeCard, MeetyActs, TodoRow } from "@/components/Recap";
import { AgentMark } from "@/components/Logo";
import { Avatar, Chevron, TypeBadge, fmtDate } from "@/components/ui";
import type { LiveRecord, Member } from "@/lib/types";
import type { Usage } from "@/lib/agent";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 회의 뒤 정리 (uiux-redesign.md §5). 첫 화면 10초 안에 "무엇이 무엇으로 바뀌었나"가 보이게:
// 가운데 위 = 바뀐 결정 카드, 왼쪽 = 익숙한 회의록(안건별 요약·할 일·안건 체크). 휴대폰은 바뀐 결정이 맨 위.
export default async function SessionPage({ params }: PageProps<"/s/[id]/sessions/[sid]">) {
  const { id, sid } = await params;
  const view = buildMeetingView(id, sid);
  if (!view) notFound();
  const { session } = view;
  const space = getSpace(id)!;
  const members = listMembers(id);
  const me = await getCurrentMember(id);
  const nodes = new Map(getHead(id).map((n) => [n.id, n]));
  const record = liveRecordOf(session);
  const usage = session.usage_json ? (JSON.parse(session.usage_json) as Usage & { skipped?: string[] }) : null;
  const topics = session.topics_json ? (JSON.parse(session.topics_json) as { topics: string[]; one_line: string }) : null;
  const people = (record?.participants.length ? record.participants : session.participants.split(",").map((s) => s.trim())).filter(Boolean);
  const solo = people.length === 1;
  const inFlight = session.status === "processing";
  const done = session.status === "done";
  const pendingCount = new Set([...view.changes, ...view.newDecisions].filter((c) => c.commit.status === "pending").map((c) => c.commit.id)).size + view.pendingOther.length;
  const cards = view.changes.length ? view.changes : view.newDecisions;

  const stats = [
    { n: view.changes.length, label: "바뀐 결정", href: "#changes", tone: "agent" },
    { n: view.newDecisions.length, label: "새로 정함", href: "#changes", tone: "" },
    { n: view.todos.length, label: "할 일", href: "#todos", tone: "" },
    { n: pendingCount, label: "확인할 것", href: "#changes", tone: pendingCount ? "orange" : "" },
  ];

  return (
    <div className="max-w-[1120px]">
      <header className="fade-up" style={S(0)}>
        <Link href={`/s/${id}/sessions`} className="text-[12px] text-ink-3 hover:text-ink transition">
          ← 회의
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-[24px] sm:text-[28px] font-bold tracking-[-0.03em] leading-tight">{session.title}</h1>
          {record && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--agent-soft)] text-agent text-[11.5px] font-semibold pl-0.5 pr-2 py-0.5">
              <AgentMark size={18} /> {solo ? "1:1 · 미티와 둘이" : "미티와 한 회의"}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
          <span>{fmtDate(session.held_at)}</span>
          <span className="inline-flex items-center gap-1">
            {people.map((p) => (
              <Avatar key={p} name={p} color={members.find((m) => m.name === p)?.color} size={20} />
            ))}
            <span className="ml-1">{people.join(", ")}</span>
          </span>
        </div>
        {topics?.one_line && <p className="mt-2 text-[14.5px] text-ink-2 leading-relaxed max-w-[760px] line-clamp-3 sm:line-clamp-none">{topics.one_line}</p>}
      </header>

      {inFlight && (
        <div className="fade-up mt-5" style={S(1)}>
          <ProcessingStatus sessionId={sid} initial={{ status: session.status, stage: session.stage, stage_detail: session.stage_detail, error: session.error }} />
        </div>
      )}
      {!inFlight && !done && (
        <div className="fade-up mt-5 card p-5 flex flex-wrap items-center justify-between gap-3" style={S(1)}>
          <div className="text-[14px]">
            {session.status === "error" ? (
              <>
                정리하다가 멈췄어요 · <span className="font-mono text-[12px] text-ink-3">{session.error}</span>
              </>
            ) : (
              "받아 적은 말은 들어왔어요. 아직 무엇이 바뀌었는지는 안 봤어요."
            )}
          </div>
          <form action={processSessionAction}>
            <input type="hidden" name="session_id" value={sid} />
            <input type="hidden" name="space_id" value={id} />
            <button className="btn btn-md btn-agent">{session.status === "error" ? "다시 정리" : "정리하기"}</button>
          </form>
        </div>
      )}

      {done && (
        <nav className="fade-up mt-5 grid grid-cols-4 gap-2 sm:gap-3" style={S(1)} aria-label="이 회의 숫자">
          {stats.map((s) => (
            <a
              key={s.label}
              href={s.href}
              className={`rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 transition hover:-translate-y-0.5 ${
                s.tone === "agent" && s.n ? "bg-agent text-white" : s.tone === "orange" ? "bg-orange/15 text-amber-ink" : "card"
              }`}
            >
              <div className={`text-[11.5px] sm:text-[12.5px] font-semibold ${s.tone === "agent" && s.n ? "text-white/85" : s.tone ? "" : "text-ink-3"}`}>{s.label}</div>
              <div className="text-[24px] sm:text-[30px] font-bold tabular-nums tracking-[-0.03em] leading-none mt-1">{s.n}</div>
            </a>
          ))}
        </nav>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[290px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
        {/* 가운데: 바뀐 결정 → 확인할 것 → 미티가 한 일 → 녹취 (휴대폰에선 이게 먼저) */}
        <div className="min-w-0 space-y-7 lg:order-2">
          {done && (
            <section id="changes" className="scroll-mt-20">
              <h2 className="fade-up flex flex-wrap items-baseline gap-x-2 text-[17px] font-bold tracking-[-0.02em] mb-3" style={S(2)}>
                {view.changes.length ? (
                  <>
                    이번 회의에서 바뀐 결정 <span className="text-agent tabular-nums">{view.changes.length}건</span>
                  </>
                ) : view.newDecisions.length ? (
                  <>
                    바뀐 결정은 없어요 <span className="text-[13px] font-medium text-ink-3">새로 정한 것 {view.newDecisions.length}건</span>
                  </>
                ) : (
                  "바뀌거나 새로 정한 결정은 없어요"
                )}
              </h2>
              <div className="space-y-4">
                {cards.map((c, i) => (
                  <ChangeCard key={c.key} issue={c} space={space} members={members} approvals={view.approvals} me={me} index={i} />
                ))}
              </div>
              {view.changes.length > 0 && view.newDecisions.length > 0 && (
                <details className="mt-4 group">
                  <summary className="cursor-pointer text-[13.5px] font-semibold text-ink-2 inline-flex items-center gap-1.5">
                    <Chevron className="transition-transform group-open:rotate-90" /> 새로 정한 것 {view.newDecisions.length}건
                  </summary>
                  <div className="mt-3 space-y-4">
                    {view.newDecisions.map((c, i) => (
                      <ChangeCard key={c.key} issue={c} space={space} members={members} approvals={view.approvals} me={me} index={i + cards.length} />
                    ))}
                  </div>
                </details>
              )}
            </section>
          )}

          {view.pendingOther.length > 0 && (
            <section className="scroll-mt-20">
              <h2 className="text-[17px] font-bold tracking-[-0.02em] mb-1">
                확인이 필요한 것 <span className="text-amber-ink tabular-nums">{view.pendingOther.length}</span>
              </h2>
              <p className="text-[13px] text-ink-3 mb-3">미티가 제안하고, 팀이 확인하면 확정돼요. 누가 확인했는지 남아요.</p>
              <div className="space-y-3">
                {view.pendingOther.map((c, i) => (
                  <CommitCard key={c.id} commit={c} space={space} nodes={nodes} members={members} approvals={view.approvals} me={me} index={i} />
                ))}
              </div>
            </section>
          )}

          {record && record.meety.length > 0 && (
            <section>
              <h2 className="text-[17px] font-bold tracking-[-0.02em] mb-3 flex items-center gap-2">
                <AgentMark size={24} /> 미티가 회의 중에 한 일 <span className="text-ink-3 font-medium text-[14px]">{record.meety.length}</span>
              </h2>
              <MeetyActs items={record.meety} />
            </section>
          )}

          {view.rejected.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-[13px] text-ink-3 inline-flex items-center gap-1.5">
                <Chevron className="transition-transform group-open:rotate-90" /> 거절·되돌린 것 {view.rejected.length}
              </summary>
              <div className="mt-3 space-y-3">
                {view.rejected.map((c, i) => (
                  <CommitCard key={c.id} commit={c} space={space} nodes={nodes} members={members} approvals={view.approvals} me={me} index={i} />
                ))}
              </div>
            </details>
          )}

          <details className="card group overflow-hidden">
            <summary className="px-5 py-3.5 text-[14px] cursor-pointer select-none flex items-center gap-2 text-ink-2 hover:text-ink">
              <Chevron className="transition-transform group-open:rotate-90" /> 녹취 원문
              {usage && <span className="ml-auto text-[11px] text-ink-3 font-mono">미티가 {(usage.ms / 1000).toFixed(0)}초 동안 정리</span>}
            </summary>
            <ol className="px-5 pb-5 space-y-1.5 text-[14px] [box-shadow:inset_0_0.5px_0_var(--line)] pt-4">
              {getSources(sid).map((s) => (
                <li key={s.id} id={`u${s.idx}`} className="flex gap-2.5">
                  <span className="text-ink-3/60 text-[11px] font-mono w-6 shrink-0 text-right pt-1">{s.idx}</span>
                  <span>
                    <span className="font-semibold">{s.speaker}</span> <span className="text-ink-2">{s.text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </details>

          <div className="card-agent p-5 flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">다음 회의 준비</div>
              <div className="text-[13px] text-ink-2">이번 회의에서 남은 것과 참석자·설정을 채워서 열어요</div>
            </div>
            <Link href={`/live/new?space=${encodeURIComponent(id)}`} className="btn btn-md btn-dark">
              미티와 다음 회의 <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        {/* 왼쪽: 익숙한 회의록 */}
        <aside className="lg:order-1 lg:sticky lg:top-[72px] space-y-4">
          <Minutes view={view} record={record} members={members} spaceId={id} />
        </aside>
      </div>
    </div>
  );
}

function Minutes({ view, record, members, spaceId }: { view: MeetingView; record: LiveRecord | null; members: Member[]; spaceId: string }) {
  return (
    <>
      <section className="card p-4 sm:p-5">
        <h2 className="text-[15px] font-bold tracking-[-0.02em]">회의록</h2>
        <p className="text-[12px] text-ink-3 mt-0.5">안건별로 이번에 나온 것</p>
        {view.topics.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-3">정리가 끝나면 여기에 안건별로 모여요.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {view.topics.map((t) => (
              <div key={t.topic}>
                <div className="text-[13.5px] font-bold flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[3px] bg-agent/70" />
                  {t.topic}
                </div>
                <ul className="mt-1.5 space-y-1.5 pl-3.5">
                  {t.lines.map((l) => (
                    <li key={l.nodeId} className="text-[13px] leading-snug flex items-start gap-1.5">
                      <span className="mt-[1px] shrink-0">
                        <TypeBadge type={l.type} />
                      </span>
                      <Link href={`/s/${spaceId}/n/${l.nodeId}`} className={`hover:underline underline-offset-2 ${l.status === "rejected" || l.status === "withdrawn" ? "text-ink-3 line-through" : ""}`}>
                        {l.title}
                      </Link>
                      {l.changed && <span className="shrink-0 rounded-full bg-[var(--agent-soft)] text-agent text-[10.5px] font-semibold px-1.5">바뀜</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section id="todos" className="card p-4 sm:p-5 scroll-mt-20">
        <h2 className="text-[15px] font-bold tracking-[-0.02em]">
          할 일 <span className="text-ink-3 font-medium">{view.todos.length}</span>
        </h2>
        {view.todos.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-3">이번 회의에서 나온 할 일이 없어요.</p>
        ) : (
          <ul className="mt-2 divide-hair">
            {view.todos.map((t) => (
              <TodoRow key={t.nodeId} t={t} members={members} spaceId={spaceId} />
            ))}
          </ul>
        )}
      </section>

      {record && record.checklist.length > 0 && (
        <section className="card p-4 sm:p-5">
          <h2 className="text-[15px] font-bold tracking-[-0.02em]">안건 체크</h2>
          <p className="text-[12px] text-ink-3 mt-0.5">회의 전에 적은 “끝날 때 나와야 할 것”</p>
          <ul className="mt-2 space-y-2">
            {record.checklist.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                {c.status === "done" ? (
                  <CircleCheck className="h-4 w-4 mt-[1px] shrink-0 text-agent" />
                ) : c.status === "no_owner" ? (
                  <CircleAlert className="h-4 w-4 mt-[1px] shrink-0 text-orange" />
                ) : (
                  <CircleDashed className="h-4 w-4 mt-[1px] shrink-0 text-ink-3" />
                )}
                <div className="min-w-0">
                  <span className="text-ink-3">{c.agenda} · </span>
                  <span className="font-semibold">{c.expected}</span>
                  {c.note && <div className="text-[12px] text-ink-2">{c.note}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
