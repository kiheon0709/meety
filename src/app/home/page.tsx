import Link from "next/link";
import { redirect } from "next/navigation";
import { createSpaceAction } from "@/lib/actions";
import { getCurrentMember, getUser } from "@/lib/auth";
import { getCommits, getHead } from "@/lib/head";
import { listDemoSpaces, listMembers, listSessions, listSpacesForUser, remindDueActions, settleDueCommits } from "@/lib/service";
import { listFeedForSpaces } from "@/lib/events";
import { Feed, buildPending, daysSince, type PendingInfo } from "@/components/Feed";
import { Judgement } from "@/components/Judgement";
import { AvatarStack, SectionTitle, fmtDateShort } from "@/components/ui";
import { AgentMark } from "@/components/Logo";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 앱 홈 = 갈피가 내 프로젝트들에서 한 일. 사람이 결론을 내야 하는 것만 맨 위에.
export default async function HomePage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/home");
  const spaces = listSpacesForUser(user.id);
  const demos = listDemoSpaces();
  const rows = await Promise.all(
    spaces.map(async (s) => {
      settleDueCommits(s.id);
      remindDueActions(s.id);
      const me = await getCurrentMember(s.id);
      const members = listMembers(s.id);
      const commits = getCommits(s.id);
      const head = getHead(s.id);
      const sessions = listSessions(s.id, "meeting");
      const p = buildPending(s, members, me, commits);
      const myActions = head.filter((n) => n.type === "action" && n.status === "open" && me && n.owner === me.name);
      const live = head.filter((n) => !["superseded", "withdrawn", "resolved", "done", "rejected"].includes(n.status));
      return { s, me, members, ...p, myActions, sessions, live, errored: sessions.filter((x) => x.status === "error"), processing: sessions.filter((x) => x.status === "processing").length };
    }),
  );
  const pendingMap = new Map<string, PendingInfo>();
  for (const r of rows) for (const [k, v] of r.map) pendingMap.set(k, v);
  const today = new Date().toISOString().slice(0, 10);
  const judge = rows.flatMap((r) => [
    ...r.conflicts.map((c) => ({ kind: "conflict" as const, space: r.s, commit: c.commit, info: c.info })),
    ...r.errored.map((se) => ({ kind: "error" as const, space: r.s, session: se })),
    ...r.myActions.filter((n) => n.due && n.due < today).map((n) => ({ kind: "overdue" as const, space: r.s, node: n })),
  ]);
  const feed = listFeedForSpaces(spaces.map((s) => s.id), 40);
  const spaceNames = new Map(spaces.map((s) => [s.id, s.name]));
  const myTodo = rows.flatMap((r) => r.myActions.map((n) => ({ space: r.s, n })));
  const since = feed.length ? daysSince(feed[feed.length - 1].created_at) : 0;

  const headline = spaces.length === 0 ? `안녕하세요, ${user.name}` : judge.length > 0 ? `결론이 필요한 게 ${judge.length}개 있어요` : feed.length > 0 ? `미티가 ${since}일 동안 한 일이에요` : "아직 조용해요";
  const sub =
    spaces.length === 0
      ? "첫 프로젝트를 만들고 팀원을 초대하세요."
      : judge.length > 0
        ? "의견이 엇갈린 것과 정리가 멈춘 회의예요. 나머지는 미티가 알아서 하고 있어요."
        : feed.length > 0
          ? "반대가 없는 업데이트는 미티가 알아서 확정해요. 아래는 그동안 미티가 한 일이에요."
          : "프로젝트에서 미티와 회의하면 미티가 일을 시작해요.";

  return (
    <div className="mx-auto max-w-[1180px] px-4 sm:px-5 py-8 sm:py-10 space-y-9">
      <div className="fade-up flex items-start gap-4">
        <AgentMark size={44} className="mt-1 hidden sm:inline-flex" />
        <div>
          <h1 className="text-[2rem] font-bold tracking-[-0.03em]">{headline}</h1>
          <p className="text-[15px] text-ink-2 mt-1">{sub}</p>
        </div>
      </div>

      <section className="fade-up space-y-3" style={S(1)}>
        <SectionTitle>내 프로젝트</SectionTitle>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <li key={r.s.id}>
              <Link href={`/s/${r.s.id}`} className="group block card lift p-5 h-full">
                <div className="flex items-start justify-between gap-3">
                  <div className="font-bold text-[18px] tracking-tight leading-snug">{r.s.name}</div>
                  <AvatarStack members={r.members} size={22} />
                </div>
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
                  <span>회의 {r.sessions.length}회</span>
                  <span>유효한 맥락 {r.live.length}</span>
                  {r.pendingCommits.length > 0 && <span className="text-amber-ink">확인할 것 {r.pendingCommits.length}</span>}
                  {r.processing > 0 && <span className="text-blue">정리 중</span>}
                </div>
                <div className="mt-4 text-[12px] text-ink-3">{r.sessions.at(-1) ? `마지막 회의 ${fmtDateShort(r.sessions.at(-1)!.held_at)}` : "아직 회의 없음 — 녹음부터"}</div>
              </Link>
            </li>
          ))}
          <li>
            <form action={createSpaceAction} className="card-flat p-5 h-full flex flex-col justify-between border-dashed">
              <div>
                <div className="text-[14px] font-semibold">새 프로젝트</div>
                <p className="text-[12.5px] text-ink-3 mt-0.5">팀·주제 하나가 프로젝트 하나예요.</p>
              </div>
              <div className="mt-3 flex gap-2">
                <input name="name" placeholder="예: 가재코드 팀" className="input" required />
                <button className="btn btn-md btn-primary shrink-0">만들기</button>
              </div>
            </form>
          </li>
        </ul>
      </section>

      {judge.length > 0 && (
        <section className="fade-up" style={S(1)}>
          <SectionTitle>지금 결론이 필요한 것</SectionTitle>
          <Judgement items={judge} showSpace />
        </section>
      )}

      {spaces.length > 0 && (
        <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
          <section className="fade-up min-w-0" style={S(2)}>
            <SectionTitle>미티가 한 일</SectionTitle>
            <Feed items={feed} pending={pendingMap} spaceNames={spaces.length > 1 ? spaceNames : undefined} />
          </section>
          <aside className="space-y-6">
            <section className="fade-up card p-5" style={S(3)}>
              <div className="text-[13px] font-semibold">내 담당 할 일 {myTodo.length > 0 && <span className="text-ink-3 font-normal">{myTodo.length}</span>}</div>
              {myTodo.length === 0 ? (
                <p className="mt-2 text-[13px] text-ink-3">없어요.</p>
              ) : (
                <ul className="mt-2 divide-hair">
                  {myTodo.slice(0, 8).map(({ space, n }) => (
                    <li key={space.id + n.id}>
                      <Link href={`/s/${space.id}/n/${n.id}`} className="flex items-center gap-2.5 py-2.5">
                        <span className="h-4 w-4 rounded-full border-[1.5px] border-black/25 shrink-0" />
                        <span className="text-[13.5px] leading-snug flex-1">{n.title}</span>
                        {n.due && <span className={`text-[11px] shrink-0 ${n.due < today ? "text-red" : "text-ink-3"}`}>{n.due.slice(5).replace("-", "/")}까지</span>}
                        {spaces.length > 1 && <span className="text-[11px] text-ink-3 shrink-0 max-w-[90px] truncate">{space.name}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}


      {demos.length > 0 && (
        <section className="fade-up space-y-3" style={S(5)}>
          <SectionTitle>예시 둘러보기</SectionTitle>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {demos.map((d) => {
              const sessions = listSessions(d.id, "meeting");
              return (
                <li key={d.id}>
                  <Link href={`/s/${d.id}`} className="group block card-flat lift p-5 h-full">
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-bold text-[16px] tracking-tight leading-snug">{d.name}</div>
                      <span className="rounded-full bg-black/6 text-ink-2 text-[11px] font-medium px-2 py-0.5">예시</span>
                    </div>
                    <p className="mt-2 text-[13px] text-ink-2">이 서비스를 만든 팀의 회의 {sessions.length}회. 주제와 녹음 방식이 바뀌어 온 과정이 그대로 남아 있어요.</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
