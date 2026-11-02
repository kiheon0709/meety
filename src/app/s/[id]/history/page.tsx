import Link from "next/link";
import { getCommits } from "@/lib/head";
import { getSourcesByIds, listMembers, listSessions } from "@/lib/service";
import type { CommitWithChanges, Member } from "@/lib/types";
import { AvatarStack, Empty, fmtDate } from "@/components/ui";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 히스토리: 프로젝트의 모든 업데이트를 최신순으로. 깃허브 commits 구조, 말은 우리 말.
export default async function HistoryPage({ params }: PageProps<"/s/[id]/history">) {
  const { id } = await params;
  const sessions = new Map(listSessions(id).map((s) => [s.id, s]));
  const members = listMembers(id);
  const commits = getCommits(id).slice().reverse();

  if (!commits.length) return <Empty>아직 기록이 없어요. 첫 회의 녹취를 넣으면 여기에 시간순으로 쌓여요.</Empty>;

  // 각 업데이트의 "누가" = 근거 발화의 화자들 (수동 업데이트는 작성자)
  const allSourceIds = [...new Set(commits.flatMap((c) => c.changes.flatMap((ch) => ch.source_ids)))];
  const sourceSpeaker = new Map(getSourcesByIds(allSourceIds).map((s) => [s.id, s.speaker]));
  const byName = new Map(members.map((m) => [m.name, m]));
  const whoOf = (c: CommitWithChanges): Member[] => {
    if (c.author_member_id) {
      const m = members.find((x) => x.id === c.author_member_id);
      return m ? [m] : [];
    }
    const names = [...new Set(c.changes.flatMap((ch) => ch.source_ids.map((sid) => sourceSpeaker.get(sid))).filter(Boolean))] as string[];
    return names.map((n) => byName.get(n) ?? ({ id: n, name: n, color: "stone" } as Member));
  };

  const groups: { session: ReturnType<typeof sessions.get>; commits: CommitWithChanges[] }[] = [];
  for (const c of commits) {
    const last = groups.at(-1);
    if (last && last.session?.id === c.session_id) last.commits.push(c);
    else groups.push({ session: sessions.get(c.session_id), commits: [c] });
  }
  const live = commits.filter((c) => !c.reverted && c.status !== "rejected").length;

  return (
    <div className="max-w-3xl">
      <p className="fade-up text-[13.5px] text-ink-3 mb-6" style={S(2)}>
        업데이트 {live}개. 위가 최신이에요. 팀이 생각을 바꿔 온 과정이 한 줄로 보여요.
      </p>
      <ol className="relative ml-2 border-l border-black/10 space-y-8">
        {groups.map((g, gi) => (
          <li key={g.session?.id ?? gi} className="fade-up pl-7 relative" style={S(gi + 3)}>
            <span className="absolute -left-[9px] top-1 h-4 w-4 rounded-full bg-[color:var(--bg)] ring-1 ring-black/15 flex items-center justify-center">
              <span className="h-1.5 w-1.5 rounded-full bg-black/35" />
            </span>
            <div className="flex items-baseline gap-2 text-[13.5px] mb-2.5">
              <span className="text-[12px] text-ink-3 tabular-nums">{fmtDate(g.session?.held_at)}</span>
              {g.session && g.session.kind === "meeting" ? (
                <Link href={`/s/${id}/sessions/${g.session.id}`} className="font-semibold hover:underline underline-offset-4 decoration-black/20">
                  {g.session.title}
                </Link>
              ) : (
                <span className="font-semibold">회의 밖 논의</span>
              )}
            </div>
            <ul className="card divide-hair overflow-hidden">
              {g.commits.map((c) => (
                <CommitRow key={c.id} c={c} spaceId={id} who={whoOf(c)} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CommitRow({ c, spaceId, who }: { c: CommitWithChanges; spaceId: string; who: Member[] }) {
  const isPending = c.status === "pending";
  const muted = c.reverted === 1 || c.status === "rejected";
  const n = (op: string) => c.changes.filter((x) => x.op === op).length;
  return (
    <li>
      <Link href={`/s/${spaceId}/c/${c.id}`} className={`group flex items-center gap-4 px-5 py-3.5 hover:bg-black/2 transition ${muted ? "opacity-55" : ""}`}>
        <AvatarStack members={who} size={26} max={3} />
        <div className="min-w-0 flex-1">
          <div className={`font-medium text-[15px] leading-snug ${muted ? "line-through decoration-black/20" : ""}`}>{c.message}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            {isPending && <span className="rounded-md bg-orange/15 text-amber-ink px-1.5 py-[1px] font-medium">한 번 봐주세요</span>}
            {c.reverted === 1 && <span className="rounded-md bg-black/6 px-1.5 py-[1px]">되돌림</span>}
            {c.status === "rejected" && <span className="rounded-md bg-black/6 px-1.5 py-[1px]">거절됨</span>}
            <span className="font-mono text-[11px] flex gap-2">
              {n("add") > 0 && <span className="text-green-ink">+{n("add")}</span>}
              {n("supersede") > 0 && <span className="text-blue">⇒{n("supersede")}</span>}
              {n("update") > 0 && <span className="text-amber-ink">~{n("update")}</span>}
              {n("withdraw") > 0 && <span className="text-red">✕{n("withdraw")}</span>}
            </span>
          </div>
        </div>
        <span className="font-mono text-[11px] text-black/25 group-hover:text-ink-3 transition shrink-0">#{c.seq}</span>
      </Link>
    </li>
  );
}
