import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getCommits, getHead } from "@/lib/head";
import { listSessions } from "@/lib/service";
import type { HeadNode } from "@/lib/types";
import { PageHead } from "@/components/PageHead";
import { Empty, StatusBadge, fmtDateShort } from "@/components/ui";

export const dynamic = "force-dynamic";

// 결정 기록 (uiux-redesign.md §2): 주제별 지금 결정 + 바뀐 이력(A → B) + 아직 못 정한 것.
// 옛 화면(현재 상태·히스토리·안건)을 한 곳에 묶는다.
export default async function DecisionsPage({ params }: PageProps<"/s/[id]/decisions">) {
  const { id } = await params;
  const head = getHead(id);
  const byId = new Map(head.map((n) => [n.id, n]));
  const sessions = new Map(listSessions(id).map((s) => [s.id, s]));
  const commitSession = new Map(getCommits(id).map((c) => [c.id, c.session_id]));
  const when = (n: HeadNode) => sessions.get(commitSession.get(n.created_commit_id) ?? "");

  const decisions = head.filter((n) => n.type === "decision");
  const topics = new Map<string, HeadNode[]>();
  for (const n of decisions.filter((d) => d.status !== "superseded")) topics.set(n.topic || "기타", [...(topics.get(n.topic || "기타") ?? []), n]);
  // 지금 결정에서 거꾸로 따라가며 옛 결정 줄 (supersedes 사슬)
  const chain = (n: HeadNode) => {
    const out: HeadNode[] = [];
    for (let cur = n.supersedes ? byId.get(n.supersedes) : undefined; cur && out.length < 6; cur = cur.supersedes ? byId.get(cur.supersedes) : undefined) out.push(cur);
    return out;
  };
  const open = head.filter((n) => n.type === "question" && n.status === "open");

  return (
    <div className="max-w-[920px] space-y-8">
      <PageHead
        title="결정 기록"
        sub="주제마다 지금 정해진 것과, 어떻게 바뀌어 왔는지예요."
        aside={
          <div className="flex flex-wrap gap-2">
            <Link href={`/s/${id}/ask`} className="btn btn-sm btn-secondary">
              미티에게 물어보기
            </Link>
            <Link href={`/s/${id}/history`} className="btn btn-sm btn-ghost">
              변경 이력 전체
            </Link>
          </div>
        }
      />

      {open.length > 0 && (
        <section className="fade-up" style={{ "--i": 1 } as React.CSSProperties}>
          <h2 className="text-[15px] font-bold mb-2">
            아직 못 정한 것 <span className="text-amber-ink">{open.length}</span>
          </h2>
          <div className="card divide-hair">
            {open.map((q) => (
              <Link key={q.id} href={`/s/${id}/issues/${q.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-black/[0.02]">
                <span className="h-2 w-2 rounded-full bg-orange shrink-0" />
                <span className="min-w-0 flex-1 text-[14.5px]">{q.title}</span>
                <span className="text-[12px] text-ink-3 shrink-0">{q.topic}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {topics.size === 0 ? (
        <Empty>아직 정해진 결정이 없어요. 미티와 첫 회의를 해 보세요.</Empty>
      ) : (
        <section className="space-y-4">
          {[...topics.entries()].map(([topic, list], ti) => (
            <div key={topic} className="fade-up card p-4 sm:p-5" style={{ "--i": ti + 2 } as React.CSSProperties}>
              <h3 className="text-[13px] font-bold text-agent flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-agent" />
                {topic}
              </h3>
              <ul className="mt-2 space-y-3">
                {list.map((d) => {
                  const past = chain(d);
                  const se = when(d);
                  return (
                    <li key={d.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/s/${id}/n/${d.id}`} className="text-[16px] font-semibold hover:underline underline-offset-4">
                          {d.title}
                        </Link>
                        <StatusBadge status={d.status} />
                        {d.review_pending === 1 && <span className="text-[11px] font-semibold text-amber-ink">확인 중</span>}
                      </div>
                      {se && (
                        <div className="text-[12px] text-ink-3 mt-0.5">
                          {fmtDateShort(se.held_at)} · <Link href={`/s/${id}/sessions/${se.id}`} className="hover:underline">{se.title}</Link>
                        </div>
                      )}
                      {past.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                          {[...past].reverse().map((p) => (
                            <span key={p.id} className="inline-flex items-center gap-1.5">
                              <span className="rounded-full bg-black/[0.04] px-2.5 py-1 text-ink-3 line-through decoration-ink-3/50">
                                {p.title}
                                {when(p) && <span className="no-underline"> · {fmtDateShort(when(p)!.held_at)}</span>}
                              </span>
                              <ArrowRight className="h-3.5 w-3.5 text-agent" />
                            </span>
                          ))}
                          <span className="rounded-full bg-[var(--agent-soft)] text-agent font-semibold px-2.5 py-1">지금</span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
