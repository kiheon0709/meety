import Link from "next/link";
import type { FeedItem } from "@/lib/events";
import type { Approval, CommitWithChanges, Member, Space } from "@/lib/types";
import { voteAction } from "@/lib/actions";
import { evaluateApprovals, listApprovals } from "@/lib/service";
import { plain } from "@/lib/plain";
import { AgentMark } from "./Logo";
import { Avatar, fmtDateShort } from "./ui";

// 갈피 활동 피드. 갈피가 한 일은 책갈피 마크, 사람이 한 일은 그 사람 아바타로.
// asked(물어본 것) 중 아직 확인 대기인 업데이트에는 동의·반대 버튼과 "언제까지 반대 없으면 확정"을 붙인다.

export interface PendingInfo {
  space: Space;
  members: Member[];
  votes: Approval[];
  myVote?: Approval["vote"];
  deadline?: string | null;
}

// 확인 대기 업데이트 → 피드·판단 필요 섹션에서 쓰는 정보. 엇갈린 것(conflicts)은 사람이 결론을 내야 한다.
export function buildPending(space: Space, members: Member[], me: Member | undefined, commits: CommitWithChanges[]) {
  const pendingCommits = commits.filter((c) => c.status === "pending" && !c.reverted);
  const approvals = listApprovals(pendingCommits.map((c) => c.id));
  const map = new Map<string, PendingInfo>();
  const conflicts: { commit: CommitWithChanges; info: PendingInfo }[] = [];
  for (const c of pendingCommits) {
    const votes = approvals.filter((v) => v.commit_id === c.id);
    const info: PendingInfo = { space, members, votes, myVote: votes.find((v) => v.member_id === me?.id)?.vote, deadline: c.review_deadline };
    map.set(c.id, info);
    if (evaluateApprovals(space, members, votes).verdict === "conflict" || votes.some((v) => v.vote === "reject")) conflicts.push({ commit: c, info });
  }
  return { map, pendingCommits, conflicts };
}

const DOT: Record<string, string> = {
  read: "bg-black/25",
  applied: "bg-blue",
  asked: "bg-orange",
  dropped: "bg-black/25",
  briefing: "bg-agent",
  todo: "bg-green",
  due: "bg-orange",
  settled: "bg-blue",
  voted: "bg-indigo",
  manual: "bg-indigo",
  reverted: "bg-red",
  error: "bg-red",
};

export function hrefOf(e: FeedItem): string | null {
  const base = `/s/${e.space_id}`;
  switch (e.ref_type) {
    case "session":
      return `${base}/sessions/${e.ref_id}`;
    case "commit":
      return `${base}/c/${e.ref_id}`;
    case "node":
      return `${base}/n/${e.ref_id}`;
    case "briefing":
      return `${base}/briefing`;
    default:
      return null;
  }
}

export function daysSince(iso: string): number {
  return Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
}

export function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  const y = dayKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return "오늘";
  if (key === y) return "어제";
  return fmtDateShort(key);
}

export function Feed({
  items,
  pending,
  spaceNames,
  emptyText = "아직 미티가 한 일이 없어요. 첫 회의를 녹음하면 여기에 쌓여요.",
}: {
  items: FeedItem[];
  pending: Map<string, PendingInfo>; // commit id → 확인 대기 정보
  spaceNames?: Map<string, string>; // 여러 프로젝트를 섞어 보일 때
  emptyText?: string;
}) {
  if (!items.length) return <div className="card-tinted p-8 text-center text-sm text-ink-2">{emptyText}</div>;
  const groups: { key: string; items: FeedItem[] }[] = [];
  for (const e of items) {
    const k = dayKey(e.created_at);
    const last = groups.at(-1);
    if (last && last.key === k) last.items.push(e);
    else groups.push({ key: k, items: [e] });
  }
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.key}>
          <div className="text-[12px] font-semibold text-ink-3 mb-2 pl-1 tracking-[0.02em]">{dayLabel(g.key)}</div>
          <ul className="card divide-hair overflow-hidden">
            {mergeTodos(g.items).map((e) => (
              <FeedRow key={e.id} e={e} pending={e.ref_type === "commit" && e.ref_id ? pending.get(e.ref_id) : undefined} spaceName={spaceNames?.get(e.space_id)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// 같은 회의에서 연달아 생긴 "담당 할 일" 기록은 한 줄로 합친다 (피드가 할 일로 도배되지 않도록).
function mergeTodos(items: FeedItem[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    // 브리핑을 연달아 다시 쓴 기록은 최신 하나만 (피드는 최신순이라 첫 것이 최신)
    if (e.kind === "briefing") {
      let n = 1;
      while (i + 1 < items.length && items[i + 1].kind === "briefing" && items[i + 1].space_id === e.space_id) {
        i++;
        n++;
      }
      out.push(n > 1 ? { ...e, title: `다음 회의 전 브리핑을 다시 썼어요 (${n}번)` } : e);
      continue;
    }
    if (e.kind !== "todo") {
      out.push(e);
      continue;
    }
    const run: FeedItem[] = [e];
    while (i + 1 < items.length && items[i + 1].kind === "todo" && items[i + 1].space_id === e.space_id) run.push(items[++i]);
    if (run.length === 1) {
      out.push(e);
      continue;
    }
    const lines = run.map((t) => t.title.replace(/^(.+?) 담당 할 일이 생겼어요: (.+)$/, "$1 · $2"));
    out.push({ ...e, id: run.map((t) => t.id).join("+"), ref_type: null, ref_id: null, title: `할 일 ${run.length}개가 새로 생겼어요`, detail: lines.join("\n") });
  }
  return out;
}

function FeedRow({ e, pending, spaceName }: { e: FeedItem; pending?: PendingInfo; spaceName?: string }) {
  const href = hrefOf(e);
  const isAgent = e.actor === "agent";
  const detailLines = e.detail ? plain(e.detail).split("\n").filter(Boolean).slice(0, 6) : [];
  const title = plain(e.title);
  const titleEl = href ? (
    <Link href={href} className="hover:underline underline-offset-4 decoration-black/20">
      {title}
    </Link>
  ) : (
    title
  );
  return (
    <li className={`p-4 sm:px-5 flex gap-3.5 ${e.kind === "asked" ? "bg-orange/[0.04]" : ""}`}>
      <div className="relative shrink-0 mt-0.5">
        {isAgent ? <AgentMark size={28} /> : <Avatar name={e.actor_member?.name ?? "?"} color={e.actor_member?.color} size={28} />}
        <span className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${DOT[e.kind] ?? "bg-black/20"}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className={`text-[14.5px] leading-snug ${e.kind === "asked" || e.kind === "error" ? "font-semibold" : "font-medium"}`}>{titleEl}</div>
          <span className="text-[11px] text-ink-3 shrink-0 tabular-nums">{fmtRelative(e.created_at)}</span>
        </div>
        {spaceName && <div className="text-[11.5px] text-ink-3 mt-0.5">{spaceName}</div>}
        {detailLines.length > 0 && (
          <ul className={`mt-1 text-[13px] leading-snug ${e.kind === "dropped" || e.kind === "read" ? "text-ink-3" : "text-ink-2"}`}>
            {detailLines.map((l, i) => (
              <li key={i} className={detailLines.length > 1 ? "pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.6em] before:h-1 before:w-1 before:rounded-full before:bg-black/20" : ""}>
                {l}
              </li>
            ))}
          </ul>
        )}
        {pending && <PendingControls commitId={e.ref_id!} info={pending} />}
      </div>
    </li>
  );
}

function PendingControls({ commitId, info }: { commitId: string; info: PendingInfo }) {
  const ev = evaluateApprovals(info.space, info.members, info.votes);
  const voters = info.members.filter((m) => info.votes.some((v) => v.member_id === m.id));
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <form action={voteAction} className="flex gap-1.5">
        <input type="hidden" name="commit_id" value={commitId} />
        <input type="hidden" name="space_id" value={info.space.id} />
        <button name="vote" value="approve" className={`btn btn-sm ${info.myVote === "approve" ? "btn-primary" : "btn-dark"}`}>
          {info.myVote === "approve" ? "동의함" : "동의"}
        </button>
        <button name="vote" value="reject" className={`btn btn-sm ${info.myVote === "reject" ? "btn-danger" : "btn-secondary"}`}>
          {info.myVote === "reject" ? "반대함" : "반대"}
        </button>
      </form>
      <span className="text-[12px] text-ink-3 inline-flex items-center gap-1.5">
        {voters.length > 0 ? (
          <>
            {voters.map((m) => (
              <Avatar key={m.id} name={m.name} color={m.color} size={18} />
            ))}
            {ev.approves}명 동의{ev.rejects > 0 ? ` · ${ev.rejects}명 반대` : ""}
          </>
        ) : ev.verdict === "conflict" ? (
          "의견이 엇갈려요"
        ) : info.deadline ? (
          `${fmtDateShort(info.deadline)}까지 반대가 없으면 확정돼요`
        ) : (
          "반대가 없으면 그대로 확정돼요"
        )}
      </span>
    </div>
  );
}
