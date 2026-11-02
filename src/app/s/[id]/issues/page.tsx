import Link from "next/link";
import { getHead } from "@/lib/head";
import { countComments, listMembers } from "@/lib/service";
import { Avatar, Chevron, Empty, PendingBadge } from "@/components/ui";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 안건 목록: 아직 못 정한 것 / 정한 것. 후보 답 수, 댓글 수, 담당.
export default async function IssuesPage({ params, searchParams }: PageProps<"/s/[id]/issues">) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = sp?.tab === "closed" ? "closed" : "open";
  const head = getHead(id);
  const members = listMembers(id);
  const comments = countComments(id);
  const questions = head.filter((n) => n.type === "question" && (tab === "open" ? n.status === "open" : n.status !== "open"));
  const candidatesOf = (q: (typeof head)[number]) => head.filter((n) => n.type === "claim" && n.topic === q.topic && n.status === "open").length;
  const openCount = head.filter((n) => n.type === "question" && n.status === "open").length;
  const closedCount = head.filter((n) => n.type === "question" && n.status !== "open").length;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="fade-up flex items-center justify-between gap-3" style={S(2)}>
        <nav className="seg">
          <Link href={`/s/${id}/issues`} aria-current={tab === "open" ? "page" : undefined}>
            못 정한 것 <span className="text-ink-3 ml-1">{openCount}</span>
          </Link>
          <Link href={`/s/${id}/issues?tab=closed`} aria-current={tab === "closed" ? "page" : undefined}>
            정한 것 <span className="text-ink-3 ml-1">{closedCount}</span>
          </Link>
        </nav>
        <p className="text-[12px] text-ink-3 hidden sm:block">회의 밖에서 정해진 건 안건에 댓글로 남겨두세요. 누가 언제 한 말인지 함께 남아요.</p>
      </div>
      {questions.length === 0 ? (
        <Empty>{tab === "open" ? "열린 안건이 없어요. 회의에서 \"아직 못 정했어\"가 나오면 여기에 생겨요." : "정한 안건이 아직 없어요."}</Empty>
      ) : (
        <ul className="fade-up card divide-hair overflow-hidden" style={S(3)}>
          {questions.map((q) => {
            const cands = candidatesOf(q);
            const cm = comments.get(q.id) ?? 0;
            const owner = q.owner ? members.find((m) => m.name === q.owner) : undefined;
            return (
              <li key={q.id}>
                <Link href={`/s/${id}/issues/${q.id}`} className="group flex items-center gap-4 px-5 py-4 hover:bg-black/2 transition">
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${q.status === "open" ? "bg-orange" : "bg-black/20"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium text-[15px] ${q.status !== "open" ? "text-ink-3" : ""}`}>{q.title}</span>
                      {q.review_pending === 1 && <PendingBadge />}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[12px] text-ink-3">
                      <span>{q.topic}</span>
                      {cands > 0 && <span className="text-indigo">후보 {cands}개</span>}
                      {cm > 0 && <span>댓글 {cm}</span>}
                    </div>
                  </div>
                  {owner ? <Avatar name={owner.name} color={owner.color} size={24} /> : q.owner ? <span className="text-[12px] text-ink-3">{q.owner}</span> : null}
                  <Chevron className="text-black/20 group-hover:text-ink transition" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
