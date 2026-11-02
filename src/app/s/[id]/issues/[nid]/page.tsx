import Link from "next/link";
import { notFound } from "next/navigation";
import { getCommits, getHead } from "@/lib/head";
import { getCurrentMember } from "@/lib/auth";
import {
  getSourcesByIds,
  listComments,
  listMembers,
  listSessions,
} from "@/lib/service";
import {
  addCommentAction,
  adoptClaimAction,
  closeNodeAction,
  proposeClaimAction,
  setOwnerAction,
} from "@/lib/actions";
import {
  Avatar,
  PendingBadge,
  StatusBadge,
  TypeBadge,
  fmtDateShort,
} from "@/components/ui";
import { SourceQuotes } from "@/components/SourceQuote";
import { SubmitButton } from "@/components/SubmitButton";
import { TellBar } from "@/components/TellBar";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 안건 상세: 후보 답을 나란히 (갈래 lite), 댓글(회의 밖 논의), 담당, 해결.
export default async function IssuePage({
  params,
}: PageProps<"/s/[id]/issues/[nid]">) {
  const { id, nid } = await params;
  const head = getHead(id);
  const q = head.find((n) => n.id === nid && n.type === "question");
  if (!q) notFound();
  const members = listMembers(id);
  const me = await getCurrentMember(id);
  const comments = listComments(id, nid);
  const sessions = listSessions(id);
  const sessionTitle = new Map(
    sessions.map((s) => [
      s.id,
      s.kind === "discussion"
        ? "회의 밖 논의"
        : `${s.title} · ${fmtDateShort(s.held_at)}`,
    ]),
  );
  const sources = getSourcesByIds(q.source_ids);
  const isOpen = q.status === "open";

  // 후보 답 = 같은 주제의 의견. 열린 것이 후보, 채택/기각은 결과.
  const claims = head.filter((n) => n.type === "claim" && n.topic === q.topic);
  const openClaims = claims.filter((c) => c.status === "open");
  const decidedClaims = claims.filter((c) => c.status !== "open");
  // 이 안건을 닫은 업데이트
  const resolver = getCommits(id).find(
    (c) =>
      (c.status === "applied" || c.status === "pending") &&
      !c.reverted &&
      c.changes.some(
        (ch) =>
          ch.op === "update" &&
          ch.node_id === nid &&
          ch.after.status === "resolved",
      ),
  );
  // 정한 업데이트가 만든 결정이 있으면 그것만, 없으면 같은 주제의 유효한 결정
  const resolverDecisionIds = new Set(
    resolver?.changes.flatMap((ch) =>
      ch.op === "add" && ch.node.type === "decision"
        ? [ch.node_id]
        : ch.op === "supersede" && ch.node.type === "decision"
          ? [ch.new_node_id]
          : [],
    ) ?? [],
  );
  const decisions = resolverDecisionIds.size
    ? head.filter((n) => resolverDecisionIds.has(n.id))
    : head.filter(
        (n) =>
          n.type === "decision" && n.topic === q.topic && n.status === "agreed",
      );

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
      <div className="space-y-8 min-w-0">
        <div className="fade-up" style={S(2)}>
          <Link
            href={`/s/${id}/issues`}
            className="text-[12px] text-ink-3 hover:text-ink transition"
          >
            ← 안건
          </Link>
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            <TypeBadge type="question" />
            <StatusBadge status={q.status} />
            {q.review_pending === 1 && <PendingBadge />}
            <span className="text-[12px] text-ink-3">{q.topic}</span>
          </div>
          <h1 className="text-[26px] sm:text-[30px] font-bold tracking-[-0.03em] mt-2.5 leading-tight">
            {q.title}
          </h1>
          <p className="text-ink-2 mt-3 leading-relaxed text-[16px]">
            {q.body}
          </p>
          {q.owner && (
            <p className="mt-2 text-[12.5px] text-ink-3">담당 {q.owner}</p>
          )}
          <div className="mt-4">
            <TellBar
              spaceId={id}
              nodeId={q.id}
              compact
              placeholder={
                isOpen
                  ? "미티에게 말하기 — 예: 이 안건은 무료로 가기로 하고 닫자 / 담당은 지호"
                  : "미티에게 말하기 — 예: 이 안건 다시 열자"
              }
            />
          </div>
          <details className="mt-2 group">
            <summary className="text-[12px] text-ink-3 cursor-pointer select-none hover:text-ink">
              직접 고치기
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <form
                action={setOwnerAction}
                className="inline-flex items-center gap-1.5"
              >
                <input type="hidden" name="space_id" value={id} />
                <input type="hidden" name="node_id" value={q.id} />
                <span className="text-[12px] text-ink-3">담당</span>
                <select
                  name="owner"
                  defaultValue={q.owner ?? ""}
                  className="input !w-auto !py-1 !px-2.5 text-[13px]"
                >
                  <option value="">없음</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm btn-secondary">저장</button>
              </form>
              {isOpen && (
                <form
                  action={closeNodeAction}
                  className="inline-flex items-center gap-1.5"
                >
                  <input type="hidden" name="space_id" value={id} />
                  <input type="hidden" name="node_id" value={q.id} />
                  <input
                    name="note"
                    placeholder="어떻게 정리됐나 (선택)"
                    className="input !w-56 !py-1 !px-2.5 text-[13px]"
                  />
                  <button className="btn btn-sm btn-dark">해결로 표시</button>
                </form>
              )}
            </div>
          </details>
        </div>

        {/* 해결 결과 */}
        {!isOpen && (resolver || decisions.length > 0) && (
          <section className="fade-up card p-5" style={S(3)}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              이렇게 정해졌어요
            </div>
            {decisions.map((d) => (
              <Link
                key={d.id}
                href={`/s/${id}/n/${d.id}`}
                className="block mt-2 font-semibold text-[16px] hover:underline underline-offset-4 decoration-black/20"
              >
                {d.title}
              </Link>
            ))}
            {resolver && (
              <Link
                href={`/s/${id}/c/${resolver.id}`}
                className="block mt-2 text-[13px] text-blue hover:underline underline-offset-4"
              >
                정한 업데이트 보기 · {resolver.message}
              </Link>
            )}
          </section>
        )}

        {/* 후보 답 */}
        <section className="fade-up" style={S(3)}>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              후보 답{" "}
              {openClaims.length > 0 && (
                <span className="normal-case tracking-normal text-ink-3">
                  {openClaims.length}
                </span>
              )}
            </h2>
            {isOpen && openClaims.length > 1 && (
              <span className="text-[12px] text-ink-3">
                하나를 채택하면 나머지는 보류로 남아요
              </span>
            )}
          </div>
          {openClaims.length === 0 ? (
            <p className="text-[13px] text-ink-3 card-tinted p-5">
              {isOpen
                ? '아직 후보가 없어요. 회의에서 의견이 나오면 후보로 잡혀요. 위 입력창에 "A안: ~"처럼 말해도 돼요.'
                : "채택된 답은 위에 있어요."}
            </p>
          ) : (
            <div
              className={`grid gap-3 ${openClaims.length > 1 ? "sm:grid-cols-2" : ""}`}
            >
              {openClaims.map((c, i) => {
                const owner = c.owner
                  ? members.find((m) => m.name === c.owner)
                  : undefined;
                return (
                  <div
                    key={c.id}
                    className="pop card p-5 flex flex-col"
                    style={S(i)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-indigo bg-indigo/10 rounded-md px-1.5 py-[2px]">
                        {String.fromCharCode(65 + i)}안
                      </span>
                      {owner ? (
                        <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
                          <Avatar
                            name={owner.name}
                            color={owner.color}
                            size={16}
                          />{" "}
                          {owner.name}
                        </span>
                      ) : (
                        c.owner && (
                          <span className="text-[12px] text-ink-3">
                            {c.owner}
                          </span>
                        )
                      )}
                    </div>
                    <Link
                      href={`/s/${id}/n/${c.id}`}
                      className="mt-2 font-semibold text-[16px] leading-snug hover:underline underline-offset-4 decoration-black/20"
                    >
                      {c.title}
                    </Link>
                    <p className="mt-1.5 text-[13.5px] text-ink-2 leading-relaxed flex-1">
                      {c.body}
                    </p>
                    {isOpen && (
                      <form action={adoptClaimAction} className="mt-4">
                        <input type="hidden" name="space_id" value={id} />
                        <input type="hidden" name="question_id" value={q.id} />
                        <input type="hidden" name="claim_id" value={c.id} />
                        <input
                          type="hidden"
                          name="other_claim_ids"
                          value={openClaims
                            .filter((x) => x.id !== c.id)
                            .map((x) => x.id)
                            .join(",")}
                        />
                        <SubmitButton
                          pendingText="정리 중…"
                          className="btn btn-sm btn-dark w-full"
                        >
                          이걸로 정하기
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {isOpen && (
            <details className="mt-3">
              <summary className="text-[12px] text-ink-3 cursor-pointer select-none hover:text-ink">
                후보를 직접 올리기
              </summary>
              <form
                action={proposeClaimAction}
                className="mt-2 card-flat p-4 grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]"
              >
                <input type="hidden" name="space_id" value={id} />
                <input type="hidden" name="question_id" value={q.id} />
                <input
                  name="title"
                  placeholder="후보 답 한 줄"
                  className="input"
                  required
                />
                <input
                  name="body"
                  placeholder="이유 (선택)"
                  className="input"
                />
                <SubmitButton
                  pendingText="올리는 중…"
                  className="btn btn-md btn-secondary"
                >
                  후보로 올리기
                </SubmitButton>
              </form>
            </details>
          )}
          {!isOpen && decidedClaims.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {decidedClaims.map((c) => (
                <li
                  key={c.id}
                  className="text-[13px] text-ink-3 flex items-center gap-2"
                >
                  <StatusBadge status={c.status} />
                  <Link
                    href={`/s/${id}/n/${c.id}`}
                    className={`hover:underline underline-offset-4 ${c.status === "rejected" ? "line-through decoration-black/20" : ""}`}
                  >
                    {c.title}
                  </Link>
                  {c.owner && <span>· {c.owner}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 댓글 */}
        <section className="fade-up" style={S(4)}>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-3">
            논의{" "}
            {comments.length > 0 && (
              <span className="normal-case tracking-normal">
                {comments.length}
              </span>
            )}
          </h2>
          <div className="card p-5">
            {comments.length === 0 ? (
              <p className="text-[13px] text-ink-3">
                아직 댓글이 없어요. 카톡·디스코드에서 나온 얘기를 적어두면, 다음
                회의 정리 때 미티가 같이 읽어요.
              </p>
            ) : (
              <ul className="space-y-4">
                {comments.map((cm) => {
                  const m = members.find((x) => x.id === cm.member_id);
                  return (
                    <li key={cm.id} className="flex gap-3">
                      {m && <Avatar name={m.name} color={m.color} size={28} />}
                      <div className="min-w-0">
                        <div className="text-[12px] text-ink-3">
                          <span className="font-semibold text-ink">
                            {m?.name ?? "?"}
                          </span>{" "}
                          ·{" "}
                          {new Date(cm.created_at).toLocaleString("ko-KR", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                        <p className="text-[14.5px] leading-relaxed mt-0.5">
                          {cm.text}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <form
              action={addCommentAction}
              className="mt-4 flex gap-2 items-start"
            >
              <input type="hidden" name="space_id" value={id} />
              <input type="hidden" name="node_id" value={q.id} />
              {me && <Avatar name={me.name} color={me.color} size={28} />}
              <textarea
                name="text"
                rows={2}
                placeholder={me ? `${me.name}(으)로 댓글…` : "댓글…"}
                className="input flex-1 resize-none"
                required
              />
              <button className="btn btn-md btn-primary">남기기</button>
            </form>
          </div>
        </section>
      </div>

      <aside className="fade-up lg:sticky lg:top-20 self-start" style={S(3)}>
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-3">
          이 안건이 나온 말
        </h2>
        <SourceQuotes sources={sources} sessionTitles={sessionTitle} />
      </aside>
    </div>
  );
}
