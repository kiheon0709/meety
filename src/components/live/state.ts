// 회의 중 화면의 상태. 음성 서버 이벤트(VoiceEvent)와 두뇌 이벤트(AgentEvent)를 그대로 받아 화면 상태로 바꾼다.
// 목업 재생과 실제 연결이 같은 reducer를 쓴다. 판단은 하지 않는다 (두뇌 몫).
import type { ActionKind, AgentEvent, AgendaItem, CanvasSpec, ChecklistItem, Evidence, Intensity, ModelRole, RoleKind, StartMeetingReq, VoiceEvent } from "@/lib/live/contract";
import { checkCanvas } from "@/components/meety/canvas";

// 계약에 아직 없는 두뇌 이벤트를 화면이 먼저 받는 자리. draft: 말 끝나기 전 partial로 미리 판단한 것 (brain-design §2-7,
// 두뇌 meeting.ts DraftEvent와 같은 꼴 — 계약에 들어가면 여기서 지운다)
export type DraftEvent = { type: "draft"; uttId: number; kind: RoleKind; state: "thinking" | "dropped"; why?: string };
// 능동형 미티 (10/31 기헌 결정, S3 "먼저 꺼내기 루프" — 계약 확정 전 예상 꼴): think = 말하기 전 떠올린 것(소리 없음, 작은 메모),
// backchannel = 맞장구 ("네", "음") — 줄 세우기와 별개로 아주 짧게, 자막 없이
export type ThinkKind = "idea" | "gap" | "todo" | "research" | "question";
export type ThinkEvent = { type: "think"; kind: ThinkKind; text: string; why?: string };
export type BackchannelEvent = { type: "backchannel"; text: string };
export type AgentEventX = AgentEvent | DraftEvent | ThinkEvent | BackchannelEvent;

export type MeetingSetup = StartMeetingReq & { spaceName?: string; controlToken?: string };

export interface Line {
  id: number;
  speaker?: string;
  text: string;
  final: boolean;
  echo?: boolean; // 미티가 말하던 동안 들어온 말 (스피커 소리일 수 있음)
  stable?: number; // 받아쓰는 중(partial)일 때 앞에서 몇 글자가 안정인지 — 그만큼 진하게
}
export interface Speech {
  actionId: string;
  kind: ActionKind;
  sentences: string[];
  evidence: Evidence[];
  index: number; // 지금 읽는 문장
  status: "preparing" | "speaking" | "done" | "cut";
  mark: number; // 말 시작할 때까지 받아 적힌 문장 수. 사람이 두 마디 더 하면 자막을 내린다
  rest?: string[]; // 끊겨서 못 한 문장 (두뇌 cancel.rest) → 화면이 글로 이어쓴다
  cutAt?: number; // 끊긴 때의 finals — "말 끊김"은 끊은 그 말이 받아써질 때까지만 보인다
  why?: string; // 말하기 전 띄워 둔 생각 메모(think) — 왜 카드로 이어진다
  silent?: boolean; // 소리 없이 글자로만 보여 준 말 (사람이 계속 말해서 명령 대답을 소리로 못 냄)
}
export interface Hand {
  actionId: string;
  kind: ActionKind;
  preview: string;
  evidence: Evidence[];
  status: "pending" | "accepted" | "dismissed";
}
// 사설: 호스트 화면에 먼저 뜨고 호스트가 당사자에게만(person)·전체에(all)·버림(drop)
export interface Private {
  actionId: string;
  to: string;
  kind: ActionKind;
  text: string;
  evidence: Evidence[];
  status: "pending" | "person" | "all" | "drop";
}
export interface Card {
  cardId: string;
  title: string;
  from?: string;
  to: string;
  evidence: Evidence[];
}
export interface Toast {
  id: number;
  text: string;
  tone: "agent" | "neutral" | "warn";
}

export type ConnPart = "voice" | "brain" | "mic";
export type ConnStatus = "off" | "connecting" | "on" | "error";

export interface LiveState {
  phase: "live" | "ending" | "ended";
  intensity: Intensity;
  pendingConfirm?: Intensity;
  lines: Line[];
  finals: number;
  talking: boolean;
  queued?: { actionId: string; kind: ActionKind; preview: string; why?: string; evidence?: Evidence[] };
  speech?: Speech;
  said: Speech[];
  hands: Hand[];
  cards: Card[];
  checklist: ChecklistItem[];
  toast?: Toast;
  latency: Partial<Record<ModelRole, number>>;
  sessionId?: string;
  conn: Record<ConnPart, ConnStatus>;
  enrolled: Record<string, { ok: boolean; message?: string; seconds?: number }>;
  canvas?: { actionId: string; spec: CanvasSpec; ttlMs?: number }; // 두뇌가 마지막으로 보낸 캔버스 (show)
  shown: { actionId: string; spec: CanvasSpec }[]; // 미티가 보여 준 것 (다시 열 수 있게)
  privates: Private[];
  budget?: { used: number; limit: number; windowMin: number };
  quiet?: { reason: "time_pressure" | "heated" | "host"; message: string }; // 미티가 스스로 조용히 있는 중
  roles?: Partial<Record<RoleKind, boolean>>;
  budgetPer10Min?: number;
  participation?: number; // 참여도 다이얼 0~10 (두뇌 settings 또는 화면 슬라이더)
  draft?: { uttId: number; why?: string }; // 두뇌가 말 끝나기 전에 "어긋나 보인다"고 미리 생각 중 — 마스코트만 살짝 반응
  think?: { n: number; kind: ThinkKind; text: string; why?: string }; // 미티가 떠올린 것 (말하기 전 메모). n: 새로 떠올릴 때마다 +1
  nods: number; // 맞장구 횟수 — 바뀔 때마다 마스코트가 고개를 끄덕인다
}

export type LiveAction =
  | { src: "voice"; ev: VoiceEvent }
  | { src: "agent"; ev: AgentEventX }
  // 화면 안에서 생기는 일 (소리 재생 진행, 버튼)
  | { src: "ui"; type: "sentence"; actionId: string; index: number }
  | { src: "ui"; type: "spoken"; actionId: string }
  | { src: "ui"; type: "shown"; actionId: string }
  | { src: "ui"; type: "withdrawn"; actionId: string }
  | { src: "ui"; type: "cut"; actionId: string }
  | { src: "ui"; type: "respond"; actionId: string; accept: boolean }
  | { src: "ui"; type: "private_done"; actionId: string; to: "person" | "all" | "drop" }
  | { src: "ui"; type: "participation"; value: number }
  | { src: "ui"; type: "roles"; roles: Partial<Record<RoleKind, boolean>> }
  | { src: "ui"; type: "intensity"; intensity: Intensity; quiet?: boolean }
  | { src: "ui"; type: "ask_confirm"; intensity?: Intensity }
  | { src: "ui"; type: "ending" }
  | { src: "ui"; type: "ended"; sessionId?: string }
  | { src: "ui"; type: "toast"; text: string; tone?: Toast["tone"] }
  | { src: "ui"; type: "clear_toast"; id: number }
  | { src: "ui"; type: "conn"; part: ConnPart; status: ConnStatus };

export const INTENSITY: Record<Intensity, { label: string; line: string }> = {
  high: { label: "상", line: "말이 0.3초만 끊겨도 바로 말해요" },
  mid: { label: "중", line: "0.8초 이상 조용하면 말해요" },
  low: { label: "하", line: "먼저 말하지 않고 화면에 손만 들어요" },
};
export const INTENSITIES: Intensity[] = ["high", "mid", "low"];
const RANK: Record<Intensity, number> = { low: 0, mid: 1, high: 2 };
export const isRaise = (from: Intensity, to: Intensity) => RANK[to] > RANK[from];

export function initState(intensity: Intensity = "mid"): LiveState {
  return { phase: "live", intensity, lines: [], finals: 0, talking: false, said: [], hands: [], cards: [], checklist: [], latency: {}, conn: { voice: "off", brain: "off", mic: "off" }, enrolled: {}, shown: [], privates: [], nods: 0 };
}

let toastSeq = 0;
const toast = (text: string, tone: Toast["tone"] = "neutral"): Toast => ({ id: ++toastSeq, text, tone });

// 문장 단위 자막. 두뇌가 sentences를 비워 보내면 text 하나로.
export const sentencesOf = (ev: { text: string; sentences: string[] }) => (ev.sentences.length ? ev.sentences : [ev.text]);

function upsertLine(lines: Line[], line: Line): Line[] {
  const i = lines.findIndex((l) => l.id === line.id);
  if (i < 0) return [...lines, line].slice(-80);
  const next = lines.slice();
  next[i] = { ...lines[i], ...line, speaker: line.speaker ?? lines[i].speaker };
  return next;
}

function finishSpeech(s: LiveState, status: "done" | "cut"): LiveState {
  if (!s.speech) return s;
  const sp = { ...s.speech, status, ...(status === "cut" ? { cutAt: s.finals } : {}) };
  return { ...s, speech: sp, said: [...s.said.filter((x) => x.actionId !== sp.actionId), sp] };
}
const live = (sp?: Speech) => sp?.status === "speaking" || sp?.status === "preparing";

export function reduce(s: LiveState, a: LiveAction): LiveState {
  if (a.src === "voice") {
    const ev = a.ev;
    switch (ev.type) {
      case "speech_start":
        return { ...s, talking: true };
      case "speech_end":
        return { ...s, talking: false };
      case "partial":
        return { ...s, lines: upsertLine(s.lines, { id: ev.id, text: ev.text, final: false, stable: ev.stable }) };
      case "final":
        if (!ev.text.trim()) return { ...s, lines: s.lines.filter((l) => l.id !== ev.id) };
        return { ...s, finals: s.finals + 1, lines: upsertLine(s.lines, { id: ev.id, text: ev.text, speaker: ev.speaker, final: true, echo: ev.echo }) };
      case "gap":
        return s;
      case "barge_in":
        // 소리는 재생기가 끈다. 여기선 "말 끊김" 표시만
        return live(s.speech) ? { ...finishSpeech(s, "cut"), talking: true } : { ...s, talking: true };
      case "enrolled":
        return { ...s, enrolled: { ...s.enrolled, [ev.name]: { ok: true, seconds: ev.seconds } } };
      case "enroll_error":
        return { ...s, enrolled: { ...s.enrolled, [ev.name]: { ok: false, message: ev.message } } };
    }
    return s;
  }
  if (a.src === "agent") {
    const ev = a.ev;
    switch (ev.type) {
      case "draft":
        if (ev.state === "thinking") return { ...s, draft: { uttId: ev.uttId, why: ev.why } };
        return s.draft?.uttId === ev.uttId ? { ...s, draft: undefined } : s;
      case "think":
        return { ...s, think: { n: (s.think?.n ?? 0) + 1, kind: ev.kind, text: ev.text, why: ev.why } };
      case "backchannel":
        return { ...s, nods: s.nods + 1 };
      case "queued":
        // 떠올려 둔 생각 메모가 있으면 그게 "말하려는 이유"가 된다
        return { ...s, draft: undefined, think: undefined, queued: { actionId: ev.actionId, kind: ev.kind, preview: ev.preview, why: ev.why ?? s.think?.text, evidence: ev.evidence } };
      case "prepare":
        // 미리 굽기만 (클라이언트가 /tts/prefetch). 화면엔 안 띄운다: 두뇌는 회의 시작 때 결정별 대사 템플릿도
        // prepare로 보내서(actionId "templates"), 이걸 "할 말이 있어요"로 띄우면 처음부터 계속 떠 있다. 표시는 queued로만
        return s;
      case "speak": {
        const why = s.queued?.actionId === ev.actionId ? s.queued.why : s.think?.text;
        const sp: Speech = { actionId: ev.actionId, kind: ev.kind, sentences: sentencesOf(ev), evidence: ev.evidence, index: 0, status: "preparing", mark: s.finals, ...(why ? { why } : {}) };
        return { ...s, draft: undefined, think: undefined, queued: undefined, speech: sp, hands: s.hands.map((h) => (h.actionId === ev.actionId ? { ...h, status: "accepted" } : h)) };
      }
      case "hand_raise":
        if (s.hands.some((h) => h.actionId === ev.actionId)) return s;
        return {
          ...s,
          draft: undefined,
          think: undefined,
          queued: s.queued?.actionId === ev.actionId ? undefined : s.queued,
          hands: [...s.hands, { actionId: ev.actionId, kind: ev.kind, preview: ev.preview, evidence: ev.evidence, status: "pending" }],
        };
      case "cancel": {
        let next: LiveState = { ...s, queued: s.queued?.actionId === ev.actionId ? undefined : s.queued };
        if (s.speech?.actionId === ev.actionId && live(s.speech)) next = finishSpeech(next, "cut");
        next.hands = next.hands.map((h) => (h.actionId === ev.actionId && h.status === "pending" ? { ...h, status: "dismissed" } : h));
        if (ev.rest?.length) next.said = next.said.map((x) => (x.actionId === ev.actionId ? { ...x, rest: ev.rest } : x));
        return next;
      }
      case "show": {
        const spec = checkCanvas(ev.canvas);
        if (!spec) return s;
        const c = { actionId: ev.actionId, spec };
        // 찾아보던 것(research)의 결과 카드가 오면 "찾는 중" 끝
        return { ...s, ...(s.think?.kind === "research" ? { think: undefined } : {}), canvas: { ...c, ttlMs: ev.ttlMs }, shown: [...s.shown.filter((x) => x.actionId !== ev.actionId), c].slice(-20) };
      }
      case "private":
        if (s.privates.some((p) => p.actionId === ev.actionId)) return s;
        return { ...s, privates: [...s.privates, { actionId: ev.actionId, to: ev.to, kind: ev.kind, text: ev.text, evidence: ev.evidence, status: "pending" }] };
      case "budget":
        return { ...s, budget: { used: ev.used, limit: ev.limit, windowMin: ev.windowMin } };
      case "mode":
        return { ...s, quiet: ev.quiet ? { reason: ev.reason, message: ev.message } : undefined };
      case "change_card": {
        const card: Card = { cardId: ev.cardId, title: ev.title, from: ev.from, to: ev.to, evidence: ev.evidence };
        if (s.cards.some((c) => c.cardId === ev.cardId)) return { ...s, cards: s.cards.map((c) => (c.cardId === ev.cardId ? card : c)) };
        return { ...s, cards: [...s.cards, card] };
      }
      case "settings": {
        const changed = ev.intensity !== s.intensity;
        const who = ev.by && ev.by !== "screen" ? `${ev.by} 님 말로` : "화면에서";
        return {
          ...s,
          intensity: ev.intensity,
          pendingConfirm: ev.pendingConfirm,
          ...(ev.roles ? { roles: ev.roles } : {}),
          ...(ev.budgetPer10Min !== undefined ? { budgetPer10Min: ev.budgetPer10Min } : {}),
          ...(ev.participation !== undefined ? { participation: ev.participation } : {}),
          toast: changed
            ? toast(`${who} '${INTENSITY[ev.intensity].label}'로 바꿨어요`, "agent")
            : ev.pendingConfirm
              ? toast(`${ev.by ? `${ev.by} 님이 ` : ""}'${INTENSITY[ev.pendingConfirm].label}'로 올리자고 했어요. 화면에서 확인해 주세요`, "warn")
              : s.toast,
        };
      }
      case "checklist":
        // final은 회의 끝 체크리스트. 다른 기기(휴대폰)에서 보던 화면도 끝 화면으로 넘어간다
        return { ...s, checklist: ev.items, phase: ev.final ? "ended" : s.phase };
      case "latency":
        return { ...s, latency: { ...s.latency, [ev.role]: ev.firstTokenMs ?? ev.ms } };
      case "status":
        return ev.state === "ok" ? s : { ...s, toast: toast(`미티: ${ev.message}`, "warn") };
    }
    // 모르는 두뇌 이벤트는 무시한다 (여기서 떨어지면 아래 switch가 undefined를 돌려 화면이 죽었다)
    return s;
  }
  switch (a.type) {
    case "sentence":
      if (s.speech?.actionId !== a.actionId || !live(s.speech)) return s;
      return { ...s, speech: { ...s.speech, index: a.index, status: "speaking" } };
    case "spoken":
      if (s.speech?.actionId !== a.actionId || !live(s.speech)) return s;
      return finishSpeech({ ...s, speech: { ...s.speech, index: s.speech.sentences.length - 1 } }, "done");
    case "withdrawn":
      // 소리 내지 않고 손든 카드로 바꾼 말: 기다리던 말("할 말이 있어요")을 내린다
      return s.speech?.actionId === a.actionId && live(s.speech) ? { ...s, speech: undefined } : s;
    case "shown":
      // 소리 없이 다 보여 준다. 자막을 내리는 셈(mark)은 지금부터 — 기다리는 사이 받아 적힌 말 때문에 바로 사라지지 않게
      if (s.speech?.actionId !== a.actionId || !live(s.speech)) return s;
      return finishSpeech({ ...s, speech: { ...s.speech, index: s.speech.sentences.length - 1, silent: true, mark: s.finals } }, "done");
    case "cut":
      if (s.speech?.actionId !== a.actionId || !live(s.speech)) return s;
      return finishSpeech(s, "cut");
    case "respond":
      return { ...s, hands: s.hands.map((h) => (h.actionId === a.actionId ? { ...h, status: a.accept ? "accepted" : "dismissed" } : h)) };
    case "participation":
      return { ...s, participation: a.value };
    case "roles":
      return { ...s, roles: a.roles };
    case "private_done":
      return { ...s, privates: s.privates.map((p) => (p.actionId === a.actionId ? { ...p, status: a.to } : p)) };
    case "intensity":
      if (a.quiet) return { ...s, intensity: a.intensity };
      return { ...s, intensity: a.intensity, pendingConfirm: undefined, toast: toast(`화면에서 '${INTENSITY[a.intensity].label}'로 바꿨어요`, "agent") };
    case "ask_confirm":
      return { ...s, pendingConfirm: a.intensity };
    case "ending":
      return { ...s, phase: "ending" };
    case "ended":
      return { ...s, phase: "ended", sessionId: a.sessionId ?? s.sessionId };
    case "toast":
      return { ...s, toast: toast(a.text, a.tone) };
    case "clear_toast":
      return s.toast?.id === a.id ? { ...s, toast: undefined } : s;
    case "conn":
      return { ...s, conn: { ...s.conn, [a.part]: a.status } };
  }
  return s;
}

// 미티 표시 상태: 말하는 중 > 할 말이 있음 > 방금 말 끊김 > 손 듦 > 듣는 중
export type MeetyMode = "listening" | "has_something" | "speaking" | "hand_raised" | "cut";
export function meetyMode(s: LiveState): MeetyMode {
  if (s.speech?.status === "speaking") return "speaking";
  if (s.speech?.status === "preparing" || s.queued) return "has_something";
  if (s.speech?.status === "cut" && s.talking && s.finals === s.speech.cutAt) return "cut";
  if (s.hands.some((h) => h.status === "pending")) return "hand_raised";
  return "listening";
}

// 자막을 보여 줄지: 말하는 중이거나, 말이 끝나고 사람이 아직 두 마디 넘게 하지 않았을 때
export const showSpeech = (s: LiveState) => !!s.speech && (live(s.speech) || s.finals - s.speech.mark <= 1);

// 켜졌다 금방 꺼진 표시를 최소 min ms는 보여 준다 (draft "생각 중" 깜빡임 막기). shownAt: 마지막으로 켜진 때
export const heldOn = (active: boolean, shownAt: number | null, now: number, min = 600) => active || (shownAt !== null && now - shownAt < min);

export const pendingHands = (s: LiveState) => s.hands.filter((h) => h.status === "pending");

// 두뇌가 스스로 웹에서 찾는 중이면 그 검색어 (draft why "웹에서 찾는 중 · 검색어", 끝나면 dropped·말로 지워진다)
export const webSearching = (s: LiveState) => /^웹에서 찾는 중\s*·\s*(.+)$/.exec(s.draft?.why ?? "")?.[1];

// 이 화면에 보여 줄 사설: 멤버 기기(me)는 자기 몫만, 호스트(회의실 큰 화면)는 "host" 몫만. 남의 사설은 받았더라도 안 보인다 (security.md ⑪)
export const privatesFor = (s: LiveState, who: { me?: string; host: boolean }) =>
  s.privates.filter((p) => p.status === "pending" && ((!!who.me && p.to === who.me) || (who.host && p.to === "host")));

// 안건 진행: 체크리스트가 오기 전엔 전부 "아직"
export function agendaProgress(agenda: AgendaItem[], checklist: ChecklistItem[]) {
  return agenda.map((a) => ({
    title: a.title,
    items: a.expected.map((e) => {
      const hit = checklist.find((c) => c.agenda === a.title && c.expected === e);
      return { expected: e, status: hit?.status ?? ("open" as const), note: hit?.note };
    }),
  }));
}
