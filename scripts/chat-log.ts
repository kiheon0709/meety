// 녹화 기록 → 말풍선 회의 장면 기록(S11 docs/presentation/video/chat/README.md 형식).
// 기록은 record-screen.ts --dump가 남긴 것: 사람 말(final 글·화자), 두뇌 이벤트, 미티가 실제로 소리 낸 문장(tts on/off), 끼어들기(barge_in).
//
//   npx tsx scripts/chat-log.ts 기록.json --out chat/scene-1.json [--id scene-1] [--title "…"] [--script 대본.md] [--from 초] [--to 초]
//
// --script: 대본(md, live-replay와 같은 형식)이 있으면 받아쓰기 글 대신 대본 대사·화자를 쓴다(가장 비슷한 다음 줄 3개 안에서 고름).
// --from/--to: 녹화 시작(t0)부터 초. 장면의 0초는 --from(없으면 첫 사람 말 0.5초 전). 기록에 source.offset으로 남겨 소리도 같은 데서 자른다.
import fs from "node:fs";
import { parseScenario } from "../src/lib/live/scenario";
import type { Rec } from "./screen-voice";

type Card = { kind?: "web"; label?: string; title: string; body?: string; source?: string; url?: string };
type Ev = { t: number; who: string; act?: string; text?: string; dur?: number; to?: string; card?: Card };
type Person = { name: string; color: string; bg: string };
type Opts = { id: string; title: string; script?: { speaker: string; text: string }[]; from?: number; to?: number };

// S11 시험 기록과 같은 색. 그 밖의 사람은 회색
const TEAM: [string, string, Person][] = [
  ["기헌", "a", { name: "기헌", color: "#0369A1", bg: "#E0F2FE" }],
  ["태은", "b", { name: "태은", color: "#15803D", bg: "#DCFCE7" }],
  ["준영", "c", { name: "준영", color: "#6D28D9", bg: "#EDE9FE" }],
  ["지호", "d", { name: "지호", color: "#B45309", bg: "#FEF3C7" }],
];
const CARD_LABEL: Record<string, string> = { conflict: "근거", research: "리서치", structure: "정리", owner_gap: "할 일", suggest: "제안", feedback: "피드백" };

// 글자 두 개씩 겹치는 비율(받아쓰기 글 ↔ 대본 대사)
function overlap(a: string, b: string) {
  const bi = (s: string) => { const t = s.replace(/[\s.,?!~…]/g, ""); const out = new Set<string>(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
  const x = bi(a), y = bi(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return n / Math.min(x.size, y.size);
}

type Ev0 = Record<string, unknown> & { type: string };
export function toChat(rec: Rec & { t0: number }, o: Opts) {
  const people: Record<string, Person> = {};
  const keyOf = (name: string | undefined) => {
    const nm = name?.trim() || "?";
    const team = TEAM.find(([n]) => nm.includes(n));
    const key = team ? team[1] : `p${Object.keys(people).filter((k) => k.startsWith("p")).length + 1}`;
    if (!people[key] && !Object.values(people).some((p) => p.name === nm)) people[key] = team ? team[2] : { name: nm, color: "#475569", bg: "#F1F5F9" };
    return team ? key : Object.entries(people).find(([, p]) => p.name === nm)![0];
  };
  const raw: (Omit<Ev, "t"> & { at: number })[] = [];

  // 사람 말: 말 시작 시각(speech_start)에, 미티 소리로 잡힌 것(echo)은 뺀다
  const startOf = new Map<number, number>();
  for (const [t, type, id] of rec.voice) if (type === "speech_start" && !startOf.has(id)) startOf.set(id, t);
  let line = 0;
  for (const [t, d] of rec.finals ?? []) {
    if (d.echo || !d.text.trim()) continue;
    let speaker = d.speaker, text = d.text.trim();
    if (o.script) {
      let best = -1, score = 0.3;
      for (let i = line; i < Math.min(o.script.length, line + 3); i++) {
        const s = overlap(text, o.script[i].text);
        if (s > score) { score = s; best = i; }
      }
      if (best >= 0) { speaker = o.script[best].speaker; text = o.script[best].text; line = best + 1; }
    }
    raw.push({ at: startOf.get(d.id) ?? t - (d.t1 - d.t0) * 1000, who: keyOf(speaker), text });
  }

  // 미티: 두뇌 이벤트에서 생각·카드·손들기·사설
  const brain = (rec.brain ?? []) as [number, Ev0][];
  const kindOf = new Map<string, string>();
  const sentencesOf = new Map<string, string[]>();
  const thought = new Set<string>();
  for (const [t, d] of brain) {
    const id = String(d.actionId ?? "");
    if (d.kind && id) kindOf.set(id, String(d.kind));
    if ((d.type === "speak" || d.type === "prepare") && id) sentencesOf.set(id, (d.sentences as string[]) ?? [String(d.text)]);
    if ((d.type === "queued" || d.type === "think") && !thought.has(id || `${t}`)) {
      thought.add(id || `${t}`);
      raw.push({ at: t, who: "meety", act: "think" });
    } else if (d.type === "hand_raise" && d.audience !== "member") {
      raw.push({ at: t, who: "meety", act: "hand", text: String(d.preview) });
    } else if (d.type === "private" || (d.type === "hand_raise" && d.audience === "member")) {
      raw.push({ at: t, who: "meety", act: "private", to: keyOf(String(d.to)), text: String(d.text ?? d.preview) });
    } else if (d.type === "show") {
      const c = d.canvas as { kind: string; title?: string; items?: { label: string; quote?: string; docId?: string; loc?: string }[]; lines?: string[]; aLabel?: string; bLabel?: string; rows?: { label: string; a: unknown; b: unknown }[] };
      const label = CARD_LABEL[kindOf.get(id) ?? ""] ?? "근거";
      if (c.kind === "evidence" && c.items?.length) {
        const e = c.items[0];
        raw.push({ at: t, who: "meety", act: "card", card: { label, title: e.label, ...(e.quote ? { body: e.quote } : {}), ...(e.docId ? { source: [e.docId, e.loc].filter(Boolean).join(" · ") } : {}) } });
      } else if (c.kind === "compare" && c.rows) {
        raw.push({ at: t, who: "meety", act: "card", card: { label: "정리", title: c.title ?? "", body: c.rows.map((r) => `${r.label}: ${c.aLabel} ${r.a} / ${c.bLabel} ${r.b}`).join("\n") } });
      } else if (c.title) {
        // 웹 리서치(두뇌 webResearch): 줄 = 말한 문장들 + "출처(웹): 제목 — 주소" → S11 웹 카드(kind: web)
        const src = (c.lines ?? []).map((l) => l.match(/^출처\(웹\):\s*(.*?)\s+—\s+(\S+)$/)).filter((m) => m) as RegExpMatchArray[];
        const said = (c.lines ?? []).filter((l) => !l.startsWith("출처(웹):"));
        if (src.length) raw.push({ at: t, who: "meety", act: "card", card: { kind: "web", title: said[0] ?? c.title, ...(said.length > 1 ? { body: said.slice(1).join("\n") } : {}), source: src[0][1], url: src[0][2] } });
        else raw.push({ at: t, who: "meety", act: "card", card: { label, title: c.title, ...(c.lines?.length ? { body: c.lines.join("\n") } : {}) } });
      }
    }
  }

  // 미티 말: 실제로 소리 낸 문장(tts on~off)을 같은 actionId끼리 묶고, 그 사이 끼어들기면 stop
  const owner = (text: string) => [...sentencesOf].find(([, ss]) => ss.some((s) => s.trim() === text.trim()))?.[0] ?? text;
  let cur: { id: string; at: number; end: number; texts: string[] } | null = null;
  let on: number | null = null;
  const flush = () => {
    if (!cur) return;
    raw.push({ at: cur.at, who: "meety", act: "say", text: cur.texts.join(" "), dur: Math.round((cur.end - cur.at) / 100) / 10 });
    cur = null;
  };
  for (const [t, isOn, text] of rec.tts) {
    if (isOn && text) {
      const id = owner(text);
      if (cur && cur.id !== id) flush();
      if (!cur) cur = { id, at: t, end: t, texts: [] };
      cur.texts.push(text);
      on = t;
    } else if (!isOn && cur && on !== null) {
      cur.end = t;
      on = null;
      const cut = rec.barges.find((b) => b >= cur!.at && b <= t + 50);
      if (cut !== undefined) { flush(); raw.push({ at: cut, who: "meety", act: "stop" }); }
    }
  }
  flush();
  // 말한 것 중 두뇌 show가 없는 것: speak 근거 첫 줄을 카드로(말 시작 0.4초 뒤)
  const shown = new Set(brain.filter(([, d]) => d.type === "show").map(([, d]) => String(d.actionId)));
  for (const [, d] of brain) {
    if (d.type !== "speak" || d.kind === "ack" || shown.has(String(d.actionId))) continue;
    const e = (d.evidence as { label: string; quote?: string; docId?: string; loc?: string }[] | undefined)?.[0];
    const say = raw.find((r) => r.act === "say" && sentencesOf.get(String(d.actionId))?.some((s) => r.text?.includes(s.trim())));
    if (!e || !say) continue;
    if (e.label.startsWith("웹 · ")) { raw.push({ at: say.at + 400, who: "meety", act: "card", card: { kind: "web", title: say.text ?? "", source: e.label.slice(4), ...(e.loc ? { url: e.loc } : {}) } }); continue; }
    raw.push({ at: say.at + 400, who: "meety", act: "card", card: { label: CARD_LABEL[String(d.kind)] ?? "근거", title: e.label, ...(e.quote ? { body: e.quote } : {}), ...(e.docId ? { source: [e.docId, e.loc].filter(Boolean).join(" · ") } : {}) } });
  }

  const firstHuman = raw.filter((r) => r.who !== "meety").reduce((m, r) => Math.min(m, r.at), Infinity);
  const from = o.from !== undefined ? rec.t0 + o.from * 1000 : (Number.isFinite(firstHuman) ? firstHuman : rec.t0) - 500;
  const to = o.to !== undefined ? rec.t0 + o.to * 1000 : Infinity;
  // 생각(think)은 6초 안에 말·손들기·사설·카드로 이어진 것만 — 이어지지 않았거나 미티가 말하는 중에 온 것은 빼야 장면이 헷갈리지 않는다
  const acts = raw.filter((r) => r.act === "say" || r.act === "hand" || r.act === "private" || r.act === "card");
  const saying = (at: number) => raw.some((r) => r.act === "say" && r.at < at && at < r.at + (r.dur ?? 0) * 1000);
  const kept = raw.filter((r) => r.act !== "think" || (!saying(r.at) && acts.some((a) => a.at >= r.at && a.at - r.at <= 6000)));
  const events = kept
    .filter((r) => r.at >= from && r.at <= to)
    .sort((a, b) => a.at - b.at)
    .map(({ at, ...e }) => ({ t: Math.round((at - from) / 100) / 10, ...e }));
  const last = events.reduce((m, e) => Math.max(m, e.t + (e.dur ?? 0)), 0);
  const keys = Object.keys(people).sort();
  return {
    id: o.id,
    title: o.title,
    duration: Math.ceil(o.to !== undefined ? o.to - (from - rec.t0) / 1000 : last + 2),
    people: Object.fromEntries(keys.map((k) => [k, people[k]])),
    events,
    source: { offset: Math.round(from - rec.t0) / 1000 }, // 녹화(t0)에서 장면 0초까지 — 소리도 여기서 자른다
  };
}

if (process.argv[1]?.endsWith("chat-log.ts")) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const file = argv[0];
  if (!file || file.startsWith("--")) { console.error("쓰는 법: npx tsx scripts/chat-log.ts 기록.json --out 장면.json [--id] [--title] [--script 대본.md] [--from 초] [--to 초]"); process.exit(1); }
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const script = opt("script") ? parseScenario(fs.readFileSync(opt("script")!, "utf8")).lines.map((l) => ({ speaker: l.speaker, text: l.text })) : undefined;
  const id = opt("id") ?? "scene";
  const chat = toChat(rec, { id, title: opt("title") ?? id, script, from: opt("from") ? Number(opt("from")) : undefined, to: opt("to") ? Number(opt("to")) : undefined });
  const out = opt("out") ?? `${id}.json`;
  fs.writeFileSync(out, JSON.stringify(chat, null, 2) + "\n");
  const n = (a: string) => chat.events.filter((e) => e.act === a).length;
  console.log(`${out}: ${chat.duration}초, 사람 말 ${chat.events.filter((e) => e.who !== "meety").length} · 미티 말 ${n("say")} · 카드 ${n("card")} · 손 ${n("hand")} · 사설 ${n("private")} · 멈춤 ${n("stop")} (녹화 ${chat.source.offset}초부터)`);
}
