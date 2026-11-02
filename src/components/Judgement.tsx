import Link from "next/link";
import { closeNodeAction, processSessionAction, voteAction } from "@/lib/actions";
import type { CommitWithChanges, HeadNode, Session, Space } from "@/lib/types";
import type { PendingInfo } from "./Feed";
import { Avatar, PendingBadge } from "./ui";
import { plain } from "@/lib/plain";

export type JudgeItem =
  | { kind: "conflict"; space: Space; commit: CommitWithChanges; info: PendingInfo }
  | { kind: "error"; space: Space; session: Session }
  | { kind: "overdue"; space: Space; node: HeadNode };

// "지금 결론이 필요한 것" — 갈피가 혼자 못 정하는 것만. 의견이 엇갈린 업데이트, 정리가 멈춘 회의.
export function Judgement({ items, showSpace = false }: { items: JudgeItem[]; showSpace?: boolean }) {
  return (
    <div className="card divide-hair overflow-hidden border-l-[3px] border-orange">
      {items.map((it) =>
        it.kind === "overdue" ? (
          <div key={it.node.id} className="p-5 flex items-center gap-4">
            <span className="h-5 w-5 rounded-full bg-orange/15 text-amber-ink flex items-center justify-center text-[11px] font-bold shrink-0">!</span>
            <div className="min-w-0 flex-1">
              <Link href={`/s/${it.space.id}/n/${it.node.id}`} className="font-semibold text-[15px] hover:underline underline-offset-4 decoration-black/20">
                {it.node.title}
              </Link>
              <div className="text-[12px] text-ink-3 mt-0.5">
                {showSpace && `${it.space.name} · `}내 담당 · 기한 {it.node.due} 지남
              </div>
            </div>
            <form action={closeNodeAction}>
              <input type="hidden" name="space_id" value={it.space.id} />
              <input type="hidden" name="node_id" value={it.node.id} />
              <button className="btn btn-sm btn-dark">끝냈어요</button>
            </form>
          </div>
        ) : it.kind === "conflict" ? (
          <div key={it.commit.id} className="p-5 flex items-start gap-4 flex-wrap sm:flex-nowrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <PendingBadge label="의견이 엇갈려요" />
                {showSpace && <span className="text-[12px] text-ink-3">{it.space.name}</span>}
              </div>
              <Link href={`/s/${it.space.id}/c/${it.commit.id}`} className="block mt-1.5 font-semibold text-[16px] leading-snug hover:underline underline-offset-4 decoration-black/20">
                {it.commit.message}
              </Link>
              <p className="text-[13px] text-ink-2 mt-1">{plain(it.commit.review_reason)}</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {it.info.votes.map((v) => {
                  const m = it.info.members.find((x) => x.id === v.member_id);
                  if (!m) return null;
                  return (
                    <li key={v.id} className={`inline-flex items-center gap-1.5 rounded-full pl-0.5 pr-2.5 py-0.5 text-[12px] ${v.vote === "approve" ? "bg-green/15 text-green-ink" : "bg-red/10 text-red"}`}>
                      <Avatar name={m.name} color={m.color} size={18} />
                      {m.name} {v.vote === "approve" ? "동의" : "반대"}
                      {v.note && <span className="opacity-70">· {v.note}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
            <form action={voteAction} className="flex gap-1.5 shrink-0">
              <input type="hidden" name="commit_id" value={it.commit.id} />
              <input type="hidden" name="space_id" value={it.space.id} />
              <button name="vote" value="approve" className={`btn btn-sm ${it.info.myVote === "approve" ? "btn-primary" : "btn-dark"}`}>
                {it.info.myVote === "approve" ? "동의함" : "동의"}
              </button>
              <button name="vote" value="reject" className={`btn btn-sm ${it.info.myVote === "reject" ? "btn-danger" : "btn-secondary"}`}>
                {it.info.myVote === "reject" ? "반대함" : "반대"}
              </button>
            </form>
          </div>
        ) : (
          <div key={it.session.id} className="p-5 flex items-center gap-4">
            <span className="h-5 w-5 rounded-full bg-red/10 text-red flex items-center justify-center text-[11px] font-bold shrink-0">!</span>
            <div className="min-w-0 flex-1">
              <Link href={`/s/${it.space.id}/sessions/${it.session.id}`} className="font-semibold text-[15px] hover:underline underline-offset-4 decoration-black/20">
                &ldquo;{it.session.title}&rdquo; 정리하다가 멈췄어요
              </Link>
              <div className="text-[12px] text-ink-3 mt-0.5 truncate">
                {showSpace && `${it.space.name} · `}
                {it.session.error}
              </div>
            </div>
            <form action={processSessionAction}>
              <input type="hidden" name="session_id" value={it.session.id} />
              <input type="hidden" name="space_id" value={it.space.id} />
              <button className="btn btn-sm btn-dark">다시 정리</button>
            </form>
          </div>
        ),
      )}
    </div>
  );
}
