import Link from "next/link";
import { getCurrentMember } from "@/lib/auth";
import { getCommits, getHead } from "@/lib/head";
import { ensureBriefing, getBriefing, getSpace, lastLiveSession, listMembers, listSessions } from "@/lib/service";
import { buildMeetingView } from "@/lib/meeting-view";
import { AgentMark } from "@/components/Logo";
import { PageHead } from "@/components/PageHead";
import { listFeed } from "@/lib/events";
import { voteAction } from "@/lib/actions";
import { BriefingWatcher } from "@/components/BriefingWatcher";
import { TellBar } from "@/components/TellBar";
import { Feed, buildPending } from "@/components/Feed";
import { Judgement } from "@/components/Judgement";
import { Chevron, SectionTitle, fmtDateShort } from "@/components/ui";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 브리핑 마크다운에서 첫 목록 몇 줄만 뽑아 "라벨 + 내용"으로. 홈 카드 미리보기용.
function briefPreview(md: string, max = 4): { label: string | null; text: string }[] {
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .slice(0, max)
    .map((l) => {
      const t = l.replace(/^[-*]\s+/, "");
      const m = t.match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
      return m ? { label: m[1], text: m[2].replace(/\*\*/g, "") } : { label: null, text: t.replace(/\*\*/g, "") };
    });
}

// 프로젝트 홈 = 갈피가 이 프로젝트에서 한 일. 사람이 결론 내야 하는 것만 맨 위.
export default async function SpaceHome({ params }: PageProps<"/s/[id]">) {
  const { id } = await params;
  const space = getSpace(id)!;
  const me = await getCurrentMember(id);
  const members = listMembers(id);
  const commits = getCommits(id);
  const head = getHead(id);
  const openQ = head.filter((n) => n.type === "question" && n.status === "open");
  const openA = head.filter((n) => n.type === "action" && n.status === "open");
  const sessions = listSessions(id, "meeting");
  const unprocessed = sessions.filter((s) => s.status === "pending");
  const errored = sessions.filter((s) => s.status === "error");
  const { map: pendingMap, pendingCommits, conflicts } = buildPending(space, members, me, commits);
  const feed = listFeed(id, 40);
  const briefing = getBriefing(id);
  const briefState = ensureBriefing(id);
  const lastMeeting = sessions.filter((s) => s.status === "done").at(-1);
  const sinceLast = lastMeeting ? feed.filter((e) => e.created_at >= lastMeeting.held_at).length : feed.length;
  const applied = commits.filter((c) => c.status === "applied" && !c.reverted).length;
  const today = new Date().toISOString().slice(0, 10);
  const lastView = lastMeeting ? buildMeetingView(id, lastMeeting.id) : null;
  const lastLive = lastLiveSession(id);
  const leftover = lastLive?.record.checklist.filter((c) => c.status !== "done") ?? [];
  const noOwner = openA.filter((n) => !n.owner);
  const judge = [
    ...conflicts.map((c) => ({ kind: "conflict" as const, space, commit: c.commit, info: c.info })),
    ...errored.map((se) => ({ kind: "error" as const, space, session: se })),
    ...openA.filter((n) => n.due && n.due < today && me && n.owner === me.name).map((n) => ({ kind: "overdue" as const, space, node: n })),
  ];

  if (!commits.length && !unprocessed.length && !errored.length && !sessions.some((s) => s.status === "processing")) {
    return (
      <div className="fade-up max-w-2xl mx-auto text-center py-14" style={S(2)}>
        <AgentMark size={72} className="mx-auto" />
        <h2 className="mt-4 text-[1.6rem] font-bold tracking-[-0.03em]">첫 회의를 미티와 해 보세요</h2>
        <p className="mt-2 text-ink-2">노트북을 테이블 가운데 두고 시작하면 미티가 같이 듣고, 끝나면 무엇을 정했는지 정리해요.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href={`/live/new?space=${encodeURIComponent(id)}`} className="btn btn-lg btn-agent">
            미티와 회의 시작
          </Link>
          <Link href={`/s/${id}/sessions/new`} className="btn btn-lg btn-secondary">
            지난 회의 녹취 붙여넣기
          </Link>
        </div>
        <p className="mt-5 text-[13px] text-ink-3">
          팀원은{" "}
          <Link href={`/s/${id}/members`} className="text-agent hover:underline underline-offset-4">
            팀원
          </Link>
          에서 초대 링크로 부를 수 있어요.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-7 max-w-[1120px]">
      <PageHead
        title="프로젝트 홈"
        sub={`${lastMeeting ? `${fmtDateShort(lastMeeting.held_at)} 회의 뒤로 미티가 한 일 ${sinceLast}가지` : "미티가 일하는 중이에요"} · 반영한 업데이트 ${applied}개${judge.length === 0 ? " · 지금 결론이 필요한 건 없어요" : ""}`}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="fade-up card-agent p-5" style={S(1)}>
          <div className="flex items-center gap-2 text-[15px] font-bold">
            <AgentMark size={26} /> 다음 회의 준비
          </div>
          <p className="text-[13px] text-ink-2 mt-1">지난 회의에서 남은 것이에요. 회의를 열면 안건으로 넣을 수 있게 채워 둬요.</p>
          <ul className="mt-3 space-y-1.5 text-[13.5px]">
            {leftover.slice(0, 3).map((c, i) => (
              <li key={`l${i}`} className="flex items-start gap-2">
                <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${c.status === "no_owner" ? "bg-orange" : "bg-ink-3"}`} />
                <span>
                  <span className="text-ink-3">{c.agenda} · </span>
                  {c.expected} {c.status === "no_owner" ? "(담당 없음)" : "(아직)"}
                </span>
              </li>
            ))}
            {openQ.slice(0, 3).map((n) => (
              <li key={n.id} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 bg-orange" />
                <Link href={`/s/${id}/issues/${n.id}`} className="hover:underline underline-offset-2">
                  {n.title}
                </Link>
              </li>
            ))}
            {noOwner.length > 0 && (
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 bg-orange" />
                <Link href={`/s/${id}/todos`} className="hover:underline underline-offset-2">
                  담당 없는 할 일 {noOwner.length}개
                </Link>
              </li>
            )}
            {!leftover.length && !openQ.length && !noOwner.length && <li className="text-ink-3">남은 게 없어요. 새 안건으로 시작하면 돼요.</li>}
          </ul>
          <Link href={`/live/new?space=${encodeURIComponent(id)}`} className="btn btn-md btn-agent mt-4">
            미티와 회의 열기
          </Link>
        </section>

        {lastMeeting && lastView && (
          <Link href={`/s/${id}/sessions/${lastMeeting.id}`} className="fade-up card p-5 lift block" style={S(2)}>
            <div className="text-[12px] text-ink-3">최근 회의 · {fmtDateShort(lastMeeting.held_at)}</div>
            <div className="text-[16px] font-bold mt-0.5 leading-snug">{lastMeeting.title}</div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                { n: lastView.changes.length, l: "바뀐 결정", on: lastView.changes.length > 0 },
                { n: lastView.newDecisions.length, l: "새로 정함" },
                { n: lastView.todos.length, l: "할 일" },
              ].map((x) => (
                <div key={x.l} className={`rounded-xl px-3 py-2 ${x.on ? "bg-agent text-white" : "bg-black/[0.035]"}`}>
                  <div className={`text-[11.5px] font-semibold ${x.on ? "text-white/85" : "text-ink-3"}`}>{x.l}</div>
                  <div className="text-[22px] font-bold tabular-nums leading-none mt-1">{x.n}</div>
                </div>
              ))}
            </div>
            {lastView.changes[0] && (
              <div className="mt-3 text-[13px] leading-snug">
                <span className="text-ink-3 line-through">{lastView.changes[0].from?.title}</span> <span className="text-agent font-bold">→</span>{" "}
                <span className="font-semibold">{lastView.changes[0].to.title}</span>
              </div>
            )}
            <div className="mt-3 text-[13px] font-semibold text-agent inline-flex items-center gap-0.5">
              정리 보기 <Chevron />
            </div>
          </Link>
        )}
      </div>

      <div className="fade-up" style={S(3)}>
        <TellBar spaceId={id} />
      </div>

      {judge.length > 0 && (
        <section className="fade-up" style={S(2)}>
          <SectionTitle>지금 결론이 필요한 것</SectionTitle>
          <Judgement items={judge} />
        </section>
      )}

      {unprocessed.length > 0 && (
        <section className="fade-up" style={S(3)}>
          <SectionTitle>아직 정리 안 한 회의</SectionTitle>
          <div className="card divide-hair overflow-hidden">
            {unprocessed.map((s) => (
              <Link key={s.id} href={`/s/${id}/sessions/${s.id}`} className="p-4 flex items-center gap-4 hover:bg-black/2 transition">
                <span className="h-5 w-5 rounded-full bg-orange/15 text-orange flex items-center justify-center text-[11px] font-bold shrink-0">!</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-[15px]">{s.title}</div>
                  <div className="text-[12px] text-ink-3 mt-0.5">{fmtDateShort(s.held_at)} · 녹취는 들어왔고 아직 안 뽑았어요</div>
                </div>
                <Chevron className="text-ink-3" />
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="fade-up min-w-0" style={S(3)}>
          <SectionTitle
            aside={
              <Link href={`/s/${id}/history`} className="text-[13px] text-blue hover:underline underline-offset-4 inline-flex items-center gap-0.5">
                전체 히스토리 <Chevron />
              </Link>
            }
          >
            미티가 한 일
          </SectionTitle>
          <Feed items={feed} pending={pendingMap} />
        </section>

        <aside className="space-y-6">
          {/* 브리핑 */}
          <section className="fade-up card p-5" style={S(3)}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-semibold">다음 회의 전 브리핑</div>
              {briefState === "writing" ? (
                <BriefingWatcher spaceId={id} createdAt={briefing?.created_at ?? null} compact />
              ) : (
                briefing && (
                  <Link href={`/s/${id}/briefing`} className="text-[12px] text-blue hover:underline underline-offset-4">
                    전체 보기
                  </Link>
                )
              )}
            </div>
            {briefing ? (
              <>
                <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2 leading-snug">
                  {briefPreview(briefing.content).map((b, i) => (
                    <li key={i} className="line-clamp-2">
                      {b.label && <span className="font-semibold text-ink">{b.label} </span>}
                      {b.text}
                    </li>
                  ))}
                </ul>
                <Link href={`/s/${id}/briefing`} className="btn btn-sm btn-secondary mt-3 w-full">
                  읽기
                </Link>
              </>
            ) : (
              <p className="mt-2 text-[13.5px] text-ink-2 leading-relaxed">{briefState === "writing" ? "미티가 첫 브리핑을 쓰고 있어요. 10초쯤 걸려요." : "반영된 맥락이 생기면 미티가 브리핑을 써요."}</p>
            )}
          </section>

          {/* 물어본 것 */}
          {pendingCommits.length > 0 && (
            <section className="fade-up card p-5" style={S(4)}>
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-semibold">
                  확인할 것 <span className="text-ink-3 font-normal">{pendingCommits.length}</span>
                </div>
                <Link href={`/s/${id}/decisions`} className="text-[12px] text-blue hover:underline underline-offset-4">
                  결정 기록
                </Link>
              </div>
              <p className="mt-1 text-[12px] text-ink-3">같이 정한 걸 바꾸는 것들이에요. 반대가 없으면 미티가 그대로 확정해요.</p>
              <ul className="mt-2 divide-hair">
                {pendingCommits.slice(0, 5).map((c) => {
                  const info = pendingMap.get(c.id)!;
                  return (
                    <li key={c.id} className="py-2.5">
                      <Link href={`/s/${id}/c/${c.id}`} className="text-[13.5px] leading-snug hover:underline underline-offset-4 decoration-black/20 line-clamp-2">
                        {c.message}
                      </Link>
                      <div className="mt-1.5 flex items-center gap-2">
                        <form action={voteAction} className="flex gap-1">
                          <input type="hidden" name="commit_id" value={c.id} />
                          <input type="hidden" name="space_id" value={id} />
                          <button name="vote" value="approve" className={`btn btn-sm ${info.myVote === "approve" ? "btn-primary" : "btn-dark"}`}>
                            {info.myVote === "approve" ? "동의함" : "동의"}
                          </button>
                          <button name="vote" value="reject" className={`btn btn-sm ${info.myVote === "reject" ? "btn-danger" : "btn-secondary"}`}>
                            {info.myVote === "reject" ? "반대함" : "반대"}
                          </button>
                        </form>
                        <span className="text-[11px] text-ink-3">{c.review_deadline ? `${fmtDateShort(c.review_deadline)}까지` : "반대 없으면 확정"}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

        </aside>
      </div>
    </div>
  );
}
