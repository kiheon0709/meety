// 캔버스: 두뇌는 그리지 않고 "고른다"(show {canvas}). 화면은 허용 스펙만 그리고, 모르는 kind는 무시, 깨진 스펙은 text로 낮춘다.
// show가 없을 때(v1)는 말하는 근거·바뀐 것 카드로 화면이 스스로 고른다 (설계서 §1-3)
import { z } from "zod";
import type { CanvasSpec, Evidence } from "@/lib/live/contract";

const MAX = { items: 6, rows: 8, points: 8, data: 8, lines: 6, str: 240 };
const s = z.string().max(MAX.str);
const ev = z.object({ label: s, quote: s.optional(), nodeId: s.optional(), docId: s.optional(), loc: s.optional() });
const cell = z.union([s, z.number()]);
const SPEC = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evidence"), items: z.array(ev).min(1) }),
  z.object({ kind: z.literal("compare"), title: s, aLabel: s, bLabel: s, rows: z.array(z.object({ label: s, a: cell, b: cell })).min(1) }),
  z.object({ kind: z.literal("timeline"), title: s, points: z.array(z.object({ date: s, label: s, current: z.boolean().optional() })).min(1) }),
  z.object({ kind: z.literal("text"), title: s, lines: z.array(s) }),
]);
const KINDS = ["evidence", "compare", "timeline", "bar", "flow", "text"];

// 검증 전에 배열을 자르고 긴 글을 줄인다 (zod가 아주 큰 배열에서 메모리를 많이 쓰는 문제가 있어 미리)
function cap(x: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (Array.isArray(v)) out[k] = v.slice(0, (MAX as Record<string, number>)[k] ?? 8).map((e) => (e && typeof e === "object" ? cap(e as Record<string, unknown>) : e));
    else out[k] = typeof v === "string" ? v.slice(0, MAX.str) : v;
  }
  return out;
}

export function checkCanvas(x: unknown): CanvasSpec | null {
  if (!x || typeof x !== "object") return null;
  const c = cap(x as Record<string, unknown>);
  if (typeof c.kind !== "string" || !KINDS.includes(c.kind)) return null;
  const title = typeof c.title === "string" ? c.title : "";
  if (c.kind === "bar" && Array.isArray(c.data)) {
    // v2(Recharts) 전까지는 숫자 목록으로
    const lines = c.data.filter((d) => d && typeof (d as { value?: unknown }).value === "number").map((d) => `${(d as { name: string }).name} ${(d as { value: number }).value}${c.unit ?? ""}`);
    return { kind: "text", title, lines };
  }
  if (c.kind === "flow") return { kind: "text", title, lines: [] }; // v2: Mermaid strict + parse 선검증 뒤
  const r = SPEC.safeParse(c);
  if (r.success) return r.data as CanvasSpec;
  return title ? { kind: "text", title, lines: [] } : null;
}

const DATE = /^\s*(\d{1,2})\/(\d{1,2})\s*(?:회의)?\s*[—\-:]?\s*/;

export function autoCanvas(o: { evidence: Evidence[]; card?: { title: string; from?: string; to: string } }): CanvasSpec | null {
  if (o.card?.from) return { kind: "compare", title: o.card.title, aLabel: "전에", bLabel: "지금", rows: [{ label: o.card.title, a: o.card.from, b: o.card.to }] };
  const dated = o.evidence.filter((e) => DATE.test(e.label));
  if (new Set(dated.map((e) => e.label.match(DATE)![0].trim())).size >= 2) {
    const key = (e: Evidence) => {
      const m = e.label.match(DATE)!;
      return Number(m[1]) * 100 + Number(m[2]);
    };
    const points = [...dated].sort((a, b) => key(a) - key(b)).map((e) => ({ date: e.label.match(DATE)![0].replace(/[—\-:\s]|회의/g, ""), label: e.label.replace(DATE, "") }));
    return { kind: "timeline", title: "언제 정했나", points: [...points.slice(0, MAX.points - 1), { date: "오늘", label: "지금 회의", current: true }] };
  }
  if (o.evidence.length) return { kind: "evidence", items: o.evidence.slice(0, MAX.items) };
  return null;
}
