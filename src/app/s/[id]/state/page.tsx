import Link from "next/link";
import { getHead } from "@/lib/head";
import { listSessions } from "@/lib/service";
import type { HeadNode, NodeType } from "@/lib/types";
import { Chevron, Empty, PendingBadge, StatusBadge, TypeBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

const ORDER: NodeType[] = ["decision", "question", "action", "assumption", "fact", "claim"];
const CLOSED = new Set(["superseded", "withdrawn", "resolved", "done", "rejected"]);
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

export default async function StatePage({ params }: PageProps<"/s/[id]/state">) {
  const { id } = await params;
  const nodes = getHead(id);
  const sessions = listSessions(id, "meeting");

  if (!nodes.length) {
    return (
      <Empty>
        아직 정리된 맥락이 없어요.{" "}
        {sessions.some((s) => s.status === "pending") ? (
          <Link href={`/s/${id}/sessions`} className="text-blue underline underline-offset-4">
            처리 안 된 회의를 처리하세요.
          </Link>
        ) : (
          <Link href={`/s/${id}/sessions/new`} className="text-blue underline underline-offset-4">
            첫 회의 녹취를 넣어보세요.
          </Link>
        )}
      </Empty>
    );
  }

  const byTopic = new Map<string, HeadNode[]>();
  for (const n of nodes) {
    const k = n.topic || "(주제 없음)";
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k)!.push(n);
  }
  const sortNodes = (a: HeadNode, b: HeadNode) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.sort_order - b.sort_order;
  const live = nodes.filter((n) => !CLOSED.has(n.status));
  const counts = {
    decision: live.filter((n) => n.type === "decision").length,
    question: live.filter((n) => n.type === "question").length,
    action: live.filter((n) => n.type === "action").length,
    pending: nodes.filter((n) => n.review_pending && !CLOSED.has(n.status)).length,
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-20 self-start space-y-5">
        <div className="fade-up card p-4" style={S(2)}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">지금 유효한 맥락</div>
          <dl className="mt-2.5 space-y-1.5 text-[13.5px]">
            <Row label="결정" v={counts.decision} />
            <Row label="열린 안건" v={counts.question} />
            <Row label="할 일" v={counts.action} />
            {counts.pending > 0 && <Row label="확인 대기" v={counts.pending} tone="orange" />}
          </dl>
        </div>
        <nav className="fade-up hidden lg:block" style={S(3)}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 px-2">주제</div>
          <ul className="mt-2 space-y-0.5">
            {[...byTopic.keys()].map((t) => (
              <li key={t}>
                <a href={`#t-${encodeURIComponent(t)}`} className="block rounded-lg px-2 py-1.5 text-[13.5px] text-ink-2 hover:bg-black/5 hover:text-ink transition">
                  {t}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="space-y-5 min-w-0">
        <p className="fade-up text-[13.5px] text-ink-3" style={S(2)}>
          항목을 누르면 왜 그렇게 됐는지, 누가 무슨 말을 했는지 볼 수 있어요.
        </p>
        {[...byTopic.entries()].map(([topic, list], ti) => {
          const open = list.filter((n) => !CLOSED.has(n.status)).sort(sortNodes);
          const closed = list.filter((n) => CLOSED.has(n.status)).sort(sortNodes);
          return (
            <section key={topic} id={`t-${encodeURIComponent(topic)}`} className="fade-up card overflow-hidden scroll-mt-20" style={S(ti + 3)}>
              <h2 className="px-5 py-3 hairline-b font-semibold text-[15px] flex items-center justify-between">
                <span>{topic}</span>
                <span className="text-[12px] font-normal text-ink-3">{open.length}개</span>
              </h2>
              <ul className="divide-hair">
                {open.map((n) => (
                  <NodeRow key={n.id} n={n} spaceId={id} />
                ))}
                {open.length === 0 && <li className="px-5 py-3 text-[13px] text-ink-3">유효한 항목 없음</li>}
              </ul>
              {closed.length > 0 && (
                <details className="group hairline-b [box-shadow:inset_0_0.5px_0_rgba(0,0,0,0.08)]">
                  <summary className="px-5 py-2.5 text-[12px] text-ink-3 cursor-pointer select-none hover:bg-black/2 flex items-center gap-1.5 transition">
                    <Chevron className="transition-transform group-open:rotate-90" /> 지난 것 {closed.length}개
                  </summary>
                  <ul className="divide-hair bg-black/[0.02]">
                    {closed.map((n) => (
                      <NodeRow key={n.id} n={n} spaceId={id} />
                    ))}
                  </ul>
                </details>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, v, tone }: { label: string; v: number; tone?: "orange" }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-2">{label}</dt>
      <dd className={`font-semibold tabular-nums ${tone === "orange" ? "text-amber-ink" : ""}`}>{v}</dd>
    </div>
  );
}

function NodeRow({ n, spaceId }: { n: HeadNode; spaceId: string }) {
  const struck = ["superseded", "withdrawn", "rejected"].includes(n.status);
  return (
    <li>
      <Link href={`/s/${spaceId}/n/${n.id}`} className="group flex items-start gap-3 px-5 py-3 hover:bg-black/2 transition">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <TypeBadge type={n.type} />
            <StatusBadge status={n.status} />
            {n.review_pending === 1 && !struck && <PendingBadge />}
            <span className={`font-medium text-[15px] ${struck ? "line-through text-ink-3 decoration-black/20" : ""}`}>{n.title}</span>
            {n.owner && <span className="text-[12px] text-ink-3">· {n.owner}</span>}
            {n.supersedes && !struck && <span className="text-[11px] text-agent bg-agent/10 rounded px-1">↻ 바뀜</span>}
          </div>
          {n.body && <p className={`text-[13.5px] mt-1 line-clamp-2 ${struck ? "text-ink-3" : "text-ink-2"}`}>{n.body}</p>}
        </div>
        <Chevron className="mt-1.5 text-black/20 transition-all group-hover:text-ink group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}
