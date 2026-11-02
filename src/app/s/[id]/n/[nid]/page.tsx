import Link from "next/link";
import { notFound } from "next/navigation";
import { getCommits, getHead } from "@/lib/head";
import { getSourcesByIds, listMembers, listSessions } from "@/lib/service";
import { closeNodeAction, setOwnerAction } from "@/lib/actions";
import {
  PendingBadge,
  StatusBadge,
  TypeBadge,
  fmtDateShort,
} from "@/components/ui";
import { SourceQuotes } from "@/components/SourceQuote";
import { ChangeView } from "@/components/ChangeView";
import { plain } from "@/lib/plain";
import { TellBar } from "@/components/TellBar";

export const dynamic = "force-dynamic";
const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// 항목 하나의 "왜?" 화면: 현재 내용, 바뀌어 온 길, 건드린 업데이트들(시간순), 그때 한 말.
export default async function NodePage({
  params,
}: PageProps<"/s/[id]/n/[nid]">) {
  const { id, nid } = await params;
  const nodes = getHead(id);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const node = nodeMap.get(nid);
  if (!node) notFound();

  const sessions = listSessions(id);
  const members = listMembers(id);
  const sessionMeta = new Map(sessions.map((s) => [s.id, s]));
  const sessionTitle = new Map(
    sessions.map((s) => [
      s.id,
      s.kind === "discussion"
        ? "회의 밖 논의"
        : `${s.title} · ${fmtDateShort(s.held_at)}`,
    ]),
  );
  const touches = (ch: { node_id: string; op: string; new_node_id?: string }) =>
    ch.node_id === nid || (ch.op === "supersede" && ch.new_node_id === nid);
  const touching = getCommits(id).filter(
    (c) =>
      (c.status === "applied" || c.status === "pending") &&
      !c.reverted &&
      c.changes.some(touches),
  );
  const sources = getSourcesByIds(node.source_ids);
  const struck = ["superseded", "withdrawn", "rejected"].includes(node.status);
  const closable =
    (node.type === "action" && node.status === "open") ||
    (node.type === "question" && node.status === "open");

  const chain: (typeof node)[] = [];
  let cur: typeof node | undefined = node;
  while (cur?.supersedes && nodeMap.get(cur.supersedes)) {
    cur = nodeMap.get(cur.supersedes)!;
    chain.unshift(cur);
  }
  chain.push(node);
  cur = node;
  while (cur?.superseded_by && nodeMap.get(cur.superseded_by)) {
    cur = nodeMap.get(cur.superseded_by)!;
    chain.push(cur);
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
      <div className="space-y-9 min-w-0">
        <div className="fade-up" style={S(2)}>
          <Link
            href={
              node.type === "question" ? `/s/${id}/issues` : `/s/${id}/state`
            }
            className="text-[12px] text-ink-3 hover:text-ink transition"
          >
            ← {node.type === "question" ? "안건" : "현재 상태"}
          </Link>
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            <TypeBadge type={node.type} />
            <StatusBadge status={node.status} />
            {node.review_pending === 1 && <PendingBadge />}
            <span className="text-[12px] text-ink-3">{node.topic}</span>
          </div>
          <h1
            className={`text-[26px] sm:text-[30px] font-bold tracking-[-0.03em] mt-2.5 leading-tight ${struck ? "line-through text-ink-3 decoration-black/20" : ""}`}
          >
            {node.title}
          </h1>
          <p className="text-ink-2 mt-3 leading-relaxed text-[16px]">
            {node.body}
          </p>
          {(node.owner || node.due) && (
            <p className="mt-2 text-[12.5px] text-ink-3">
              {node.owner && `담당 ${node.owner}`}
              {node.owner && node.due && " · "}
              {node.due && `기한 ${node.due}`}
            </p>
          )}
          {node.reject_reason && (
            <p className="mt-3 text-[13.5px] text-ink-2 card-tinted px-4 py-2.5">
              <span className="font-semibold">보류 사유</span> ·{" "}
              {plain(node.reject_reason)}
            </p>
          )}
          {!struck && (
            <div className="mt-4">
              <TellBar
                spaceId={id}
                nodeId={node.id}
                compact
                placeholder={
                  node.type === "action"
                    ? "미티에게 말하기 — 예: 이거 끝냈어 / 담당은 태은으로"
                    : node.type === "decision"
                      ? "미티에게 말하기 — 예: 이 결정 B로 바꾸기로 했어, 이유는 ~"
                      : "미티에게 말하기 — 예: 이 의견은 채택됐어"
                }
              />
            </div>
          )}
          {(node.type === "action" || node.type === "question") && (
            <details className="mt-2">
              <summary className="text-[12px] text-ink-3 cursor-pointer select-none hover:text-ink">
                직접 고치기
              </summary>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <form
                  action={setOwnerAction}
                  className="inline-flex items-center gap-1.5"
                >
                  <input type="hidden" name="space_id" value={id} />
                  <input type="hidden" name="node_id" value={node.id} />
                  <span className="text-[12px] text-ink-3">담당</span>
                  <select
                    name="owner"
                    defaultValue={node.owner ?? ""}
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
                {closable && (
                  <form
                    action={closeNodeAction}
                    className="inline-flex items-center gap-1.5"
                  >
                    <input type="hidden" name="space_id" value={id} />
                    <input type="hidden" name="node_id" value={node.id} />
                    <input
                      name="note"
                      placeholder={
                        node.type === "action"
                          ? "한 줄 메모 (선택)"
                          : "어떻게 정리됐나 (선택)"
                      }
                      className="input !w-52 !py-1 !px-2.5 text-[13px]"
                    />
                    <button className="btn btn-sm btn-dark">
                      {node.type === "action" ? "완료" : "해결"}
                    </button>
                  </form>
                )}
              </div>
            </details>
          )}
        </div>

        {chain.length > 1 && (
          <section className="fade-up" style={S(3)}>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-3">
              이 결정이 바뀌어 온 길
            </h2>
            <ol className="flex flex-wrap items-center gap-y-2.5">
              {chain.map((c, i) => (
                <li key={c.id} className="pop flex items-center" style={S(i)}>
                  {i > 0 && (
                    <svg
                      className="mx-1.5 h-4 w-5 text-black/25"
                      viewBox="0 0 20 16"
                      fill="none"
                      aria-hidden
                    >
                      <path
                        d="M2 8h14m0 0-4-4m4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                  {c.id === nid ? (
                    <span className="rounded-full bg-ink text-white px-3.5 py-1.5 text-[13.5px] font-semibold">
                      {c.title}
                    </span>
                  ) : (
                    <Link
                      href={`/s/${id}/n/${c.id}`}
                      className={`lift rounded-full card-flat px-3.5 py-1.5 text-[13.5px] ${c.status === "superseded" ? "text-ink-3 line-through decoration-black/20" : ""}`}
                    >
                      {c.title}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="fade-up" style={S(4)}>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-4">
            왜 이렇게 됐나
          </h2>
          {touching.length === 0 ? (
            <p className="text-[13px] text-ink-3">기록 없음</p>
          ) : (
            <ol className="relative border-l border-black/10 ml-2 space-y-6">
              {touching.map((c, i) => {
                const s = sessionMeta.get(c.session_id);
                return (
                  <li
                    key={c.id}
                    className="fade-up pl-6 relative"
                    style={S(i + 4)}
                  >
                    <span
                      className={`absolute -left-[6px] top-[7px] h-3 w-3 rounded-full ring-4 ring-[color:var(--bg)] ${c.status === "pending" ? "bg-orange" : "bg-blue"}`}
                    />
                    <div className="text-[12px] text-ink-3">
                      {s?.kind === "discussion"
                        ? "회의 밖 논의"
                        : `${fmtDateShort(s?.held_at)} · ${s?.title}`}
                      {c.status === "pending" && (
                        <span className="text-amber-ink"> · 확인 대기</span>
                      )}
                    </div>
                    <Link
                      href={`/s/${id}/c/${c.id}`}
                      className="block font-semibold mt-1 text-[15px] hover:underline underline-offset-4 decoration-black/20"
                    >
                      {c.message}
                    </Link>
                    <div className="mt-2.5 space-y-2.5 card p-4">
                      {c.changes.filter(touches).map((ch, j) => (
                        <ChangeView
                          key={j}
                          change={ch}
                          spaceId={id}
                          nodes={nodeMap}
                        />
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      <aside className="fade-up lg:sticky lg:top-20 self-start" style={S(3)}>
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-3">
          그때 한 말
        </h2>
        <SourceQuotes sources={sources} sessionTitles={sessionTitle} />
      </aside>
    </div>
  );
}
