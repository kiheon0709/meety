// 재생 평가 공용: 대본을 음성 서버처럼 흘려 넣고(드라이버는 같은 프로세스 또는 HTTP), 미티 행동을 [미티 기대]와 견준다.
// 타이밍은 S2 음성 서버를 흉내 낸다: 사람이 말을 마치면(E) gap 300은 E+0.6초, gap 800은 E+0.82초, final은 E+0.9초, gap 1500은 E+1.8초.
// 즉 gap이 같은 번호의 final보다 먼저 온다.
import { appendFileSync } from "node:fs";
import type { EndMeetingRes, Intensity } from "../src/lib/live/contract";
import { speechSec, type Expect, type Line, type Scenario } from "../src/lib/live/scenario";
import type { OutEvent } from "../src/lib/live/meeting";

export interface Got {
  at: number;
  ev: OutEvent;
}

export interface CandSnap {
  actionId: string;
  kind: string;
  uttId: number;
  state: string;
  said: string;
  note?: string;
  sentences: string[];
  t: { final: number; detect?: number; ready?: number; delivered?: number; via?: string; template?: boolean; verifyMs?: number; verifyOk?: boolean; lateNo?: boolean };
}

export interface Snap {
  busy: number;
  cost: number;
  templates: number;
  templateStats: { targets: number; cached: number; made: number; ms: number; cost: number } | null;
  health?: { state: string; skipped: number };
  sessionId: string | null;
  cands: CandSnap[];
  byRole: Record<string, { n: number; avgMs: number; avgFirstMs: number; maxMs: number; hedged: number; cost: number; cacheRead: number; input: number }>;
  tokenLog: { uttId: number; fixed: number; summary: number; recent: number }[];
  planLog?: { uttId: number; trigger: string; tag: string; text: string | null; note?: string }[];
  partialLog?: { uttId: number; stable: number; reason: string }[];
  soloLog?: { uttId: number; reply: string | null }[];
  stats: { role: string; model: string; ms: number; firstTokenMs?: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; hedged?: boolean }[];
  errors: string[];
}

export interface Driver {
  start(sc: Scenario, docIds: string[]): Promise<void>;
  templatesReady(): Promise<void>;
  utter(u: { id: number; t0: number; t1: number; text: string; speaker?: string }): Promise<void>;
  gap(afterId: number, ms: 300 | 800 | 1500): Promise<void>;
  partial?(id: number, text: string, stable: number): Promise<void>;
  speech(): Promise<void>;
  end(): Promise<EndMeetingRes>;
  snapshot(): Promise<Snap>;
  events: Got[];
  close(): void;
}

export interface RunOpts {
  speed: number; // 사람 말 길이만 빠르게 (모델 지연은 그대로)
  patience: number; // 미티가 판단 중이면 사람이 최대 이만큼 더 기다려 줌(ms)
  pauseMs: number; // 사람과 사람 사이 기본 침묵 (말 끝 기준)
  fast?: boolean; // 긴 대화: 말 길이를 안 기다리고, 판단이 끝나면 바로 다음 줄
  real?: boolean; // 줄마다 t0·t1(초)이 있으면 그 시각대로 흘린다: 사람은 미티를 안 기다리고, gap은 다음 말까지 빈 만큼만
  voice?: VoiceEv[]; // 음성 서버가 실제로 낸 이벤트(recv초)를 그 시각대로 흘린다 — partial·gap·final (화면이 두뇌로 넘기는 것만)
  soniox?: boolean; // voice 재생에 Soniox 흉내 partial (0.25초마다, 안정 글자 0.3초 늦게)
  partials?: boolean; // real일 때 말하는 중 0.83초마다 받아쓰기 중간 결과(말의 앞부분)를 흘린다 (partial 선판단 채점)
  loose?: boolean; // 참여도 다이얼을 바꿔 채점할 때: 채널(소리·손들기)은 다이얼이 정하니 같은 역할이면 맞힘, 카드는 몇 줄 늦어도 맞힘 (묶음 판단)
}

export type VoiceEv =
  | { type: "partial"; id: number; text: string; stable?: number; recv: number }
  | { type: "gap"; after_id: number; ms: number; recv: number }
  | { type: "final"; id: number; t0: number; t1: number; text: string; recv: number }
  | { type: "speech_end"; id: number; recv: number }
  | { type: string; recv: number };

// 실제 음성 재생에서 말 끝·final부터 미티 행동까지 (어긋남만)
export interface VoiceTiming {
  uttId: number;
  speechEnd?: number; // 이 아래 모두 회의 시작 기준 ms
  final: number;
  draft?: number;
  queued?: number;
  act?: number;
  actType?: string;
  reused: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface Row {
  line: number;
  expect: Expect;
  got?: Got;
  ok: boolean;
  note?: string;
}

export interface RunResult {
  rows: Row[];
  extras: { line: number; got: Got; kind?: string; offense: boolean }[];
  timeline: string[];
  snap: Snap;
  end: EndMeetingRes;
  checklistOk?: boolean;
  lineSentAt: number[];
  speaks: number; // 말로 끼어든 수(conflict)
  drafts: { thinking: number; dropped: number; leadMs: number[] }; // partial 선판단: 띄운 수·거둔 수·final보다 앞선 시간
  voice?: VoiceTiming[];
  events?: Got[];
  speechEndAt?: Map<number, number>; // 실제 음성 재생: 말 끝(speech_end)을 받은 때
}

export function describeEv(ev: OutEvent): string {
  switch (ev.type) {
    case "speak":
      return `🗣 speak ${ev.kind}: ${ev.text}`;
    case "hand_raise":
      return `✋ hand_raise ${ev.kind}: ${ev.preview}`;
    case "queued":
      return `… queued ${ev.kind}: ${ev.preview}`;
    case "change_card":
      return `🃏 change_card: ${ev.title}${ev.from ? ` (${ev.from} → ${ev.to})` : ` → ${ev.to}`}`;
    case "settings":
      return `⚙ settings ${ev.intensity}${ev.pendingConfirm ? ` (확인 대기: ${ev.pendingConfirm})` : ""} by ${ev.by}`;
    case "cancel":
      return `✖ cancel ${ev.reason}${ev.note ? ` — ${ev.note}` : ""}`;
    case "checklist":
      return `☑ checklist ${ev.items.length}개${ev.final ? " (끝)" : " (중간)"}`;
    case "status":
      return `⚠ status ${ev.state}${ev.reason ? ` (${ev.reason})` : ""}: ${ev.message}`;
    case "show":
      return `🗂 show ${ev.canvas.kind}: ${ev.canvas.kind === "text" ? `${ev.canvas.title} — ${ev.canvas.lines.join(" / ")}` : ev.canvas.kind === "compare" ? `${ev.canvas.title} — ${ev.canvas.aLabel}: ${ev.canvas.rows.map((r) => r.a).join(", ")} | ${ev.canvas.bLabel}: ${ev.canvas.rows.map((r) => r.b).join(", ")}` : ""}`;
    case "private":
      return `🔒 private ${ev.kind} → ${ev.to}: ${ev.text}`;
    case "draft":
      return `💭 draft ${ev.state} #${ev.uttId}${ev.why ? `: ${ev.why}` : ""}`;
    case "budget":
      return `💰 budget ${ev.used}/${ev.limit} (${ev.windowMin}분)`;
    case "prepare":
      return ev.actionId === "templates" ? `📝 미리 만든 말 ${ev.sentences.length}개` : `· prepare ${ev.sentences.join(" ")}`;
    default:
      return ev.type;
  }
}

export async function runScenario(sc: Scenario, d: Driver, docIds: string[], o: RunOpts): Promise<RunResult> {
  await d.start(sc, docIds);
  await d.templatesReady();
  const t0 = Date.now();
  const sentAt: number[] = [];
  let clock = 0;
  if (o.voice) return runVoice(sc, d, docIds, o);
  if (o.real) return runReal(sc, d, docIds, o);
  // 첫 말 전 침묵: 미티가 회의를 여는지 본다 (여는 말은 첫 줄 것으로 셈)
  if (sc.leadPauseMs && !o.fast) {
    await sleep(sc.leadPauseMs);
    for (let k = 0; k < 100 && (await d.snapshot()).busy > 0; k++) await sleep(50);
  }
  for (let i = 0; i < sc.lines.length; i++) {
    const l = sc.lines[i];
    const id = i + 1;
    const dur = speechSec(l.text);
    const speaker = l.speaker === "?" ? undefined : l.speaker;
    await d.speech();
    if (!o.fast) await sleep((dur * 1000) / o.speed);
    const E = Date.now();
    const seen = d.events.length;
    // 음성 서버 순서: gap 300 → gap 800 → final → gap 1500
    const at = (ms: number) => sleep(E + (o.fast ? ms / 10 : ms) - Date.now());
    await at(600);
    await d.gap(id, 300);
    await at(820);
    await d.gap(id, 800);
    await at(900);
    sentAt[i] = Date.now(); // utter 안에서 바로 나오는 이벤트(설정·대답)도 이 줄 것으로 보이게 먼저 적는다
    await d.utter({ id, t0: clock, t1: clock + dur, text: l.text, speaker });
    clock += dur;
    let sent1500 = false;
    // 다음 사람은 말 끝에서 pauseMs 뒤에 말을 시작한다. 미티가 판단 중이면 patience까지 기다려 준다.
    for (;;) {
      const el = Date.now() - E;
      if (!sent1500 && el >= (o.fast ? 180 : 1800)) {
        sent1500 = true;
        await d.gap(id, 1500);
      }
      const snapBusy = (await d.snapshot()).busy > 0;
      if (o.fast ? !snapBusy && sent1500 : el >= o.pauseMs && (!snapBusy || el >= o.patience)) break;
      await sleep(o.fast ? 20 : 50);
    }
    // 대본의 "(침묵 N초)": 진짜 시간으로 아무도 말 안 한다 (먼저 꺼내기는 실제 침묵 시간을 본다). 그 뒤 미티가 생각 중이면 끝날 때까지
    if (l.pauseAfterMs && !o.fast) {
      await sleep(l.pauseAfterMs);
      for (let k = 0; k < 100 && (await d.snapshot()).busy > 0; k++) await sleep(50);
    }
    // 미티가 말했으면 그 말이 끝날 때까지 듣는다
    if (!o.fast) for (const g of d.events.slice(seen)) if (g.ev.type === "speak") await sleep((g.ev.sentences.join("").length * 160) / o.speed);
    clock += (Date.now() - E) / 1000;
  }
  const end = await d.end();
  await sleep(200);
  const snap = await d.snapshot();
  dumpSnap(sc, snap);
  d.close();
  return score(sc, d.events, snap, end, sentAt, t0, o.loose);
}

// 실제 시각대로: 음성 서버처럼 말 끝(t1)에서 gap 300(+0.6초)·800(+0.82초)·final(+0.9초)·1500(+1.8초)을 내되,
// 다음 사람이 그 전에 말을 시작하면 그 gap은 안 낸다. 받아쓰기 단어 시각은 VAD보다 늦게 끝나는 편이라
// 단어 사이가 0.5초 넘게 비면 gap 800까지는 나왔다고 본다(실제 E2E에서 0.56초 사이에 말함).
// 화면은 speech_start를 두뇌로 안 넘기므로 여기서도 안 부른다.
async function runReal(sc: Scenario, d: Driver, docIds: string[], o: RunOpts): Promise<RunResult> {
  await d.start(sc, docIds);
  await d.templatesReady();
  const lines = sc.lines as (Line & { t0: number; t1: number })[];
  const base = lines[0].t0;
  const t0 = Date.now();
  const at = (sec: number) => sleep(t0 + (sec - base) * 1000 - Date.now());
  const sentAt: number[] = [];
  const evs: { sec: number; run: () => Promise<void> }[] = [];
  lines.forEach((l, i) => {
    const id = i + 1;
    const silence = (lines[i + 1]?.t0 ?? l.t1 + 5) - l.t1;
    if (silence >= 0.3) evs.push({ sec: l.t1 + 0.6, run: () => d.gap(id, 300) });
    if (silence >= 0.5) evs.push({ sec: l.t1 + 0.82, run: () => d.gap(id, 800) });
    // 받아쓰기 중간 결과: 음성 서버처럼 말 시작 0.7초 뒤부터 0.83초마다, 그때까지 말한 만큼(글자 수 비례, S2 측정 간격)
    // stable은 음성 서버처럼 바로 앞 partial과 같은 앞 글자 수(여기선 앞부분만 자라니 앞 partial 길이)
    if (o.partials) for (let s = l.t0 + 0.7, prev = 0; s < l.t1 + 0.9; s += 0.83) {
      const text = l.text.slice(0, Math.round((l.text.length * (s - l.t0)) / Math.max(0.1, l.t1 - l.t0)));
      const stable = prev;
      prev = text.length;
      evs.push({ sec: s, run: async () => void d.partial?.(id, text, stable) });
    }
    evs.push({
      sec: l.t1 + 0.9,
      run: async () => {
        sentAt[i] = Date.now();
        await d.utter({ id, t0: l.t0, t1: l.t1, text: l.text });
      },
    });
    if (silence >= 1.5) evs.push({ sec: l.t1 + 1.8, run: () => d.gap(id, 1500) });
  });
  evs.sort((a, b) => a.sec - b.sec);
  for (const e of evs) {
    await at(e.sec);
    await e.run();
  }
  for (let k = 0; k < 200 && (await d.snapshot()).busy > 0; k++) await sleep(50);
  const end = await d.end();
  await sleep(200);
  const snap = await d.snapshot();
  dumpSnap(sc, snap);
  d.close();
  return score(sc, d.events, snap, end, sentAt, t0, o.loose);
}

// REPLAY_DUMP=파일이면 판마다 두뇌 판단 기록(먼저 꺼내기·후보 상태)을 한 줄씩 덧붙인다 — 왜 말 안 했는지 볼 때
function dumpSnap(sc: Scenario, snap: Snap) {
  const file = process.env.REPLAY_DUMP;
  if (!file) return;
  const cands = snap.cands.map((c) => ({ kind: c.kind, uttId: c.uttId, state: c.state, note: c.note, said: c.sentences.join(" ").slice(0, 80) }));
  appendFileSync(file, `${JSON.stringify({ title: sc.title, planLog: snap.planLog ?? [], cands })}\n`);
}

const SONIOX_EVERY = 0.25;
const SONIOX_LAG = 0.3;
function withSonioxPartials(evs: VoiceEv[]): VoiceEv[] {
  const out = evs.filter((e) => e.type !== "partial");
  for (const f of evs) {
    if (f.type !== "final" || !("t1" in f)) continue;
    const start = (evs.find((e) => e.type === "speech_start" && "id" in e && e.id === f.id)?.recv ?? f.recv - (f.t1 - f.t0) - 0.7) + 0.1;
    const end = f.recv - 0.35; // 말 끝 무렵
    const dur = Math.max(0.3, end - start);
    for (let t = start + SONIOX_EVERY; t < f.recv; t += SONIOX_EVERY) {
      const said = Math.min(1, (t - start) / dur);
      const sure = Math.max(0, Math.min(1, (t - SONIOX_LAG - start) / dur));
      out.push({ type: "partial", id: f.id, text: f.text.slice(0, Math.round(f.text.length * said)), stable: Math.round(f.text.length * sure), recv: t });
    }
  }
  return out.sort((a, b) => a.recv - b.recv);
}

// 실제 음성 서버 이벤트를 받은 시각(recv)대로: 화면처럼 partial·gap·final만 두뇌로 (speech_start·tick은 안 넘김)
async function runVoice(sc: Scenario, d: Driver, docIds: string[], o: RunOpts): Promise<RunResult> {
  await d.start(sc, docIds);
  await d.templatesReady();
  // --soniox: 실시간 받아쓰기(Soniox)를 흉내 — 음성 서버 partial 대신 0.25초마다, 말한 만큼에서 0.3초 늦은 데까지 안정(stable)
  const evs = o.soniox ? withSonioxPartials(o.voice!) : o.voice!;
  const t0 = Date.now();
  const sentAt: number[] = [];
  const endAt = new Map<number, number>();
  for (const e of evs) {
    await sleep(t0 + e.recv * 1000 - Date.now());
    if (e.type === "partial" && "text" in e && "id" in e && o.partials) void d.partial?.(e.id, e.text, (e as { stable?: number }).stable ?? 0);
    else if (e.type === "gap" && "after_id" in e && (e.ms === 300 || e.ms === 800 || e.ms === 1500)) await d.gap(e.after_id, e.ms);
    else if (e.type === "speech_end" && "id" in e) endAt.set(e.id, Date.now());
    else if (e.type === "final" && "t1" in e) {
      sentAt[e.id - 1] = Date.now();
      await d.utter({ id: e.id, t0: e.t0, t1: e.t1, text: e.text });
    }
  }
  for (let k = 0; k < 200 && (await d.snapshot()).busy > 0; k++) await sleep(50);
  const end = await d.end();
  await sleep(200);
  const snap = await d.snapshot();
  dumpSnap(sc, snap);
  d.close();
  const r = score(sc, d.events, snap, end, sentAt, t0, o.loose);
  r.speechEndAt = endAt;
  const at = (pred: (g: Got) => boolean) => d.events.find(pred)?.at;
  r.voice = snap.cands
    .filter((c) => c.kind === "conflict")
    .map((c) => {
      const act = d.events.find((g) => (g.ev.type === "speak" || g.ev.type === "hand_raise") && "actionId" in g.ev && g.ev.actionId === c.actionId);
      const reused = (snap.partialLog ?? []).some((x) => x.uttId === c.uttId && x.reason === "final에 이어씀");
      return {
        uttId: c.uttId,
        speechEnd: endAt.get(c.uttId) !== undefined ? endAt.get(c.uttId)! - t0 : undefined,
        final: sentAt[c.uttId - 1] - t0,
        draft: ((x) => (x === undefined ? undefined : x - t0))(at((g) => g.ev.type === "draft" && g.ev.uttId === c.uttId && g.ev.state === "thinking")),
        queued: ((x) => (x === undefined ? undefined : x - t0))(at((g) => g.ev.type === "queued" && g.ev.actionId === c.actionId)),
        act: act ? act.at - t0 : undefined,
        actType: act?.ev.type,
        reused,
      };
    });
  return r;
}

function score(sc: Scenario, got: Got[], snap: Snap, end: EndMeetingRes, sentAt: number[], t0: number, loose = false): RunResult {
  // 어느 줄에 대한 행동인지: speak·hand_raise는 후보가 기억하는 발화 번호, 나머지는 시간
  const lineOf = (g: Got): number => {
    const actionId = "actionId" in g.ev ? g.ev.actionId : undefined;
    const c = snap.cands.find((x) => x.actionId === actionId);
    if (c && (g.ev.type === "speak" || g.ev.type === "hand_raise")) return c.uttId - 1;
    let li = 0;
    for (let i = 0; i < sentAt.length; i++) if (sentAt[i] <= g.at) li = i;
    return li;
  };
  const acts = got.filter((g) => ["speak", "hand_raise", "change_card", "settings", "checklist", "show", "private"].includes(g.ev.type) && !(g.ev.type === "checklist" && !g.ev.final));
  // show(카드)는 kind가 없어서 후보로 찾는다
  const kindOf = (g: Got): string | undefined => {
    if ("kind" in g.ev) return g.ev.kind as string;
    const actionId = "actionId" in g.ev ? g.ev.actionId : undefined;
    return snap.cands.find((x) => x.actionId === actionId)?.kind;
  };
  const used = new Set<Got>();
  const rows: Row[] = [];
  sc.lines.forEach((l, i) => {
    for (const e of l.expects) {
      const voiceish = (t: string) => t === "speak" || t === "hand_raise";
      const hit = acts.find((g) => {
        if (used.has(g)) return false;
        if (g.ev.type !== e.type && !(loose && voiceish(g.ev.type) && voiceish(e.type) && e.kind !== "answer" && e.kind !== "ack")) return false;
        if (e.type === "checklist") return true;
        if ((g.ev.type === "speak" || g.ev.type === "hand_raise" || g.ev.type === "show" || g.ev.type === "private") && kindOf(g) !== e.kind) return false;
        if (g.ev.type === "settings" && (g.ev.intensity !== e.kind || g.ev.pendingConfirm)) return false;
        const li = lineOf(g);
        if (e.type === "speak" || e.type === "hand_raise") return li === i;
        // 리서치 카드는 다음 말(답이 없음)이나 침묵 뒤에 나온다 → 그 줄부터 두 줄 뒤까지
        if (e.type === "show" || e.type === "private") return li >= i && li <= i + 2;
        // 카드·설정은 그 줄 또는 바로 다음 줄(이벤트가 다음 사람 말 뒤에 도착한 경우)까지. 묶음 판단이면 몇 줄 늦게 온다
        return li >= i && li <= i + (loose ? 8 : 1);
      });
      const row: Row = { line: i, expect: e, ok: !!hit };
      if (hit) {
        used.add(hit);
        row.got = hit;
        if (e.mustInclude && (hit.ev.type === "speak" || hit.ev.type === "show")) {
          const said = (hit.ev.type === "speak" ? hit.ev.text : hit.ev.canvas.kind === "text" ? hit.ev.canvas.lines.join(" ") : "").replace(/\s+/g, "");
          const found = e.mustInclude.find((x) => said.includes(x.replace(/\s+/g, "")));
          row.ok = !!found;
          row.note = found ? `"${found}" 있음` : `"${e.mustInclude.join(" / ")}" 없음`;
        }
        if (e.needsDoc && (hit.ev.type === "speak" || hit.ev.type === "hand_raise")) {
          const doc = hit.ev.evidence.find((x) => x.docId && x.loc);
          row.ok = !!doc;
          row.note = doc ? `근거: ${doc.label}` : "근거에 자료 위치 없음";
        }
      }
      rows.push(row);
    }
  });
  // 오탐 = 기대에 없는 말·손들기·설정 (부름 대답 포함). 카드(show)·사설은 "추가"로만 센다 (소리 없음).
  // 맞힌 행동과 같은 actionId의 카드(갈등 구조 제안의 비교 카드 등)는 그 행동에 딸린 것이라 뺀다
  const usedIds = new Set([...used].map((g) => ("actionId" in g.ev ? g.ev.actionId : "")).filter(Boolean));
  const extras = acts.filter((g) => !used.has(g) && !("actionId" in g.ev && usedIds.has(g.ev.actionId))).map((g) => ({ line: lineOf(g), got: g, kind: kindOf(g), offense: g.ev.type === "speak" ? g.ev.kind !== "ack" : g.ev.type === "hand_raise" || g.ev.type === "settings" }));

  let checklistOk: boolean | undefined;
  const clExp = rows.find((r) => r.expect.type === "checklist")?.expect;
  if (clExp && end.items) checklistOk = JSON.stringify(end.items.map((x) => x.status)) === JSON.stringify(clExp.statuses);
  const clRow = rows.find((r) => r.expect.type === "checklist");
  if (clRow && checklistOk === false) clRow.ok = false;

  const timeline: string[] = [];
  const evs: { at: number; text: string }[] = [];
  sc.lines.forEach((l, i) => evs.push({ at: sentAt[i], text: `#${i + 1} ${l.speaker}: ${l.text}` }));
  for (const g of got) if (g.ev.type !== "latency") evs.push({ at: g.at, text: `      ${describeEv(g.ev)}` });
  evs.sort((a, b) => a.at - b.at);
  for (const e of evs) timeline.push(`${((e.at - t0) / 1000).toFixed(1).padStart(7)}s  ${e.text}`);
  const speaks = got.filter((g) => g.ev.type === "speak" && g.ev.kind === "conflict").length;
  const dr = got.filter((g) => g.ev.type === "draft");
  const drafts = {
    thinking: dr.filter((g) => g.ev.type === "draft" && g.ev.state === "thinking").length,
    dropped: dr.filter((g) => g.ev.type === "draft" && g.ev.state === "dropped").length,
    leadMs: dr.flatMap((g) => (g.ev.type === "draft" && g.ev.state === "thinking" && sentAt[g.ev.uttId - 1] ? [sentAt[g.ev.uttId - 1] - g.at] : [])),
  };
  return { rows, extras, timeline, snap, end, checklistOk, lineSentAt: sentAt, speaks, drafts, events: got };
}

// ── 지연 표 ───────────────────────────────────────────────
export interface StageRow {
  scenario: string;
  run: number;
  uttId: number;
  kind: string;
  via?: string;
  template?: boolean;
  watch: number; // final → 어긋남 알아챔
  prep: number; // 알아챔 → 대사 준비
  wait: number; // 준비 → 말함(조용해지길 기다림)
  total: number; // final → 말함
  verifyMs?: number;
  lateNo?: boolean;
}

export function stages(name: string, run: number, snap: Snap): StageRow[] {
  return snap.cands
    .filter((c) => c.kind === "conflict" && c.t.delivered && c.t.detect && c.t.ready && c.state !== "cancelled")
    .map((c) => ({
      scenario: name,
      run,
      uttId: c.uttId,
      kind: c.state === "raised" ? "hand_raise" : "speak",
      via: c.t.via,
      template: c.t.template,
      watch: c.t.detect! - c.t.final,
      prep: c.t.ready! - c.t.detect!,
      wait: c.t.delivered! - c.t.ready!,
      total: c.t.delivered! - c.t.final,
      verifyMs: c.t.verifyMs,
      lateNo: c.t.lateNo,
    }));
}

export function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function short(s: string, n = 70) {
  const t = s.replace(/\|/g, "/");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function runSummary(r: RunResult) {
  const hit = r.rows.filter((x) => x.ok).length;
  return { hit, total: r.rows.length, miss: r.rows.length - hit, offense: r.extras.filter((x) => x.offense).length, cards: r.extras.filter((x) => x.got.ev.type === "change_card").length, shows: r.extras.filter((x) => x.got.ev.type === "show").length };
}

// 역할별 MIR(놓침률)·FIR(헛끼어듦률) — When2Speak 정의 (brain-design §5-2).
// 줄 단위: 그 역할 기대가 있는 줄 = 꺼내야 할 때, 없는 줄 = 참아야 할 때. FIR 분자는 기대 없는 줄에서 그 역할로 나온 행동 수
export const ROLE_COLS = ["conflict", "owner_gap", "research", "feedback", "structure", "quiet_member", "suggest"] as const;
export function roleRates(rs: RunResult[], lines: number) {
  const out: Record<string, { expected: number; missed: number; extra: number; quiet: number }> = {};
  for (const role of ROLE_COLS) {
    const x = (out[role] = { expected: 0, missed: 0, extra: 0, quiet: 0 });
    for (const r of rs) {
      const rows = r.rows.filter((y) => y.expect.kind === role && y.expect.type !== "checklist");
      x.expected += rows.length;
      x.missed += rows.filter((y) => !y.ok).length;
      const expLines = new Set(rows.map((y) => y.line));
      x.quiet += lines - expLines.size;
      x.extra += r.extras.filter((y) => y.kind === role && y.got.ev.type !== "change_card").length;
    }
  }
  return out;
}

export function runSection(name: string, k: number, r: RunResult): string[] {
  const s = runSummary(r);
  const out: string[] = [];
  out.push(`### ${name} ${k + 1}회차 — 맞힘 ${s.hit}/${s.total} · 놓침 ${s.miss} · 오탐 ${s.offense} · 추가 카드 ${s.cards}${r.checklistOk === undefined ? "" : ` · 체크리스트 ${r.checklistOk ? "맞음" : "다름"}`} · $${r.snap.cost.toFixed(4)}`, ``);
  if (r.rows.length || r.extras.length) {
    out.push(`| 줄 | 기대 | 결과 |`, `| --- | --- | --- |`);
    for (const x of r.rows) out.push(`| ${x.line + 1} | ${x.expect.type}${x.expect.kind ? " " + x.expect.kind : ""} | ${x.ok ? "맞힘" : "**놓침**"}${x.got ? ": " + short(describeEv(x.got.ev)) : ""}${x.note ? ` (${x.note})` : ""} |`);
    for (const x of r.extras) out.push(`| ${x.line + 1} | (없음) | ${x.offense ? "**오탐**" : "추가"}: ${short(describeEv(x.got.ev))} |`);
    out.push(``);
  }
  const ts = r.snap.templateStats;
  if (ts) out.push(`미리 만든 말: ${ts.cached + ts.made}/${ts.targets}개 (캐시 ${ts.cached} · 새로 ${ts.made}) · 시작 지연 ${ts.ms}ms · $${ts.cost.toFixed(4)}`, ``);
  if (r.end.items?.length) out.push(`끝 체크리스트: ${r.end.items.map((x) => `${x.agenda}·${x.expected}=${x.status}${x.note ? `(${x.note})` : ""}`).join(" / ")}`, ``);
  const dropped = r.snap.cands.filter((c) => c.state === "dropped" || c.state === "cancelled" || c.t.lateNo);
  if (dropped.length) out.push(`버리거나 취소한 후보: ${dropped.map((c) => `#${c.uttId} ${c.state}${c.t.lateNo ? "(말한 뒤 아니라고 함)" : ""} — ${c.note ?? ""}`).join(" / ")}`, ``);
  if (r.snap.errors.length) out.push(`오류: ${r.snap.errors.slice(0, 5).join(" / ")}`, ``);
  return out;
}

export type { Intensity };

// 그 actionId의 이 종류 이벤트가 온 때 (ms)
export function findEv(r: RunResult, actionId: string, type: string): number | undefined {
  return r.events?.find((g) => g.ev.type === type && "actionId" in g.ev && g.ev.actionId === actionId)?.at;
}
