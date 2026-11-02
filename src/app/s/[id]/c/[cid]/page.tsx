import Link from "next/link";
import { notFound } from "next/navigation";
import { getCommits, getHead } from "@/lib/head";
import { getCurrentMember } from "@/lib/auth";
import { getSession, getSourcesByIds, getSpace, listApprovals, listMembers } from "@/lib/service";
import { CommitCard } from "@/components/CommitCard";
import { SourceQuotes } from "@/components/SourceQuote";
import { fmtDateShort } from "@/components/ui";
import { TellBar } from "@/components/TellBar";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

export default async function CommitPage({ params }: PageProps<"/s/[id]/c/[cid]">) {
  const { id, cid } = await params;
  const all = getCommits(id);
  const idx = all.findIndex((c) => c.id === cid);
  if (idx < 0) notFound();
  const commit = all[idx];
  const prev = all[idx - 1];
  const next = all[idx + 1];
  const space = getSpace(id)!;
  const session = getSession(commit.session_id);
  const members = listMembers(id);
  const me = await getCurrentMember(id);
  const approvals = listApprovals([cid]);
  const nodes = new Map(getHead(id).map((n) => [n.id, n]));
  const sourceIds = [...new Set(commit.changes.flatMap((ch) => ch.source_ids))];
  const sources = getSourcesByIds(sourceIds);
  const sessionTitle = new Map(session ? [[session.id, session.kind === "discussion" ? "회의 밖 논의" : `${session.title} · ${fmtDateShort(session.held_at)}`]] : []);
  const nav = (c: typeof prev, label: string) =>
    c ? (
      <Link href={`/s/${id}/c/${c.id}`} className="btn btn-sm btn-secondary" title={c.message}>
        {label}
      </Link>
    ) : (
      <span className="btn btn-sm btn-secondary opacity-40">{label}</span>
    );

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5 min-w-0">
        <div className="fade-up flex items-center justify-between text-[12px]" style={S(2)}>
          <Link href={`/s/${id}/history`} className="text-ink-3 hover:text-ink transition">
            ← 히스토리
          </Link>
          <div className="flex items-center gap-1.5">
            {nav(prev, "← 이전")}
            {nav(next, "다음 →")}
          </div>
        </div>
        <div className="fade-up" style={S(3)}>
          <div className="text-[12px] text-ink-3">
            <span className="font-mono">#{commit.seq}</span> · {session?.kind === "discussion" ? "회의 밖 논의" : `${fmtDateShort(session?.held_at)} · `}
            {session && session.kind === "meeting" && (
              <Link href={`/s/${id}/sessions/${session.id}`} className="hover:underline underline-offset-4">
                {session.title}
              </Link>
            )}
          </div>
          <h1 className="text-[24px] sm:text-[28px] font-bold tracking-[-0.03em] leading-tight mt-1.5">{commit.message}</h1>
        </div>
        <CommitCard commit={commit} space={space} nodes={nodes} members={members} approvals={approvals} me={me} index={4} hideMessage />
        {commit.status !== "rejected" && (
          <div className="fade-up" style={S(5)}>
            <div className="text-[12px] text-ink-3 mb-1.5">미티가 잘못 읽었나요? 한 줄로 알려주면 되돌리고 다시 정리해요.</div>
            <TellBar spaceId={id} commitId={commit.id} compact placeholder="예: 이건 결정이 아니라 지호 혼자 의견이었어 / 담당은 태은이 아니라 준영이야" />
          </div>
        )}
      </div>
      <aside className="fade-up lg:sticky lg:top-20 self-start" style={S(3)}>
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-3">근거가 된 말</h2>
        <SourceQuotes sources={sources} sessionTitles={sessionTitle} />
      </aside>
    </div>
  );
}
