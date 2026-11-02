// 실제 회의 연결의 가운데: 음성 서버(WS)와 두뇌(/api/live, SSE)를 계약대로 이어 준다.
// 브라우저 화면(transport.ts RealTransport)과 노드 시험(scripts/e2e-live.ts)이 같은 코드를 쓴다.
// 마이크·소리 재생·SSE 여는 법만 밖에서 넣어 준다(deps).
import type { AgentEvent, EndMeetingRes, Evidence, Intensity, RoleKind, UtteranceReq, VoiceClientMsg, VoiceEvent } from "@/lib/live/contract";
import type { AgentEventX, ConnPart, ConnStatus, LiveAction } from "./state";
import { sentencesOf } from "./state";

type SpeakEv = Extract<AgentEvent, { type: "speak" }>;

// 소리 한 조각 재생. done은 끝까지 재생했으면 true, 멈췄으면 false
// 소리를 보내는데 이만큼 음성 서버가 아무 말도 없으면(tick도) 멎은 것으로 본다. tick은 5초마다 온다
const VOICE_STALL_MS = 15_000;

// first: 첫 소리가 나갔다(조각 재생만. 없으면 바로), loaded: 소리를 다 받았다(다음 문장 소리는 그때 부탁한다)
export type Clip = { done: Promise<boolean>; stop(): void; first?: Promise<unknown>; loaded?: Promise<unknown> };
export interface AudioOut {
  play(wav: Blob): Clip;
  // 음성 서버 /tts/stream의 PCM16 조각을 오는 대로 재생. 없으면 /tts wav를 통째로 받아 play
  stream?(body: ReadableStream<Uint8Array>, rate: number): Clip;
}
export interface StreamHandlers {
  message(data: string, event?: string): void;
  open(): void;
  error(closed: boolean): void;
}
export interface ClientDeps {
  meetingId: string;
  brain: string; // /api/live 앞부분. 같은 주소면 ""
  voiceUrl: string; // ws://…/ws
  dispatch: (a: LiveAction) => void;
  openStream(url: string, h: StreamHandlers): { close(): void };
  audio: AudioOut;
  fetch?: typeof fetch;
  participants?: string[];
  // 시험·지연 측정용: 무엇을 언제 보냈고 받았는지
  trace?: (kind: string, data?: unknown) => void;
  quietMs?: number; // 사람 말이 멎은 뒤 미티가 말을 시작하기까지 (기본 300)
  quietMaxMs?: number; // 사람 말이 멎기를 기다리는 최대 (기본 8000). 시험이 빨리 돌게
  minLeadMs?: number; // "왜" 카드가 뜬 뒤 첫 소리까지 최소 (기본 600). 녹화를 빨리 돌리는 시험은 같은 비율로 줄인다
  onEnded?: () => void; // 두뇌가 회의를 끝냈을 때 ("오늘은 여기까지" → checklist final) 마이크를 끄라고
  token?: string; // 회의 열쇠 (StartMeetingRes.controlToken). 모든 /api/live/{id}/* 요청에 x-live-token으로
  me?: string; // 이 화면을 보는 사람 (멤버 기기, ?me=). 스트림에 실어 두뇌가 그 사람 몫 사설만 보내게
}

// ws://host:port/ws → http://host:port
export const httpOf = (ws: string) => ws.replace(/^ws/, "http").replace(/\/ws\/?$/, "");

// 미티가 말하던 동안 들어온 final(echo)이 미티 자기 문장과 얼마나 같은지 (글자 두 개씩 겹침, 0~1)
export function overlap(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/[^\p{L}\p{N}]/gu, "");
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return { m, n: Math.max(0, t.length - 1) };
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.n || !B.n) return 0;
  let hit = 0;
  for (const [g, c] of A.m) hit += Math.min(c, B.m.get(g) ?? 0);
  return hit / Math.min(A.n, B.n);
}
// 이만큼 겹치면 사람 말이 아니라 스피커로 나온 미티 소리로 보고 두뇌에 넘기지 않는다
export const ECHO_OVERLAP = 0.5;
// 두 손든 카드 글이 이만큼 겹치면 같은 지적으로 본다 (끊긴 urgent 카드와 두뇌가 든 손)
const SAME_HAND = 0.5;

// wav 길이(초). 헤더의 byteRate로 잰다
export async function wavSeconds(wav: Blob): Promise<number> {
  const b = new DataView(await wav.slice(0, 44).arrayBuffer());
  const byteRate = b.byteLength >= 32 ? b.getUint32(28, true) : 0;
  return byteRate ? Math.max(0, wav.size - 44) / byteRate : 0;
}
// PCM16(little-endian, 모노) 조각들 → wav (AudioContext가 안 열려 조각 재생을 못 할 때 <audio>로)
export function pcmWav(chunks: Uint8Array[], rate: number): Blob {
  const n = chunks.reduce((a, c) => a + c.length, 0) & ~1;
  const h = new DataView(new ArrayBuffer(44));
  const str = (o: number, t: string) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  h.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  str(36, "data");
  h.setUint32(40, n, true);
  return new Blob([h.buffer, ...chunks.map((c) => c.slice().buffer as ArrayBuffer)], { type: "audio/wav" }).slice(0, 44 + n, "audio/wav");
}

// PCM16 조각을 오는 대로 이어 붙여 재생 (S2가 Chrome에서 잰 방식: 새 문장 첫 소리 0.18초).
// 조각마다 BufferSource를 다음 빈자리(at)에 건다. 홀수 바이트로 끝난 조각은 남은 1바이트를 다음 조각 앞에 붙인다
export function playPcm(
  out: { ctx: Pick<BaseAudioContext, "currentTime" | "createBuffer" | "createBufferSource">; node: AudioNode },
  body: ReadableStream<Uint8Array>,
  rate: number,
): Clip {
  const { ctx, node } = out;
  const reader = body.getReader();
  const srcs: AudioBufferSourceNode[] = [];
  let stopped = false;
  let at = 0;
  let left: number | null = null;
  let sounded!: () => void;
  const first = new Promise<void>((r) => (sounded = r));
  let loadedR!: () => void;
  const loaded = new Promise<void>((r) => (loadedR = r));
  let wake: (() => void) | null = null;
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        let b = value;
        if (left !== null) {
          b = new Uint8Array(value.length + 1);
          b[0] = left;
          b.set(value, 1);
          left = null;
        }
        if (b.length & 1) left = b[b.length - 1];
        const n = b.length >> 1;
        if (!n) continue;
        const pcm = new DataView(b.buffer, b.byteOffset, n * 2);
        const buf = ctx.createBuffer(1, n, rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = pcm.getInt16(i * 2, true) / 32768;
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(node);
        at = Math.max(at, ctx.currentTime + 0.02);
        s.start(at);
        at += buf.duration;
        srcs.push(s);
        sounded();
      }
    } catch {
      /* 끊겼으면 받은 데까지만 */
    }
    loadedR();
    sounded();
    if (stopped) return false;
    const rest = at - ctx.currentTime;
    if (rest > 0) await new Promise<void>((r) => ((wake = r), setTimeout(r, rest * 1000)));
    return !stopped;
  })();
  return {
    done,
    first,
    loaded,
    stop: () => {
      stopped = true;
      reader.cancel().catch(() => {});
      for (const s of srcs) {
        try {
          s.stop();
        } catch {
          /* 아직 안 시작했거나 이미 끝남 */
        }
      }
      wake?.();
    },
  };
}

// 소리 없이 그 길이만큼 기다리는 재생기 (보기만 하는 기기, 노드 시험)
export const silentAudio: AudioOut = {
  play(wav) {
    let stop = () => {};
    const done = new Promise<boolean>((resolve) => {
      wavSeconds(wav).then((s) => {
        const t = setTimeout(() => resolve(true), s * 1000);
        stop = () => {
          clearTimeout(t);
          resolve(false);
        };
      });
    });
    return { done, stop: () => stop() };
  },
};

// SSE 한 줄씩 읽기 (노드·시험용. 브라우저는 EventSource를 쓴다)
export function fetchStream(f: typeof fetch) {
  return (url: string, h: StreamHandlers) => {
    const ctl = new AbortController();
    (async () => {
      try {
        const r = await f(url, { headers: { accept: "text/event-stream" }, signal: ctl.signal });
        if (!r.ok || !r.body) return h.error(true);
        h.open();
        const dec = new TextDecoder();
        let buf = "";
        const reader = r.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event: string | undefined;
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (data.length) h.message(data.join("\n"), event);
          }
        }
        h.error(true);
      } catch {
        if (!ctl.signal.aborted) h.error(true);
      }
    })();
    return { close: () => ctl.abort() };
  };
}

// 미티 목소리: 문장마다 음성 서버 POST /tts/stream → 조각이 오는 대로 재생(없는 서버면 /tts wav 통째로). 재생 중엔 음성 서버에 {"type":"tts","on":true}
// 받은 말(speak)은 받은 순서대로 줄 세워 앞 말이 끝나면 다음 말. 새 말이 앞 말을 끊지 않는다.
// 끊는 건 stop(): barge_in·"조용히"·회의 끝(줄 전체), cancel·강도 하(그 말만)
// 문장 하나의 소리: 재생을 시작하는 함수와, 안 틀고 버릴 때(끊김) 받던 소리를 끊는 함수
type Sound = { play(): Clip; drop(): void };
type SayItem = { ev: { actionId: string; kind?: string; text: string; sentences: string[]; urgent?: boolean; evidence?: Evidence[] }; wait?: () => Promise<void | "busy" | "hand">; onStart?: () => void; mute?: boolean; resolve: (r: "done" | "stopped") => void };
// 지금 말 + 기다리는 말이 이보다 많으면 가장 오래 기다린 부름 대답(answer)은 소리 없이 자막(받아쓰기 칸)에만
const MAX_LINE = 3;
class Voice {
  private token = 0;
  private cur: string | null = null;
  private clip: { stop(): void } | null = null;
  private line: SayItem[] = [];
  private running = false;
  private halt: (() => void) | null = null; // 지금 말의 기다림(조용해질 때까지·소리 굽기)을 stop()이 바로 풀게
  kind: string | undefined; // 지금 말의 kind
  urgent = false; // 지금 말이 urgent(확정 어긋남)인가
  private curItem: SayItem | null = null;
  started = false; // 지금 말(cur)의 첫 소리가 나갔나
  private startedAt = 0;
  spoken: { text: string; at: number }[] = []; // 최근에 소리 낸 문장 (echo 거르기)
  constructor(
    private d: ClientDeps,
    private setTts: (on: boolean, text?: string) => void,
  ) {}
  private noStream = false; // 음성 서버에 /tts/stream이 없다(404) → 이 회의 동안 /tts만
  private async sound(text: string): Promise<Sound> {
    const t0 = Date.now();
    const f = this.d.fetch ?? fetch;
    const req = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) };
    const audio = this.d.audio;
    if (audio.stream && !this.noStream) {
      const r = await f(`${httpOf(this.d.voiceUrl)}/tts/stream`, req);
      if (r.status === 404) this.noStream = true;
      else {
        if (!r.ok || !r.body) throw new Error(`tts ${r.status}`);
        const body = r.body;
        const ct = r.headers.get("content-type") ?? "";
        this.d.trace?.("tts_ready", { text, ms: Date.now() - t0, stream: true });
        if (/wav/i.test(ct)) {
          const b = await r.blob();
          return { play: () => audio.play(b), drop() {} };
        }
        const rate = Number(r.headers.get("x-sample-rate")) || Number(/rate=(\d+)/.exec(ct)?.[1]) || 24000;
        return { play: () => audio.stream!(body, rate), drop: () => void body.cancel().catch(() => {}) };
      }
    }
    const r = await f(`${httpOf(this.d.voiceUrl)}/tts`, req);
    if (!r.ok) throw new Error(`tts ${r.status}`);
    const b = await r.blob();
    this.d.trace?.("tts_ready", { text, ms: Date.now() - t0 });
    return { play: () => audio.play(b), drop() {} };
  }
  // 줄에 세운다. 같은 actionId가 지금 말하는 중이거나 줄에 있으면 무시
  play(ev: SayItem["ev"], wait?: () => Promise<void | "busy" | "hand">, onStart?: () => void): Promise<"done" | "stopped"> {
    if (this.cur === ev.actionId || this.line.some((x) => x.ev.actionId === ev.actionId)) return Promise.resolve("stopped");
    return new Promise((resolve) => {
      this.line.push({ ev, wait, onStart, resolve });
      if (this.line.length + (this.cur ? 1 : 0) > MAX_LINE) {
        const old = this.line.find((x) => x.ev.kind === "answer" && !x.mute);
        if (old) {
          old.mute = true;
          this.d.trace?.("muted_in_line", { actionId: old.ev.actionId });
        }
      }
      void this.pump();
    });
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.line.length) {
      const it = this.line.shift()!;
      it.resolve(await this.run(it));
    }
    this.running = false;
  }
  private async run(it: SayItem): Promise<"done" | "stopped"> {
    const { ev } = it;
    const my = ++this.token;
    this.cur = ev.actionId;
    this.kind = ev.kind;
    this.urgent = !!ev.urgent;
    this.curItem = it;
    this.started = false;
    it.onStart?.();
    const ss = sentencesOf(ev);
    if (it.mute) {
      // 소리는 건너뛰고 자막(받아쓰기 칸)에만 남긴다
      this.cur = null;
      this.d.dispatch({ src: "ui", type: "spoken", actionId: ev.actionId });
      return "done";
    }
    const halted = new Promise<"halt">((r) => (this.halt = () => r("halt")));
    const unless = <T,>(p: Promise<T>) => Promise.race([p, halted]);
    const wavs: Promise<Sound>[] = [];
    const want = (i: number) => (wavs[i] ??= this.sound(ss[i]));
    let next = 0; // 아직 틀지 않은 첫 문장 (끊기면 그 뒤로 미리 부탁한 소리는 버린다)
    let on = false;
    try {
      // 소리를 굽는 동안 사람이 말하고 있으면 말이 멎을 때까지 기다린다 (사람 말 위로 말하지 않는다)
      if (it.wait) {
        want(0).catch(() => {});
        const w = await unless(it.wait());
        if (my !== this.token) return "stopped";
        // 끝까지 기다렸는데도 사람이 말하는 중(명령 대답만): 사람 말을 덮지 않고 화면 글자로만 남긴다
        if (w === "busy") {
          this.cur = null;
          this.d.dispatch({ src: "ui", type: "shown", actionId: ev.actionId });
          this.d.trace?.("shown_silent", { actionId: ev.actionId });
          return "done";
        }
        // 먼저 꺼내는 말은 손든 카드로 바꿨다(say가 띄움) — 기다리던 "할 말이 있어요"만 내린다
        if (w === "hand") {
          this.cur = null;
          this.d.dispatch({ src: "ui", type: "withdrawn", actionId: ev.actionId });
          return "done";
        }
      }
      if (this.blipping) await unless(this.blipping); // 맞장구가 나는 중이면 끝나고
      for (let i = 0; i < ss.length; i++) {
        const w = await unless(want(i));
        if (my !== this.token || w === "halt") return "stopped";
        next = i + 1;
        const c = w.play();
        this.clip = c;
        // 다음 문장 소리는 이 문장을 다 받은 뒤에 부탁한다 (같이 만들면 지금 문장 조각이 늦게 온다)
        if (i + 1 < ss.length) void Promise.resolve(c.loaded).then(() => {
            if (my === this.token) want(i + 1).catch(() => {});
          });
        if ((await unless(Promise.resolve(c.first))) === "halt" || my !== this.token) return "stopped";
        // 문장마다 tts on + 그 문장: 음성 서버가 스피커 에코를 미티 목소리와 견줘 거른다
        this.setTts(true, ss[i]);
        if (!on) {
          on = this.started = true;
          this.startedAt = Date.now();
          this.d.trace?.("first_sound", { actionId: ev.actionId });
        }
        this.d.dispatch({ src: "ui", type: "sentence", actionId: ev.actionId, index: i });
        this.spoken.push({ text: ss[i], at: Date.now() });
        const ok = await c.done;
        if (!ok || my !== this.token) return "stopped";
      }
    } catch {
      this.d.dispatch({ src: "ui", type: "toast", text: "미티 목소리를 못 만들었어요. 자막으로만 보여드려요", tone: "warn" });
      for (let i = 0; i < ss.length && my === this.token; i++) {
        this.d.dispatch({ src: "ui", type: "sentence", actionId: ev.actionId, index: i });
        await unless(new Promise((r) => setTimeout(r, Math.max(1300, ss[i].length * 115))));
      }
      if (my !== this.token) return "stopped";
    } finally {
      this.halt = null;
      for (const w of wavs.slice(next)) w?.then((x) => x.drop(), () => {});
      // 끝까지 말했든 실패했든 (멈춘 경우엔 stop()이 이미 껐다)
      if (my === this.token && on) this.setTts(false);
    }
    this.cur = null;
    this.d.dispatch({ src: "ui", type: "spoken", actionId: ev.actionId });
    return "done";
  }
  private stopClip() {
    this.clip?.stop();
    this.clip = null;
  }
  // 끊기면 잃는 urgent 말: 지금 말(urgent면) + 줄에서 기다리는 urgent
  urgents(): SayItem["ev"][] {
    const cur = this.cur && this.urgent ? this.curItem?.ev : null;
    return [...(cur ? [cur] : []), ...this.line.filter((x) => x.ev.urgent).map((x) => x.ev)];
  }
  // 지금 말을 끊는다. all이면 기다리는 줄도 비운다(barge_in·조용히·회의 끝). 끊은 actionId를 돌려준다.
  // keepAcks(barge_in): 줄에서 기다리던, 사람이 시킨 일에 대한 대답(ack)은 버리지 않고 남겨 사람 말이 끝난 뒤 낸다 — 대답이 없으면 안 들은 것처럼 보인다.
  // 지금 말하던 말은 ack여도 다시 하지 않는다 (사람이 앞부분을 들었고, 여는 말도 ack라 회의 중간에 다시 나왔다)
  stop(all = true, keepAcks = false) {
    const was = this.cur;
    if (all) {
      const keep: SayItem[] = [];
      for (const x of this.line.splice(0)) {
        if (keepAcks && x.ev.kind === "ack") keep.push(x);
        else x.resolve("stopped");
      }
      this.line.push(...keep);
      if (keep.length) this.d.trace?.("acks_kept", { actionIds: keep.map((x) => x.ev.actionId) });
    }
    this.token++;
    this.halt?.();
    this.stopClip();
    this.cur = null;
    if (was) this.setTts(false);
    return was;
  }
  // 맞장구("네", "음"): 줄과 따로 아주 짧게. 미티가 말하는 중이거나 기다리는 말이 있으면 안 낸다. 화면 자막도 없다
  private blipping: Promise<unknown> | null = null;
  blip(text: string) {
    if (this.cur || this.line.length || this.blipping) return false;
    const run = (async () => {
      try {
        const w = await this.sound(text);
        if (this.cur || this.line.length) return w.drop(); // 굽는 사이 말할 게 생겼으면 그걸 먼저
        const c = w.play();
        this.clip = c; // barge_in·조용히면 stop()이 같이 끈다
        await c.first;
        this.setTts(true, text);
        this.spoken.push({ text, at: Date.now() });
        await c.done;
        if (this.clip === c) this.clip = null;
        this.setTts(false);
      } catch {
        /* 맞장구는 못 내도 그만 */
      } finally {
        this.blipping = null;
      }
    })();
    this.blipping = run;
    return true;
  }
  // 줄에서 기다리는 말 하나를 뺀다 (cancel). 지금 말하는 중이면 그 말만 끊는다
  drop(actionId: string) {
    if (this.cur === actionId) return this.stop(false);
    const i = this.line.findIndex((x) => x.ev.actionId === actionId);
    if (i >= 0) this.line.splice(i, 1)[0].resolve("stopped");
    return null;
  }
  current() {
    return this.cur;
  }
  // 아직 소리를 안 낸 대답(ack)인가 — 줄에서 기다리거나, 차례가 와 사람 말이 멎기를 기다리는 중 (barge 뒤 남긴 것)
  waitingAck(actionId: string) {
    if (this.cur === actionId) return !this.started && this.kind === "ack";
    return this.line.some((x) => x.ev.actionId === actionId && x.ev.kind === "ack");
  }
  // 지금 말의 첫 소리부터 지금까지. 소리가 아직 안 나갔으면 undefined
  playedMs() {
    return this.cur && this.started ? Date.now() - this.startedAt : undefined;
  }
}

// 사람 말이 멎은 뒤 이만큼 조용해야 미티가 말을 시작한다 (강도 상의 gap 300과 같게)
const QUIET_MS = 300;
const QUIET_MAX_MS = 8000;
const GRACE_MS = 400;
// final.turn(말이 끝났나 확률)이 이만큼이면 말이 끝난 것으로 본다 — 음성 서버도 0.8 이상이면 final을 200ms 만에 낸다
const TURN_END = 0.8;
// "왜" 카드(queued)가 뜬 뒤 첫 소리까지 최소 이만큼 (설계서 §2-2). 두뇌가 speak.leadMs를 주면 그 값. 부르면 답하는 말·짧은 대답은 안 기다린다
const MIN_LEAD_MS = 600; // 두뇌가 설정 명령("끼어들지 마")에 답하는 데 10ms쯤. 너무 길면 빠른 회의에서 미티가 끼어들 틈이 없다

const AGENT_TYPES = ["queued", "prepare", "speak", "hand_raise", "cancel", "change_card", "settings", "checklist", "latency", "status", "show", "private", "budget", "mode", "draft", "think", "backchannel"] as const;
// partial을 두뇌로 넘기는 간격·최소 길이 (brain-design §2-7 — 두뇌는 LIVE_PARTIAL=1·참여도 7 이상일 때만 쓰고 아니면 버린다).
// 두뇌는 안정된 앞부분(stable)만 보니 그게 10자 이상일 때만, 같은 말은 1.5초에 한 번 (말마다 첫 partial은 안정 0이라 안 보낸다)
const PARTIAL_EVERY_MS = 1500;
const PARTIAL_MIN_CHARS = 10;

export class LiveClient {
  private ws: WebSocket | null = null;
  private stream: { close(): void } | null = null;
  private voice: Voice;
  private lastSeg = 0;
  private talking = false;
  private lastSpeechEnd = 0;
  private lastFinalAt = 0;
  private lastTurn: number | undefined; // 마지막 사람 말 final의 turn (말끝 확률)
  private unfinished = new Set<number>(); // 말은 시작됐는데 final이 아직 안 온 것 (사람 말만)
  private alive = true;
  private ttsOn = false;
  // 화자 등록 중엔 받아쓴 말을 두뇌에 넘기지 않는다. 회의를 시작(begin)해야 넘긴다
  forwarding = false;

  constructor(private d: ClientDeps) {
    this.voice = new Voice(d, (on, text) => {
      this.ttsOn = on;
      this.wsSend(text ? { type: "tts", on, text } : { type: "tts", on });
    });
  }
  // 브라우저 fetch는 window에 묶여 있어야 한다 (this.f(...)로 부르면 "Illegal invocation")
  private get f(): typeof fetch {
    const f = this.d.fetch ?? fetch;
    return (input, init) => f(input, init);
  }
  private conn(part: ConnPart, status: ConnStatus) {
    this.d.dispatch({ src: "ui", type: "conn", part, status });
  }

  // 두뇌가 응답하지 않거나 오류여도 회의 화면은 멈추지 않는다: 받아쓰기는 계속, 연결 표시만 빨갛게 + 알림(30초에 한 번)
  private brainWarnAt = 0;
  private brainFail(why: string) {
    this.conn("brain", "error");
    if (Date.now() - this.brainWarnAt > 30_000) {
      this.brainWarnAt = Date.now();
      this.d.dispatch({ src: "ui", type: "toast", text: `미티 두뇌가 응답하지 않아요 (${why}). 받아쓰기는 계속돼요`, tone: "warn" });
    }
  }
  api(path: string, body?: unknown) {
    this.d.trace?.("post", { path, body });
    return this.f(`${this.d.brain}/api/live/${encodeURIComponent(this.d.meetingId)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.d.token ? { "x-live-token": this.d.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) this.brainFail(r.status === 401 ? "회의 열쇠가 안 맞아요" : `${r.status}`);
        else if (this.brainWarnAt) {
          this.brainWarnAt = 0;
          this.conn("brain", "on");
        }
        return r;
      })
      .catch(() => {
        this.brainFail("연결 안 됨");
        return null;
      });
  }
  wsSend(m: VoiceClientMsg) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(m));
      this.d.trace?.("ws_send", m);
    }
  }
  sendPcm(buf: ArrayBuffer | Uint8Array) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(buf);
    const now = Date.now();
    // 소리가 1초 넘게 안 가다가(마이크 허락 기다림, 음성 서버 열고 마이크 켜기 전) 다시 가면 거기서부터 잰다
    if (this.voiceHeardAt && now - this.pcmSentAt > 1000) this.voiceHeardAt = now;
    this.pcmSentAt = now;
    // 소리를 보내는데 VOICE_STALL_MS 넘게 아무 이벤트(tick 포함)가 안 오면 음성 서버가 멎은 것(71분 E2E 43분 지점: 연결은 살았는데 27분간 침묵).
    // 끊으면 onclose가 알리고 다시 붙는다
    if (this.voiceHeardAt && now - this.voiceHeardAt > VOICE_STALL_MS) {
      this.voiceHeardAt = 0;
      this.d.trace?.("voice_stall", { sinceMs: VOICE_STALL_MS });
      this.ws.close();
    }
  }

  onAgent(ev: AgentEventX) {
    this.d.trace?.("agent", ev);
    // 두뇌는 barge 때 가장 최근에 보낸 말을 끊긴 것으로 친다 — 화면이 urgent를 말하던 중이면 그 뒤에 받은 ack를 끊었다고 cancel한다.
    // barge는 화면이 이미 처리했으니(ack는 남김) 그 cancel은 남긴 ack에 안 먹인다 (화면 표시도)
    const keptAck = ev.type === "cancel" && ev.reason === "barge_in" && this.voice.waitingAck(ev.actionId);
    if (keptAck) this.d.trace?.("kept_ack_cancel_ignored", { actionId: ev.actionId });
    // speak는 줄에서 제 차례가 와 말하기 시작할 때 화면에 넘긴다 (자막은 지금 말하는 문장 기준)
    if (ev.type !== "speak" && !keptAck) this.d.dispatch({ src: "agent", ev });
    if (ev.type === "queued") this.queuedAt.set(ev.actionId, Date.now());
    if (ev.type === "prepare" && ev.sentences.length) {
      // 말할 문장을 미리 굽게 한다 (기다리지 않는다)
      void this.f(`${httpOf(this.d.voiceUrl)}/tts/prefetch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: ev.sentences }) }).catch(() => {});
      this.d.trace?.("prefetch", { texts: ev.sentences });
    }
    if (ev.type === "speak") void this.say(ev);
    if (ev.type === "hand_raise") this.brainHand(ev);
    if (ev.type === "cancel" || ev.type === "speak") this.brainHands.delete(ev.actionId);
    if (ev.type === "backchannel" && this.forwarding && this.voice.blip(ev.text)) this.d.trace?.("backchannel", { text: ev.text });
    if (ev.type === "cancel" && !keptAck) this.voice.drop(ev.actionId);
    // 두뇌가 말로 회의를 끝냄("오늘은 여기까지") → 더 듣지도 넘기지도 않는다
    if (ev.type === "checklist" && ev.final && this.alive) {
      this.forwarding = false;
      this.alive = false;
      this.voice.stop();
      this.ws?.close();
      this.d.onEnded?.();
    }
    // 아직 소리를 안 낸 지적이 기다리는 중에 "끼어들지 마"(하)가 오면 말하지 않는다. 그보다 먼저 받은 urgent(확정 어긋남)는 그대로 말한다
    if (ev.type === "settings" && ev.intensity === "low" && this.voice.current() && !this.voice.started && this.voice.kind !== "ack" && this.voice.kind !== "answer" && !this.voice.urgent) {
      const id = this.voice.stop(false)!;
      this.d.dispatch({ src: "agent", ev: { type: "cancel", actionId: id, reason: "stale" } });
      this.d.trace?.("dropped_after_low", { actionId: id });
    }
  }
  private partialAt = new Map<number, number>(); // 말 id → 마지막으로 partial을 넘긴 때
  private queuedAt = new Map<string, number>();
  say(ev: SpeakEv | { actionId: string; text: string; sentences: string[] }) {
    const urgent = "urgent" in ev && !!ev.urgent;
    const until = Date.now() + (urgent ? 0 : this.leadWait(ev));
    return this.voice.play(
      ev,
      async () => {
        const lead = until - Date.now();
        if (lead > 0) await new Promise((r) => setTimeout(r, lead));
        const ok = await this.quiet(urgent);
        // 기다림이 끝났는데 사람이 아직 말하면 사람 말을 덮지 않는다 (관리 10/31): 명령 대답(ack)은 화면 글자로만,
        // 먼저 꺼내는 말(suggest·여는 질문·어긋남 등)은 손든 카드로. 부르면 답하는 말(answer)과 urgent는 지금처럼 소리로
        // (시나리오 A2 4판: 여는 질문이 준영 말 위로 나가 그 말이 echo로 찍혀 두뇌가 어긋남 판단을 안 했다)
        if (ok || urgent || !("kind" in ev) || !(this.talking || this.unfinished.size > 0)) return;
        if (ev.kind === "ack") return "busy" as const;
        if (ev.kind !== "answer") {
          this.toHand(ev);
          return "hand" as const;
        }
      },
      "type" in ev ? () => this.d.dispatch({ src: "agent", ev }) : undefined,
    );
  }
  // 카드가 뜬 때(queued, 없으면 speak 받은 때)부터 lead만큼은 소리를 늦춘다
  private leadWait(ev: { actionId: string; kind?: string; leadMs?: number }) {
    if (ev.kind === "answer" || ev.kind === "ack") return 0;
    const shown = this.queuedAt.get(ev.actionId);
    this.queuedAt.delete(ev.actionId);
    const lead = ev.leadMs ?? (shown ? (this.d.minLeadMs ?? MIN_LEAD_MS) : 0);
    return Math.max(0, (shown ?? Date.now()) + lead - Date.now());
  }
  // 누가 말하는 중이면 말이 멎고 QUIET_MS 조용할 때까지 (최대 QUIET_MAX_MS) 기다린다.
  // 두뇌는 사람이 다시 말하기 시작한 걸 모른다(speech_start는 두뇌로 안 간다) → 화면이 지킨다
  // 기다리는 사이 누가 말했으면, 그 말이 받아써져 두뇌에 간 뒤 GRACE_MS 더 기다린다 (두뇌가 취소하거나 강도를 바꿀 틈)
  // urgent(확정 어긋남)는 그 틈을 안 기다린다: 아무도 말하지 않고 final까지 온 첫 틈 — 말끝 확률(final.turn)이 높으면 바로, 아니면 QUIET_MS 조용하면.
  // 회의에선 다음 사람이 final 0.2초 뒤에 말을 이어서 보통 기다림으론 끝내 못 말했다 (시나리오 A, S3 분석)
  // 조용해졌으면 true, QUIET_MAX_MS를 다 기다렸으면 false
  private quiet(urgent = false): Promise<boolean> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const q = this.d.quietMs ?? QUIET_MS;
        const heard = this.lastFinalAt > t0 || this.unfinished.size > 0;
        const free = !this.talking && this.unfinished.size === 0;
        const ok = urgent
          ? free && (Date.now() - this.lastSpeechEnd >= q || (this.lastTurn ?? 0) >= TURN_END)
          : free && Date.now() - this.lastSpeechEnd >= q && (!heard || Date.now() - this.lastFinalAt >= (q / QUIET_MS) * GRACE_MS);
        if (ok || Date.now() - t0 > (this.d.quietMaxMs ?? QUIET_MAX_MS)) {
          if (!ok) this.d.trace?.("quiet_timeout", {});
          else if (Date.now() - t0 > 50) this.d.trace?.("waited_quiet", { ms: Date.now() - t0 });
          return resolve(ok);
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  onVoice(ev: VoiceEvent) {
    this.d.trace?.("voice", ev);
    if (ev.type === "tick") return; // 심장박동: 받은 때만 적어 둔다 (onmessage)
    // playedMs: 두뇌가 짧게(2초 미만) 끊긴 말은 다음 침묵에 다시 말한다. cutId: 그때 실제로 소리 내던 말 (두뇌는 이걸 끊긴 말로 친다)
    const played = ev.type === "barge_in" ? this.voice.playedMs() : undefined;
    const cutId = played !== undefined ? this.voice.current() : null;
    if (ev.type === "barge_in") {
      const lost = this.voice.urgents();
      this.voice.stop(true, true); // 소리부터 끈다 (명령에 대한 대답은 사람 말이 끝난 뒤로)
      // 끼어든 사람이 말하는 중이다: 미티 소리 중이라 speech_start는 사람 말로 안 쳤으니 여기서 센다 (남긴 대답이 그 말 위로 나가지 않게)
      this.talking = true;
      this.unfinished.add(ev.id);
      for (const u of lost) this.toHand(u as SpeakEv);
    }
    if (ev.type === "speech_start") {
      this.lastSeg = ev.id;
      // 미티 자기 소리일 수도 있는 말(tts 중)은 사람 말로 치지 않는다: 그건 barge_in이 따로 온다
      if (!this.ttsOn) {
        this.talking = true;
        this.unfinished.add(ev.id);
      }
    }
    if (ev.type === "final") {
      if (this.unfinished.delete(ev.id) && ev.text.trim()) {
        this.lastFinalAt = Date.now();
        this.lastTurn = ev.turn;
      }
    }
    // 받아쓰는 중인 말을 두뇌가 미리 볼 수 있게 (미티가 말하는 중엔 안 보냄 — 그때 partial은 미티 목소리일 수 있다)
    if (ev.type === "partial" && this.forwarding && !this.ttsOn && (ev.stable ?? 0) >= PARTIAL_MIN_CHARS && Date.now() - (this.partialAt.get(ev.id) ?? 0) >= PARTIAL_EVERY_MS) {
      this.partialAt.set(ev.id, Date.now());
      void this.api("partial", { id: ev.id, text: ev.text, ...(ev.stable !== undefined ? { stable: ev.stable } : {}) });
    }
    if (ev.type === "speech_end") {
      this.talking = false;
      this.lastSpeechEnd = Date.now();
    }
    if (ev.type === "final" && ev.echo && this.isOwnEcho(ev.text)) {
      // 스피커로 나간 미티 소리가 다시 들어온 것: 화면엔 흐리게, 두뇌엔 안 넘긴다
      this.d.dispatch({ src: "voice", ev });
      this.d.trace?.("echo_dropped", { id: ev.id, text: ev.text });
      return;
    }
    this.d.dispatch({ src: "voice", ev });
    if (!this.forwarding) return;
    if (ev.type === "final" && ev.text.trim()) {
      const body: UtteranceReq = { id: ev.id, t0: ev.t0, t1: ev.t1, text: ev.text, speaker: ev.speaker, ...(ev.echo ? { echo: true } : {}), ...(ev.barge ? { barge: ev.barge } : {}) };
      void this.api("utterance", body);
    }
    if (ev.type === "gap") void this.api("gap", { after_id: ev.after_id, ms: ev.ms });
    if (ev.type === "barge_in") void this.api("barge", { id: ev.id, ...(played !== undefined ? { playedMs: played } : {}), ...(cutId ? { actionId: cutId } : {}) });
  }
  private isOwnEcho(text: string) {
    const recent = this.voice.spoken.filter((s) => Date.now() - s.at < 30_000);
    return recent.some((s) => overlap(text, s.text) >= ECHO_OVERLAP);
  }

  connectStream() {
    // ?prepare=1: 단계 1 두뇌는 이걸 붙여야 prepare를 보냈다 (지금 두뇌는 늘 보냄). EventSource는 헤더를 못 붙여 열쇠는 ?token=
    const q = new URLSearchParams({ prepare: "1", ...(this.d.token ? { token: this.d.token } : {}), ...(this.d.me ? { me: this.d.me } : {}) });
    this.stream = this.d.openStream(`${this.d.brain}/api/live/${encodeURIComponent(this.d.meetingId)}/stream?${q}`, {
      message: (data, event) => {
        try {
          const j = JSON.parse(data);
          // 이름 붙은 이벤트(event: speak)든 data 안 type이든 받는다
          const ev = event && AGENT_TYPES.includes(event as (typeof AGENT_TYPES)[number]) && !j.type ? { ...j, type: event } : j;
          if (ev?.type) this.onAgent(ev);
        } catch {
          /* 깨진 줄은 버린다 */
        }
      },
      open: () => this.conn("brain", "on"),
      error: (closed) => this.conn("brain", closed ? "error" : "connecting"),
    });
  }

  private save = false;
  private voiceRetry = 0; // 끊긴 뒤 다시 붙으려 한 횟수
  private voiceHeardAt = 0; // 음성 서버에서 마지막 메시지가 온 때 (멎음 감지)
  private pcmSentAt = 0; // 마지막으로 소리를 보낸 때
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  connectVoice(save = this.save): Promise<void> {
    this.save = save;
    return new Promise((resolve) => {
      this.conn("voice", "connecting");
      const ws = new WebSocket(this.d.voiceUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.voiceHeardAt = Date.now();
        // 받아쓰기 힌트: 참석자 이름 (음성 서버가 "회의 참석자는 …, 그리고 AI 팀원 미티." 문장으로 만든다)
        this.wsSend({ type: "start", prompt: (this.d.participants ?? []).join(", "), save: this.save });
        this.conn("voice", "on");
        if (this.voiceRetry > 0) this.d.dispatch({ src: "ui", type: "toast", text: "받아쓰기에 다시 붙었어요", tone: "agent" });
        this.voiceRetry = 0;
        resolve();
      };
      ws.onmessage = (m) => {
        this.voiceHeardAt = Date.now();
        if (typeof m.data !== "string") return;
        try {
          this.onVoice(JSON.parse(m.data));
        } catch {
          /* 무시 */
        }
      };
      ws.onerror = () => {
        this.conn("voice", "error");
        resolve();
      };
      ws.onclose = () => {
        if (!this.alive || this.ws !== ws) return;
        // 음성 서버가 죽거나 재시작됨 → 화면에 알리고 다시 붙는다 (1, 2, 4 … 최대 10초 간격)
        this.conn("voice", "error");
        if (opened || this.voiceRetry === 0)
          this.d.dispatch({ src: "ui", type: "toast", text: "받아쓰기 연결이 끊겼어요. 다시 붙는 중이에요 — 그동안 한 말은 안 적혀요", tone: "warn" });
        this.voiceStop();
        const wait = Math.min(10_000, 1000 * 2 ** this.voiceRetry++);
        this.reconnectTimer = setTimeout(() => {
          if (this.alive) void this.connectVoice();
        }, wait);
      };
    });
  }
  private voiceStop() {
    // 말하던 중 끊겼으면 소리도 끈다 (tts on/off를 받을 서버가 없다)
    if (this.voice.current()) this.voice.stop();
  }

  // 녹음 저장 동의는 회의 시작 때 정해진다. start를 다시 보내면 음성 서버가 그때부터 저장한다
  begin(opts: { save: boolean; announce?: string }) {
    this.forwarding = true;
    if (opts.save) this.wsSend({ type: "start", prompt: (this.d.participants ?? []).join(", "), save: true });
    // 여는 말도 화면엔 "말하는 중"으로 (두뇌가 먼저 꺼내는 첫말은 그 뒤에 줄 선다 — 시작 화면 → 말하는 중이 끊김 없이)
    if (opts.announce) void this.say({ type: "speak", actionId: "announce", kind: "ack", text: opts.announce, sentences: [opts.announce], evidence: [] });
  }
  // replace: 이미 등록된 이름을 다시 등록 (화면에서 확인받은 경우만. 계약 밖 추가분, 음성 서버가 요구)
  enroll(name: string | null, replace = false) {
    this.wsSend(replace && name ? ({ type: "enroll", name, replace: true } as VoiceClientMsg) : { type: "enroll", name });
  }

  respond(actionId: string, accept: boolean) {
    this.d.dispatch({ src: "ui", type: "respond", actionId, accept });
    const own = this.ownHands.get(actionId);
    this.ownHands.delete(actionId);
    this.brainHands.delete(actionId);
    // 화면이 든 손(끊긴 urgent)은 두뇌가 모르는 손이라(두뇌엔 이미 말한 것) 화면이 직접 다시 말한다
    if (own) {
      if (accept) void this.say({ ...own, urgent: undefined, leadMs: undefined });
      return;
    }
    void this.api("respond", { actionId, accept });
  }

  // 손든 카드로 남긴다: 끊긴 urgent(확정 어긋남), 기다림이 끝나도 사람이 말하는 중이라 못 낸 먼저 꺼내는 말 — 사람 말을 소리로 덮지 않는다.
  // 두뇌가 같은 지적으로 이미 손을 들었으면(예: "끼어들지 마" 때 방금 한 어긋남을 손으로 남김) 하나 더 띄우지 않는다
  private brainHands = new Map<string, { kind: string; preview: string }>(); // 두뇌가 들고 아직 정하지 않은 손
  private ownHands = new Map<string, SpeakEv>(); // 끊긴 urgent로 화면이 든 손
  private sameHand = (a: { kind?: string; preview: string }, b: { kind?: string; preview: string }) => a.kind === b.kind && overlap(a.preview, b.preview) >= SAME_HAND;
  private toHand(u: SpeakEv) {
    if ([...this.brainHands.values()].some((h) => this.sameHand(h, { kind: u.kind, preview: u.text }))) return this.d.trace?.("urgent_hand_dup", { actionId: u.actionId });
    this.ownHands.set(u.actionId, u);
    this.d.dispatch({ src: "agent", ev: { type: "hand_raise", actionId: u.actionId, kind: u.kind, preview: u.text, evidence: u.evidence } });
    this.d.trace?.("to_hand", { actionId: u.actionId });
  }
  // 두뇌가 손을 들었는데 화면이 먼저 든 손과 같은 지적이면 화면 쪽을 내린다 (두뇌 손이라야 "말해줘"가 두뇌로 간다)
  private brainHand(ev: Extract<AgentEvent, { type: "hand_raise" }>) {
    this.brainHands.set(ev.actionId, { kind: ev.kind, preview: ev.preview });
    for (const [id, u] of this.ownHands) {
      if (!this.sameHand({ kind: u.kind, preview: u.text }, ev)) continue;
      this.ownHands.delete(id);
      this.d.dispatch({ src: "agent", ev: { type: "cancel", actionId: id, reason: "stale" } });
    }
  }
  // 호스트가 사설(private)을 당사자에게만·전체에·버림 (POST /private — 두뇌가 아직 없으면 사설 이벤트도 안 오니 이 버튼도 안 보인다)
  privateTo(actionId: string, to: "person" | "all" | "drop") {
    this.d.dispatch({ src: "ui", type: "private_done", actionId, to });
    void this.api("private", { actionId, to });
  }
  // 참여도 다이얼: 호스트가 화면에서 직접 움직인 것이라 확인 단계 없이(confirmed). 강도는 지금 값 그대로 보낸다
  participation(value: number, intensity: Intensity) {
    this.d.dispatch({ src: "ui", type: "participation", value });
    void this.api("settings", { intensity, confirmed: true, participation: value });
  }
  // 역할 켜기/끄기 (호스트 화면). 7개를 다 실어 보낸다
  roles(roles: Partial<Record<RoleKind, boolean>>, intensity: Intensity) {
    this.d.dispatch({ src: "ui", type: "roles", roles });
    void this.api("settings", { intensity, confirmed: true, roles });
  }
  settings(intensity: Intensity, confirmed: boolean) {
    this.d.dispatch({ src: "ui", type: "intensity", intensity });
    void this.api("settings", { intensity, confirmed });
  }
  interrupt() {
    const played = this.voice.playedMs();
    const cur = this.voice.stop();
    if (!cur) return;
    this.d.dispatch({ src: "ui", type: "cut", actionId: cur });
    void this.api("barge", { id: this.lastSeg, actionId: cur, ...(played !== undefined ? { playedMs: played } : {}) });
  }
  isSpeaking() {
    return this.ttsOn;
  }
  async end(): Promise<EndMeetingRes> {
    this.voice.stop();
    this.forwarding = false;
    this.alive = false; // 일부러 닫는 것: 연결 표시를 빨갛게 하지 않는다
    this.ws?.close();
    this.d.dispatch({ src: "ui", type: "ending" });
    const r = await this.api("end");
    let res: EndMeetingRes = {};
    try {
      res = r?.ok ? ((await r.json()) as EndMeetingRes) : {};
    } catch {
      /* 본문 없음 */
    }
    if (Array.isArray(res.items)) this.d.dispatch({ src: "agent", ev: { type: "checklist", items: res.items, final: true } });
    this.d.dispatch({ src: "ui", type: "ended", sessionId: res.sessionId });
    // 체크리스트가 SSE로 늦게 올 수 있어 스트림은 조금 더 연다
    setTimeout(() => this.close(), 8000);
    return res;
  }
  close() {
    this.alive = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.voice.stop();
    this.ws?.close();
    this.stream?.close();
  }
}
