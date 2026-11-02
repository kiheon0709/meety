import Link from "next/link";
import { STATUS_LABEL, type Change, type HeadNode } from "@/lib/types";
import { StatusBadge, TypeBadge } from "./ui";
import { plain } from "@/lib/plain";

const FIELD_LABEL: Record<string, string> = {
  title: "제목",
  body: "내용",
  topic: "주제",
  owner: "담당",
  status: "상태",
  reject_reason: "보류 사유",
};

const GLYPH: Record<Change["op"], { g: string; cls: string; label: string }> = {
  add: { g: "+", cls: "bg-green/15 text-green-ink", label: "추가" },
  supersede: { g: "⇒", cls: "bg-blue/10 text-blue", label: "대체" },
  update: { g: "~", cls: "bg-orange/15 text-amber-ink", label: "변경" },
  withdraw: { g: "✕", cls: "bg-red/10 text-red", label: "철회" },
};

// 커밋 안의 변경 한 건을 "이전 → 이후"로 보여준다.
export function ChangeView({ change, spaceId, nodes }: { change: Change; spaceId: string; nodes: Map<string, HeadNode> }) {
  const link = (id: string, label: string, cls = "") => (
    <Link href={`/s/${spaceId}/n/${id}`} className={`hover:underline underline-offset-4 decoration-black/20 ${cls}`}>
      {label}
    </Link>
  );
  const nodeTitle = (id: string) => nodes.get(id)?.title ?? id;
  const glyph = GLYPH[change.op];

  let body: React.ReactNode;
  switch (change.op) {
    case "add":
      body = (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            <TypeBadge type={change.node.type} />
            <StatusBadge status={change.node.status} />
            <span className="font-medium">{link(change.node_id, change.node.title)}</span>
            {change.node.owner && <span className="text-[12px] text-ink-3">· {change.node.owner}</span>}
          </div>
          <p className="text-[13.5px] text-ink-2 mt-1">{change.node.body}</p>
        </>
      );
      break;
    case "supersede":
      body = (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            <TypeBadge type={change.node.type} />
            <span className="text-ink-3 line-through decoration-black/20">{link(change.node_id, nodeTitle(change.node_id), "text-ink-3")}</span>
            <span className="text-ink-3">→</span>
            <span className="font-medium">{link(change.new_node_id, change.node.title)}</span>
          </div>
          <p className="text-[13.5px] text-ink-2 mt-1">{change.node.body}</p>
          <p className="text-[12px] text-ink-3 mt-1">이유 · {plain(change.reason)}</p>
        </>
      );
      break;
    case "update":
      body = (
        <>
          <div className="font-medium">{link(change.node_id, nodeTitle(change.node_id))}</div>
          <ul className="text-[13.5px] mt-1 space-y-0.5">
            {Object.entries(change.after).map(([k, v]) => (
              <li key={k} className="flex flex-wrap gap-x-1.5">
                <span className="text-ink-3">{FIELD_LABEL[k] ?? k}</span>
                <span className="line-through text-ink-3 decoration-black/20">{fmt(k, change.before[k as keyof typeof change.before])}</span>
                <span className="text-ink-3">→</span>
                <span className={k === "status" && v === "broken" ? "text-red font-medium" : ""}>{fmt(k, v)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-ink-3 mt-1">이유 · {plain(change.reason)}</p>
        </>
      );
      break;
    case "withdraw":
      body = (
        <>
          <div className="line-through text-ink-3">{link(change.node_id, nodeTitle(change.node_id))}</div>
          <p className="text-[12px] text-ink-3 mt-1">철회 이유 · {plain(change.reason)}</p>
        </>
      );
  }

  return (
    <div className="flex gap-3 items-start">
      <span title={glyph.label} className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-xs ${glyph.cls}`}>
        {glyph.g}
      </span>
      <div className="min-w-0 flex-1 text-[14.5px]">{body}</div>
    </div>
  );
}

function fmt(k: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "(없음)";
  if (k === "status") return STATUS_LABEL[String(v)] ?? String(v);
  return String(v);
}
