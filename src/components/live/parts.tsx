"use client";

import { Check, CircleDashed, FileText, Hand, MessageSquareText, UserX } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ActionKind, ChecklistItem, Evidence, Intensity } from "@/lib/live/contract";
import { AgentMark } from "@/components/Logo";
import { Avatar } from "@/components/ui";
import type { Card, Hand as HandT, Line, MeetyMode } from "./state";
import { INTENSITIES, INTENSITY } from "./state";

const S = (i: number) => ({ "--i": i }) as React.CSSProperties;

// ── 미티 구슬 ────────────────────────────────────────────────
export const MODE_LABEL: Record<MeetyMode, { title: string; sub: string }> = {
  listening: { title: "듣고 있어요", sub: "확정된 것과 어긋나면 말할게요" },
  has_something: { title: "할 말이 있어요", sub: "말이 끊기면 말할게요" },
  speaking: { title: "말하는 중", sub: "끼어들면 바로 멈춰요" },
  hand_raised: { title: "손 들었어요", sub: "들을지 정해 주세요" },
  cut: { title: "말 끊김", sub: "다시 듣고 있어요" },
};

export function Orb({ mode, size = 168, talking, bars = true }: { mode: MeetyMode; size?: number; talking: boolean; bars?: boolean }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {mode === "speaking" && (
        <>
          <span className="lv-ring" />
          <span className="lv-ring" />
          <span className="lv-ring" />
        </>
      )}
      <div className="lv-orb absolute inset-0 flex items-center justify-center text-white" data-mode={mode}>
        {mode === "speaking" ? (
          <Bars on size={size} />
        ) : mode === "has_something" ? (
          <span className="think flex gap-[5px] scale-150" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        ) : (
          <svg viewBox="0 0 20 20" width={size * 0.3} height={size * 0.3} fill="none" aria-hidden className="opacity-95">
            <path d="M10 2.5l1.6 4.2 4.2 1.6-4.2 1.6L10 14.1l-1.6-4.2-4.2-1.6 4.2-1.6z" fill="currentColor" />
            <path d="M15.5 13.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="currentColor" opacity="0.85" />
          </svg>
        )}
      </div>
      {mode === "hand_raised" && (
        <span
          className="absolute -right-1 -top-1 rounded-full bg-orange text-white flex items-center justify-center shadow-lg pulse-ring"
          style={{ width: size * 0.36, height: size * 0.36 }}
        >
          <Hand className="lv-hand" style={{ width: size * 0.19, height: size * 0.19 }} strokeWidth={2.2} />
        </span>
      )}
      {mode === "listening" && bars && (
        <span className="absolute left-1/2 -translate-x-1/2 text-agent" style={{ bottom: -size * 0.26 }}>
          <Bars on={talking} size={size} />
        </span>
      )}
    </div>
  );
}

function Bars({ on, size }: { on: boolean; size: number }) {
  return (
    <span className="lv-bars" data-on={on ? "1" : "0"} style={{ transform: `scale(${Math.max(0.7, size / 168)})` }} aria-hidden>
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

// ── 강도 ─────────────────────────────────────────────────────
export function IntensityControl({
  value,
  pending,
  flashKey,
  onPick,
  onConfirm,
  onCancel,
  compact,
  note,
}: {
  note?: string;
  value: Intensity;
  pending?: Intensity;
  flashKey?: number;
  onPick: (i: Intensity) => void;
  onConfirm: () => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "" : "min-w-[220px]"}>
      <div className="flex items-center gap-2">
        {!compact && <span className="text-[12px] font-semibold text-ink-3">끼어들기</span>}
        <div key={flashKey} className={`seg ${flashKey ? "lv-flash" : ""}`} role="radiogroup" aria-label="끼어들기 강도">
          {INTENSITIES.map((i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={value === i}
              onClick={() => i !== value && onPick(i)}
              className={`rounded-full px-3.5 py-1 text-[13.5px] transition ${value === i ? `bg-surface text-ink font-semibold shadow-[0_1px_2px_rgba(0,0,0,.08),0_0_0_0.5px_var(--line)]"}` : "text-ink-2 hover:text-ink"}`}
            >
              {INTENSITY[i].label}
            </button>
          ))}
        </div>
      </div>
      {pending ? (
        <div className="pop mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-orange/10 px-3 py-2 text-[12.5px] text-amber-ink">
          <span className="font-medium">&apos;{INTENSITY[pending].label}&apos;로 올릴까요? 미티가 더 자주 말해요</span>
          <span className="ml-auto flex gap-1.5">
            <button type="button" onClick={onConfirm} className="btn btn-sm btn-dark">
              올리기
            </button>
            <button type="button" onClick={onCancel} className="btn btn-sm btn-secondary">
              그대로
            </button>
          </span>
        </div>
      ) : note ? (
        <p key={note} className={`pop mt-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-agent ${compact ? "justify-start" : "justify-end"}`}>
          <AgentMark size={16} />
          {note}
        </p>
      ) : (
        <p className={`text-[12px] text-ink-3 mt-1.5 ${compact ? "text-left" : "text-right"}`}>{INTENSITY[value].line}</p>
      )}
    </div>
  );
}

// ── 근거 ─────────────────────────────────────────────────────
export function EvidenceCard({ e, i = 0 }: { e: Evidence; i?: number }) {
  return (
    <div className="pop card p-3.5" style={S(i)}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-agent/10 text-agent">
          {e.docId ? <FileText className="h-3 w-3" /> : <MessageSquareText className="h-3 w-3" />}
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold leading-snug">{e.label}</div>
          {e.quote && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2 pl-2.5 [box-shadow:inset_2px_0_0_color-mix(in_oklab,var(--agent-1)_35%,transparent)]">{e.quote}</p>}
          {(e.docId || e.loc) && (
            <div className="mt-1.5 text-[11px] text-ink-3">
              {e.docId}
              {e.loc && ` · ${e.loc}`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const KIND_LABEL: Record<ActionKind, string> = {
  conflict: "정한 것과 달라요",
  open_item: "아직 안 정해졌어요",
  owner_gap: "담당이 비었어요",
  structure: "정리 방법 제안",
  quiet_member: "조용한 분",
  research: "찾아본 것",
  feedback: "피드백",
  suggest: "제안",
  answer: "물어본 것",
  ack: "알겠어요",
};

// ── 손 든 항목 ───────────────────────────────────────────────
export function HandList({ hands, onRespond, compact }: { hands: HandT[]; onRespond: (id: string, accept: boolean) => void; compact?: boolean }) {
  if (!hands.length) return null;
  return (
    <div className="space-y-2">
      {hands.map((h, i) => (
        <div key={h.actionId} className="pop flex flex-wrap items-center gap-3 rounded-2xl bg-orange/10 px-4 py-3 [box-shadow:inset_0_0_0_0.5px_color-mix(in_oklab,var(--orange)_35%,transparent)]" style={S(i)}>
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange text-white">
            <Hand className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <div className="min-w-[12rem] flex-1">
            <div className="text-[11.5px] font-semibold text-amber-ink">미티가 손 들었어요 · {KIND_LABEL[h.kind]}</div>
            <div className={`${compact ? "text-[13.5px]" : "text-[15px]"} font-medium leading-snug mt-0.5`}>{h.preview}</div>
          </div>
          <div className="ml-auto flex gap-1.5 shrink-0">
            <button type="button" onClick={() => onRespond(h.actionId, true)} className="btn btn-sm btn-agent">
              말해줘
            </button>
            <button type="button" onClick={() => onRespond(h.actionId, false)} className="btn btn-sm btn-secondary">
              괜찮아
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 방금 바뀐 것 ─────────────────────────────────────────────
export function ChangeCards({ cards }: { cards: Card[] }) {
  if (!cards.length)
    return (
      <div className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-3">
        회의에서 정해지는 게 생기면
        <br />
        여기에 쌓여요
      </div>
    );
  return (
    <div className="space-y-3">
      {[...cards].reverse().map((c, i) => (
        <article key={c.cardId} className={`pop card p-4 ${i === 0 ? "ring-1 ring-agent/25" : ""}`}>
          <div className="flex items-center gap-2">
            <AgentMark size={18} />
            <h3 className="text-[13px] font-semibold text-ink-2">{c.title}</h3>
            {i === 0 && <span className="ml-auto text-[11px] font-semibold text-agent">방금</span>}
          </div>
          {c.from && (
            <p className="mt-2.5 text-[13.5px]">
              <span className="strike" style={{ "--d": "0.5s" } as React.CSSProperties}>
                {c.from}
              </span>
            </p>
          )}
          <p className="mt-1 text-[16px] font-semibold leading-snug tracking-[-0.02em]">
            {c.from && <span className="text-agent mr-1">→</span>}
            {c.to}
          </p>
          {c.evidence.length > 0 && (
            <div className="mt-2.5 space-y-1">
              {c.evidence.slice(0, 2).map((e, k) => (
                <p key={k} className="text-[12px] leading-relaxed text-ink-3">
                  {e.quote ? `“${e.quote}”` : e.label}
                </p>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

// ── 안건 진행 ────────────────────────────────────────────────
export function StatusIcon({ status, size = 16 }: { status: ChecklistItem["status"]; size?: number }) {
  if (status === "done")
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-green text-white" style={{ width: size, height: size }}>
        <Check style={{ width: size * 0.65, height: size * 0.65 }} strokeWidth={3} />
      </span>
    );
  if (status === "no_owner")
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-orange/15 text-amber-ink" style={{ width: size, height: size }}>
        <UserX style={{ width: size * 0.65, height: size * 0.65 }} strokeWidth={2.4} />
      </span>
    );
  return <CircleDashed className="shrink-0 text-ink-3" style={{ width: size, height: size }} />;
}

export function AgendaProgress({ agenda }: { agenda: { title: string; items: { expected: string; status: ChecklistItem["status"]; note?: string }[] }[] }) {
  if (!agenda.length) return <p className="text-[13px] text-ink-3">안건 없이 시작했어요</p>;
  return (
    <ol className="space-y-3.5">
      {agenda.map((a, i) => {
        const done = a.items.length > 0 && a.items.every((x) => x.status === "done");
        return (
          <li key={a.title}>
            <div className="flex items-center gap-2">
              <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${done ? "bg-green text-white" : "bg-black/6 text-ink-2"}`}>
                {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className={`text-[14px] font-semibold ${done ? "text-ink-2" : ""}`}>{a.title}</span>
            </div>
            {a.items.length > 0 && (
              <ul className="mt-1.5 ml-7 space-y-1">
                {a.items.map((x) => (
                  <li key={x.expected} className="flex items-start gap-1.5 text-[12.5px]">
                    <span className="mt-[1px]">
                      <StatusIcon status={x.status} size={14} />
                    </span>
                    <span className={x.status === "done" ? "text-ink-2" : "text-ink-3"}>
                      {x.expected}
                      {x.note && x.status === "done" && <span className="text-ink-2 font-medium"> · {x.note}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ── 받아쓰기 (작게) ──────────────────────────────────────────
export function Transcript({ lines, colors, className = "" }: { lines: Line[]; colors: Record<string, string>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [lines]);
  return (
    <div ref={ref} className={`overflow-y-auto space-y-2 pr-1 ${className}`}>
      {lines.length === 0 && <p className="text-[12.5px] text-ink-3">말이 들리면 여기에 적혀요</p>}
      {lines.map((l) => (
        <div key={l.id} className={`flex gap-2 text-[12.5px] leading-relaxed ${l.final && !l.echo ? "" : "opacity-55"}`} title={l.echo ? "미티가 말하던 중에 들어온 말이에요" : undefined}>
          {l.speaker ? <Avatar name={l.speaker} color={colors[l.speaker]} size={18} /> : <span className="h-[18px] w-[18px] shrink-0 rounded-full bg-black/6" />}
          <p className="min-w-0">
            {l.speaker && <span className="font-semibold mr-1">{l.speaker}</span>}
            <span className={`text-ink-2 ${l.final ? "" : "caret"}`}>{l.text}</span>
            {l.echo && <span className="ml-1 rounded bg-agent/10 px-1 text-[10.5px] font-semibold text-agent">미티 소리?</span>}
          </p>
        </div>
      ))}
    </div>
  );
}
