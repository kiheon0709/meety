import Link from "next/link";
import { commitStateAction, voteAction } from "@/lib/actions";
import type { Approval, CommitWithChanges, HeadNode, Member, Space } from "@/lib/types";
import { evaluateApprovals } from "@/lib/service";
import { ChangeView } from "./ChangeView";
import { Avatar, PendingBadge } from "./ui";
import { AgentMark } from "./Logo";
import { plain } from "@/lib/plain";

export function CommitCard({
  commit,
  space,
  nodes,
  members,
  approvals,
  me,
  sessionTitle,
  index = 0,
  hideMessage = false,
}: {
  commit: CommitWithChanges;
  space: Space;
  nodes: Map<string, HeadNode>;
  members: Member[];
  approvals: Approval[];
  me?: Member;
  sessionTitle?: string;
  index?: number;
  hideMessage?: boolean;
}) {
  const isPending = commit.status === "pending";
  const isRejected = commit.status === "rejected";
  const isReverted = commit.reverted === 1;
  const muted = isRejected || isReverted;
  const votes = approvals.filter((v) => v.commit_id === commit.id);
  const ev = evaluateApprovals(space, members, votes);
  const mine = votes.find((v) => v.member_id === me?.id);
  const author = commit.author_member_id ? members.find((m) => m.id === commit.author_member_id) : undefined;

  return (
    <article className={`fade-up card overflow-hidden ${muted ? "opacity-60" : ""}`} style={{ "--i": index } as React.CSSProperties}>
      <div className={`h-1 ${isPending ? "bg-orange" : muted ? "bg-black/15" : "bg-blue"}`} />
      <div className="p-5">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex gap-3">
            {!author && <AgentMark size={26} className="mt-0.5" />}
            <div className="min-w-0">
            {!hideMessage && (
              <h4 className="font-semibold leading-snug text-[15.5px]">
                <Link href={`/s/${space.id}/c/${commit.id}`} className="hover:underline underline-offset-4 decoration-black/20">
                  {commit.message}
                </Link>
              </h4>
            )}
            <div className={`text-[12px] text-ink-3 flex flex-wrap items-center gap-x-2 ${hideMessage ? "" : "mt-1"}`}>
              {sessionTitle && <span>{sessionTitle}</span>}
              <span>변경 {commit.changes.length}건</span>
              {author && (
                <span className="inline-flex items-center gap-1">
                  <Avatar name={author.name} color={author.color} size={14} /> {author.name}
                </span>
              )}
              {!hideMessage && <span className="font-mono">#{commit.seq}</span>}
              {isRejected && <span>· 거절됨</span>}
              {isReverted && <span>· 되돌림</span>}
            </div>
            </div>
          </div>
          {!isPending && (
            <form action={commitStateAction} className="shrink-0">
              <input type="hidden" name="commit_id" value={commit.id} />
              <input type="hidden" name="space_id" value={space.id} />
              {isRejected ? (
                <button name="action" value="approve" className="btn btn-sm btn-secondary">
                  다시 반영
                </button>
              ) : isReverted ? (
                <button name="action" value="unrevert" className="btn btn-sm btn-secondary">
                  되돌리기 취소
                </button>
              ) : (
                <button name="action" value="revert" className="btn btn-sm btn-secondary">
                  되돌리기
                </button>
              )}
            </form>
          )}
        </header>

        {isPending && (
          <div className="mt-3 rounded-2xl bg-orange/8 p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <PendingBadge label={ev.verdict === "conflict" ? "의견이 엇갈려요" : "한 번 봐주세요"} />
                  <span className="text-[12px] text-ink-3">
                    {space.approval_mode === "count" ? `${ev.needed}명 동의하면 반영` : space.approval_mode === "deciders" ? "팀장이 동의하면 반영" : "한 명 동의하면 반영"}
                  </span>
                </div>
                <p className="mt-1.5 text-[13.5px] text-ink-2 leading-relaxed flex gap-2"><AgentMark size={18} className="mt-0.5" /><span>{plain(commit.review_reason)}</span></p>
              </div>
              <form action={voteAction} className="flex gap-1.5 shrink-0">
                <input type="hidden" name="commit_id" value={commit.id} />
                <input type="hidden" name="space_id" value={space.id} />
                <button name="vote" value="approve" className={`btn btn-sm ${mine?.vote === "approve" ? "btn-primary" : "btn-dark"}`}>
                  {mine?.vote === "approve" ? "동의함" : "동의"}
                </button>
                <button name="vote" value="reject" className={`btn btn-sm ${mine?.vote === "reject" ? "btn-danger" : "btn-secondary"}`}>
                  {mine?.vote === "reject" ? "반대함" : "반대"}
                </button>
              </form>
            </div>
            {votes.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {votes.map((v) => {
                  const m = members.find((x) => x.id === v.member_id);
                  if (!m) return null;
                  return (
                    <li key={v.id} className={`inline-flex items-center gap-1.5 rounded-full pl-0.5 pr-2.5 py-0.5 text-[12px] ${v.vote === "approve" ? "bg-green/15 text-green-ink" : "bg-red/10 text-red"}`}>
                      <Avatar name={m.name} color={m.color} size={18} />
                      {m.name} {v.vote === "approve" ? "동의" : "반대"}
                      {m.is_decider === 1 && space.approval_mode === "deciders" && <span className="text-[10px] opacity-70">· 팀장</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div className="mt-4 space-y-3.5">
          {commit.changes.map((ch, i) => (
            <ChangeView key={i} change={ch} spaceId={space.id} nodes={nodes} />
          ))}
        </div>
      </div>
    </article>
  );
}
