// 회의 뒤 정리 화면 조각들 (uiux-redesign.md §5). 바뀐 결정 카드·제안→확인→확정 띠·미티가 한 일.
import { Fragment } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, Check } from "lucide-react";
import { voteAction } from "@/lib/actions";
import { evaluateApprovals } from "@/lib/service";
import type { ChangeIssue, Quote, Step, Todo } from "@/lib/meeting-view";
import type { Approval, LiveRecord, Member, Space } from "@/lib/types";
import { AgentMark } from "./Logo";
import { Avatar, fmtDateShort } from "./ui";

const STEP_ORDER: Step[] = ["proposed", "review", "final"];
const STEP_LABEL: Record<Step, string> = { proposed: "제안", review: "확인", final: "확정" };

export function Steps({ step }: { step: Step }) {
  const at = STEP_ORDER.indexOf(step);
  return (
    <span className="steps" aria-label={`지금 ${STEP_LABEL[step]} 단계`}>
      {STEP_ORDER.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <i />}
          <span data-on={i < at ? "done" : i === at ? (s === "final" ? "final" : "now") : undefined}>
            {(i < at || (s === "final" && i === at)) && <Check className="inline h-3 w-3 -mt-px mr-0.5" strokeWidth={3} />}
            {STEP_LABEL[s]}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function QuoteLine({ q, members, withMeeting = false }: { q: Quote; members: Member[]; withMeeting?: boolean }) {
  const m = members.find((x) => x.name === q.speaker);
  return (
    <div className="flex items-start gap-2">
      <Avatar name={q.speaker} color={m?.color} size={20} />
      <div className="min-w-0">
        {withMeeting && q.sessionTitle && (
          <div className="text-[11.5px] text-ink-3">
            {fmtDateShort(q.heldAt)} · {q.sessionTitle}
          </div>
        )}
        <div className="text-[13.5px] leading-relaxed">
          <span className="font-semibold">{q.speaker}</span> <span className="text-ink-2">“{q.text}”</span>
        </div>
      </div>
    </div>
  );
}

export function ChangeCard({ issue, space, members, approvals, me, index }: { issue: ChangeIssue; space: Space; members: Member[]; approvals: Approval[]; me?: Member; index: number }) {
  const { commit } = issue;
  const votes = approvals.filter((v) => v.commit_id === commit.id);
  const ev = evaluateApprovals(space, members, votes);
  const mine = votes.find((v) => v.member_id === me?.id);
  const isNew = issue.kind === "new";
  return (
    <article id={`chg-${index}`} className="fade-up card overflow-hidden scroll-mt-20" style={{ "--i": index + 2 } as React.CSSProperties}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-agent">
          <span className="h-1.5 w-1.5 rounded-full bg-agent" />
          {issue.topic}
        </span>
        <Steps step={issue.step} />
      </header>

      <div className={`px-5 pt-3 pb-5 ${isNew ? "" : "grid gap-2 sm:grid-cols-[minmax(0,1fr)_32px_minmax(0,1.35fr)] sm:items-stretch"}`}>
        {!isNew && issue.from && (
          <>
            <div className="rounded-2xl bg-black/[0.035] px-4 py-3">
              <div className="text-[11px] font-semibold text-ink-3">전에는</div>
              <div className="mt-0.5 text-[15px] text-ink-3 line-through decoration-ink-3/50 leading-snug">{issue.from.title}</div>
            </div>
            <div className="flex items-center justify-center text-agent">
              <ArrowRight className="hidden sm:block h-5 w-5" strokeWidth={2.4} />
              <ArrowDown className="sm:hidden h-5 w-5" strokeWidth={2.4} />
            </div>
          </>
        )}
        <div className={`rounded-2xl px-4 py-3 ${isNew ? "bg-black/[0.03]" : "bg-[var(--agent-soft)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--agent-1)_25%,transparent)]"}`}>
          <div className={`text-[11px] font-semibold ${isNew ? "text-ink-3" : "text-agent"}`}>{isNew ? "새로 정함" : "이번 회의에서"}</div>
          <div className={`mt-0.5 font-bold leading-snug tracking-[-0.02em] ${isNew ? "text-[16px]" : "text-[19px] sm:text-[21px]"}`}>{issue.to.title}</div>
          {issue.to.body && issue.kind !== "new" && <div className="mt-1 text-[13px] text-ink-2 leading-relaxed line-clamp-2">{issue.to.body}</div>}
        </div>
      </div>

      <div className={`grid gap-4 px-5 py-4 bg-surface-2 [box-shadow:inset_0_0.5px_0_var(--line)] ${issue.from ? "sm:grid-cols-2" : ""}`}>
        <div className="space-y-2">
          <div className="text-[11.5px] font-semibold text-ink-3">왜 · 근거 발언</div>
          <p className="text-[13.5px] leading-relaxed">{issue.reason}</p>
          {issue.quotes.map((q, i) => (
            <QuoteLine key={i} q={q} members={members} />
          ))}
        </div>
        {issue.from && (
          <div className="space-y-2">
            <div className="text-[11.5px] font-semibold text-ink-3">기존 논리</div>
            {issue.from.body && <p className="text-[13.5px] text-ink-2 leading-relaxed">{issue.from.body}</p>}
            {issue.from.quote && <QuoteLine q={issue.from.quote} members={members} withMeeting />}
          </div>
        )}
      </div>

      {commit.status === "pending" && (
        <footer className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 bg-orange/[0.07] [box-shadow:inset_0_0.5px_0_var(--line)]">
          <div className="text-[12.5px] text-amber-ink">
            {ev.approves}/{ev.needed}명 확인
            {commit.review_deadline && <> · 반대가 없으면 {fmtDateShort(commit.review_deadline)}에 확정돼요</>}
          </div>
          {me && !mine ? (
            <form action={voteAction} className="flex gap-2">
              <input type="hidden" name="space_id" value={space.id} />
              <input type="hidden" name="commit_id" value={commit.id} />
              <button name="vote" value="reject" className="btn btn-sm btn-secondary">
                반대
              </button>
              <button name="vote" value="approve" className="btn btn-sm btn-agent">
                <Check className="h-3.5 w-3.5" strokeWidth={2.6} /> 확정하기
              </button>
            </form>
          ) : mine ? (
            <span className="text-[12.5px] text-ink-2">{mine.vote === "approve" ? "확인했어요" : "반대했어요"}</span>
          ) : null}
        </footer>
      )}
    </article>
  );
}

// 미티가 회의 중에 한 일 — 역할 그림은 포스터 것 (public/meety/roles)
const ROLE_IMG: Record<string, string> = {
  conflict: "1-conflict",
  owner_gap: "2-owner-gap",
  open_item: "2-owner-gap",
  research: "3-research",
  feedback: "4-feedback",
  structure: "5-structure",
  quiet_member: "6-quiet-member",
  suggest: "7-suggest",
};
const ROLE_NAME: Record<string, string> = {
  conflict: "지난 결정 확인",
  owner_gap: "업무 분담 제안",
  open_item: "업무 분담 제안",
  research: "팀 자료 리서치",
  feedback: "피드백",
  structure: "갈등 정리",
  quiet_member: "조용한 팀원",
  suggest: "제안",
  answer: "물어봐서 답함",
  card: "합의 카드",
};
const CHANNEL: Record<LiveRecord["meety"][number]["channel"], string> = { speak: "말함", hand: "손 듦", card: "카드", private: "따로 알림" };

export function MeetyActs({ items }: { items: LiveRecord["meety"] }) {
  return (
    <div className="card divide-hair">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3.5">
          {ROLE_IMG[it.kind] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/meety/roles/${ROLE_IMG[it.kind]}.png`} alt="" width={44} height={44} className="shrink-0 rounded-xl bg-[var(--agent-soft)]" />
          ) : (
            <span className="h-11 w-11 shrink-0 rounded-xl bg-[var(--agent-soft)] flex items-center justify-center">
              <AgentMark size={30} />
            </span>
          )}
          <div className="min-w-0">
            <div className="text-[12px] text-ink-3">
              <span className="font-semibold text-agent">{ROLE_NAME[it.kind] ?? it.kind}</span> · {it.channel === "private" && it.to ? `${it.to}에게 따로 알림` : CHANNEL[it.channel]}
            </div>
            <div className="text-[14.5px] leading-snug mt-0.5">{it.channel === "private" ? "개인에게만 보낸 말이라 내용은 숨겨요" : it.text}</div>
            {it.evidence?.[0] && <div className="text-[12px] text-ink-3 mt-1">근거 · {it.evidence[0].label}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TodoRow({ t, members, spaceId, note }: { t: Todo; members: Member[]; spaceId: string; note?: React.ReactNode }) {
  const m = t.owner ? members.find((x) => x.name === t.owner) : undefined;
  const done = t.status === "done";
  return (
    <li className="py-2 flex items-start gap-2">
      <span className={`mt-[3px] h-3.5 w-3.5 shrink-0 rounded-[4px] ${done ? "bg-agent" : "shadow-[inset_0_0_0_1.5px_var(--ink-3)]"}`} />
      <div className="min-w-0 flex-1">
        <Link href={`/s/${spaceId}/n/${t.nodeId}`} className={`text-[13px] leading-snug hover:underline underline-offset-2 ${done ? "text-ink-3 line-through" : ""}`}>
          {t.title}
        </Link>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px]">
          {t.owner ? (
            <span className="inline-flex items-center gap-1 text-ink-2">
              <Avatar name={t.owner} color={m?.color} size={15} /> {t.owner}
            </span>
          ) : (
            <span className="font-semibold text-amber-ink">담당 없음</span>
          )}
          {t.due && <span className="text-ink-3">~{fmtDateShort(t.due)}</span>}
          {note}
        </div>
      </div>
    </li>
  );
}
