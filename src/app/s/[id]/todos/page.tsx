import { getCommits, getHead } from "@/lib/head";
import { listMembers, listSessions } from "@/lib/service";
import { PageHead } from "@/components/PageHead";
import { TodoRow } from "@/components/Recap";
import { Avatar, Chevron, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

// 할 일: 사람별로, 담당 없는 일은 맨 위 (uiux-redesign.md §2)
export default async function TodosPage({ params }: PageProps<"/s/[id]/todos">) {
  const { id } = await params;
  const members = listMembers(id);
  const actions = getHead(id).filter((n) => n.type === "action");
  const open = actions.filter((n) => n.status === "open").sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const done = actions.filter((n) => n.status === "done");
  const sessions = new Map(listSessions(id).map((s) => [s.id, s]));
  const commitSession = new Map(getCommits(id).map((c) => [c.id, c.session_id]));
  const owners = [null, ...members.map((m) => m.name), ...new Set(open.map((n) => n.owner).filter((o): o is string => !!o && !members.some((m) => m.name === o)))];
  const row = (n: (typeof actions)[number]) => ({ nodeId: n.id, title: n.title, owner: n.owner, due: n.due ?? null, status: n.status });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-[920px] space-y-6">
      <PageHead title="할 일" sub={`열린 일 ${open.length}개 · 끝낸 일 ${done.length}개. 회의에서 나온 일을 미티가 담당·기한과 같이 모아요.`} />
      {open.length === 0 && <Empty>열린 할 일이 없어요.</Empty>}
      <div className="grid gap-4 md:grid-cols-2">
        {owners.map((o, i) => {
          const list = open.filter((n) => (n.owner ?? null) === o);
          if (!list.length) return null;
          const m = members.find((x) => x.name === o);
          return (
            <section key={o ?? "_none"} className={`fade-up card p-4 sm:p-5 ${o === null ? "md:col-span-2 shadow-[0_0_0_1px_color-mix(in_oklab,var(--orange)_40%,transparent)]" : ""}`} style={{ "--i": i + 1 } as React.CSSProperties}>
              <h2 className="flex items-center gap-2 text-[15px] font-bold">
                {o ? <Avatar name={o} color={m?.color} size={24} /> : <span className="h-2.5 w-2.5 rounded-full bg-orange" />}
                {o ?? "담당 없음"} <span className="text-ink-3 font-medium">{list.length}</span>
                {o === null && <span className="text-[12px] font-normal text-ink-2">다음 회의에서 미티가 “누가 맡나요?” 하고 물어요</span>}
              </h2>
              <ul className="mt-1 divide-hair">
                {list.map((n) => {
                  const se = sessions.get(commitSession.get(n.created_commit_id) ?? "");
                  return (
                    <TodoRow
                      key={n.id}
                      t={row(n)}
                      members={members}
                      spaceId={id}
                      note={n.due && n.due < today ? <span className="font-semibold text-red">기한 지남</span> : se ? <span className="text-ink-3 truncate">{se.title}</span> : null}
                    />
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {done.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[13.5px] font-semibold text-ink-2 inline-flex items-center gap-1.5">
            <Chevron className="transition-transform group-open:rotate-90" /> 끝낸 일 {done.length}
          </summary>
          <ul className="mt-2 card px-4 divide-hair">
            {done.map((n) => (
              <TodoRow key={n.id} t={row(n)} members={members} spaceId={id} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
