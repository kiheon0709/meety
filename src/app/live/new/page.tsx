import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { getHead } from "@/lib/head";
import { lastLiveSession, listDemoSpaces, listMembers, listSessions, listSpacesForUser } from "@/lib/service";
import type { MeetingMode, RoleKind } from "@/lib/live/contract";
import { PrepForm, type PrepDefaults } from "@/components/prep/PrepForm";

export const dynamic = "force-dynamic";

// 지난 회의에서 채울 기본값 (uiux-redesign.md §4): 미티와 한 마지막 회의 기록 + 안 끝난 안건 + 열린 안건
function defaultsFor(spaceId: string): PrepDefaults {
  const last = lastLiveSession(spaceId);
  const r = last?.record;
  const leftovers = new Map<string, { title: string; expected: string[]; why: string }>();
  for (const c of r?.checklist ?? []) {
    if (c.status === "done") continue;
    const cur = leftovers.get(c.agenda) ?? { title: c.agenda, expected: [], why: c.status === "no_owner" ? "담당 없음" : "아직" };
    cur.expected.push(c.expected);
    if (c.status === "no_owner") cur.why = "담당 없음";
    leftovers.set(c.agenda, cur);
  }
  for (const q of getHead(spaceId).filter((n) => n.type === "question" && n.status === "open").slice(0, 4)) {
    if (!leftovers.has(q.title)) leftovers.set(q.title, { title: q.title, expected: ["결론"], why: "못 정한 안건" });
  }
  return {
    from: last ? { title: last.title, held_at: last.held_at } : null,
    meetings: listSessions(spaceId, "meeting").length,
    participants: r?.participants.length ? r.participants : null,
    host: r?.host ?? null,
    mode: (r?.mode as MeetingMode | undefined) ?? null,
    participation: r?.participation ?? null,
    roles: (r?.roles as Partial<Record<RoleKind, boolean>> | undefined) ?? null,
    docIds: r?.docIds ?? null,
    leftovers: [...leftovers.values()],
  };
}

export default async function NewLivePage({ searchParams }: PageProps<"/live/new">) {
  // 로그인 없이도 예시(공개) 스페이스로는 회의를 열 수 있다 (두뇌도 is_demo면 통과). 팀 실회의가 지금 이 스페이스다
  const user = await getUser();
  const demos = listDemoSpaces();
  if (!user && demos.length === 0) redirect("/login?next=/live/new");
  const sp = await searchParams;
  const mine = user ? listSpacesForUser(user.id) : [];
  const spaces = [...mine, ...demos.filter((d) => !mine.some((m) => m.id === d.id))].map((s) => ({
    id: s.id,
    name: s.name,
    demo: s.is_demo === 1,
    members: listMembers(s.id).map((m) => ({ name: m.name, color: m.color })),
    defaults: defaultsFor(s.id),
  }));
  const pick = typeof sp.space === "string" ? sp.space : undefined;
  return (
    <div className="mx-auto max-w-[1180px] px-4 sm:px-5 py-6 lg:py-8">
      <div className="fade-up mb-5">
        <h1 className="text-[24px] sm:text-[28px] font-bold tracking-[-0.03em]">미티와 회의 준비</h1>
        <p className="text-[14px] text-ink-2 mt-1">처음엔 조금 적고, 다음 회의부터는 지난 회의 값으로 채워져요. 확인만 하고 시작하면 돼요.</p>
      </div>
      <div className="fade-up" style={{ "--i": 1 } as React.CSSProperties}>
        <PrepForm spaces={spaces} initialSpaceId={pick} />
      </div>
    </div>
  );
}
