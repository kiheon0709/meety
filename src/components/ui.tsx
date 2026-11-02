import Link from "next/link";
import type { Member, NodeType } from "@/lib/types";
import { STATUS_LABEL, TYPE_LABEL } from "@/lib/types";

// ---------- Button ----------
type BtnVariant = "primary" | "dark" | "secondary" | "ghost" | "danger";
type BtnSize = "sm" | "md" | "lg";
const btnCls = (v: BtnVariant = "secondary", s: BtnSize = "md", extra = "") => `btn btn-${s} btn-${v} ${extra}`;

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  return <button className={btnCls(variant, size, className)} {...rest} />;
}

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className = "",
  children,
}: {
  href: string;
  variant?: BtnVariant;
  size?: BtnSize;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={btnCls(variant, size, className)}>
      {children}
    </Link>
  );
}

// ---------- Badges ----------
const TYPE_STYLE: Record<NodeType, string> = {
  decision: "bg-blue/10 text-blue",
  claim: "bg-indigo/10 text-indigo",
  question: "bg-orange/15 text-amber-ink",
  action: "bg-green/15 text-green-ink",
  assumption: "bg-orange/10 text-amber-ink",
  fact: "bg-black/6 text-ink-2",
};
const STATUS_STYLE: Record<string, string> = {
  agreed: "bg-ink text-surface",
  proposed: "bg-blue/10 text-blue",
  superseded: "bg-black/6 text-ink-3 line-through",
  withdrawn: "bg-black/6 text-ink-3 line-through",
  open: "bg-orange/15 text-amber-ink",
  resolved: "bg-black/6 text-ink-3",
  done: "bg-black/6 text-ink-3",
  adopted: "bg-indigo text-white",
  rejected: "bg-black/6 text-ink-3 line-through",
  active: "bg-black/6 text-ink-2",
  broken: "bg-red text-white",
};
const pill = "inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[11px] font-semibold leading-4";

export function TypeBadge({ type }: { type: NodeType }) {
  return <span className={`${pill} ${TYPE_STYLE[type]}`}>{TYPE_LABEL[type]}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  return <span className={`${pill} font-medium ${STATUS_STYLE[status] ?? "bg-black/6 text-ink-2"}`}>{STATUS_LABEL[status] ?? status}</span>;
}
export function PendingBadge({ label = "확인 대기" }: { label?: string }) {
  return (
    <span className={`${pill} bg-orange/15 text-amber-ink font-medium`}>
      <span className="h-1.5 w-1.5 rounded-full bg-orange pulse-ring" />
      {label}
    </span>
  );
}
export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "blue" | "orange" | "green" | "red" | "indigo"; children: React.ReactNode }) {
  const t = {
    neutral: "bg-black/6 text-ink-2",
    blue: "bg-blue/10 text-blue",
    orange: "bg-orange/15 text-amber-ink",
    green: "bg-green/15 text-green-ink",
    red: "bg-red/10 text-red",
    indigo: "bg-indigo/10 text-indigo",
  }[tone];
  return <span className={`${pill} font-medium ${t}`}>{children}</span>;
}

// ---------- Avatar ----------
const AVATAR: Record<string, string> = {
  sky: "bg-sky-100 text-sky-800",
  violet: "bg-violet-100 text-violet-800",
  emerald: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  rose: "bg-rose-100 text-rose-800",
  teal: "bg-teal-100 text-teal-800",
  indigo: "bg-indigo-100 text-indigo-800",
  orange: "bg-orange-100 text-orange-800",
  stone: "bg-stone-200 text-stone-700",
};
export function Avatar({ name, color = "stone", size = 24, title }: { name: string; color?: string; size?: number; title?: string }) {
  return (
    <span
      title={title ?? name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-2 ring-surface ${AVATAR[color] ?? AVATAR.stone}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {name.slice(0, 1)}
    </span>
  );
}
export function AvatarStack({ members, size = 22, max = 4 }: { members: Member[]; size?: number; max?: number }) {
  const shown = members.slice(0, max);
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {shown.map((m) => (
        <Avatar key={m.id} name={m.name} color={m.color} size={size} />
      ))}
      {members.length > max && (
        <span className="inline-flex items-center justify-center rounded-full bg-black/6 text-ink-2 ring-2 ring-surface font-medium" style={{ width: size, height: size, fontSize: 10 }}>
          +{members.length - max}
        </span>
      )}
    </span>
  );
}

// ---------- Layout bits ----------
export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <h2 className="text-[12px] font-semibold tracking-[0.06em] uppercase text-ink-3">{children}</h2>
      {aside}
    </div>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-black/12 p-8 text-center text-sm text-ink-2">{children}</div>;
}
// 에이전트가 생각 중일 때 점 세 개
export function Thinking({ className = "" }: { className?: string }) {
  return (
    <span className={`think inline-flex items-center gap-[3px] ${className}`} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
export function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-3.5 w-3.5 ${className}`} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function ArrowRight({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 ${className}`} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 10h11m0 0-4-4m4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export const fmtDate = (d?: string | null) => {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${y}. ${Number(m)}. ${Number(day)}.`;
};
export const fmtDateShort = (d?: string | null) => {
  if (!d) return "";
  const [, m, day] = d.slice(0, 10).split("-");
  return `${Number(m)}월 ${Number(day)}일`;
};
