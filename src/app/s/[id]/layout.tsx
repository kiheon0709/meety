import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { canAccessSpace, getCurrentMember, getUser } from "@/lib/auth";
import { getSpace, listMembers, listSessions, remindDueActions, settleDueCommits } from "@/lib/service";
import { getCommits } from "@/lib/head";
import { ProjectNav } from "@/components/ProjectNav";
import { MemberSwitcher } from "@/components/MemberSwitcher";
import { AgentMark } from "@/components/Logo";
import { Avatar } from "@/components/ui";

export const dynamic = "force-dynamic";

// 프로젝트 껍데기: 바깥은 프로젝트 단위 (멘토 10/29). 왼쪽 메뉴 + 미티와 회의 버튼 (uiux-redesign.md §2)
export default async function SpaceLayout({ children, params }: LayoutProps<"/s/[id]">) {
  const { id } = await params;
  const space = getSpace(id);
  if (!space) notFound();
  if (!(await canAccessSpace(id))) {
    const user = await getUser();
    redirect(user ? "/home" : `/login?next=/s/${id}`);
  }
  settleDueCommits(id);
  remindDueActions(id);
  const members = listMembers(id);
  const me = await getCurrentMember(id);
  const sessions = listSessions(id, "meeting");
  const pendingCommits = getCommits(id).filter((c) => c.status === "pending" && !c.reverted).length;
  const pendingSessions = sessions.filter((s) => s.status !== "done").length;

  return (
    <div className="mx-auto max-w-[1360px] px-4 sm:px-5 pt-4 pb-10 lg:pt-7 lg:grid lg:grid-cols-[216px_minmax(0,1fr)] lg:gap-10">
      <aside className="lg:sticky lg:top-[72px] lg:self-start">
        <div className="flex items-center justify-between gap-3 lg:block">
          <div className="min-w-0">
            <Link href="/home" className="text-[12px] text-ink-3 hover:text-ink transition">
              내 프로젝트
            </Link>
            <div className="text-[17px] lg:text-[18px] font-bold tracking-[-0.02em] leading-snug truncate lg:whitespace-normal">{space.name}</div>
            <div className="mt-1 hidden lg:flex items-center gap-2">
              {space.is_demo === 1 && <span className="rounded-full bg-black/6 text-ink-2 text-[11px] font-medium px-2 py-0.5">예시</span>}
              {space.is_demo === 1 ? (
                <MemberSwitcher spaceId={id} members={members} me={me} />
              ) : (
                me && (
                  <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
                    <Avatar name={me.name} color={me.color} size={18} /> {me.name}
                  </span>
                )
              )}
            </div>
          </div>
          <Link href={`/live/new?space=${encodeURIComponent(id)}`} className="btn btn-md btn-agent shrink-0 lg:mt-4 lg:w-full !py-2.5 shadow-[0_8px_20px_-10px_var(--agent-1)]">
            <span className="rounded-full bg-white/90 p-[1px]">
              <AgentMark size={18} />
            </span>
            미티와 회의
          </Link>
        </div>
        <div className="mt-3 lg:mt-5">
          <ProjectNav spaceId={id} badges={{ "/sessions": pendingSessions, "/decisions": pendingCommits }} />
        </div>
      </aside>
      <div className="min-w-0 mt-5 lg:mt-0">{children}</div>
    </div>
  );
}
