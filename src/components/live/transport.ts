// 화면이 바깥과 주고받는 길 두 가지. 둘 다 같은 reducer에 이벤트를 넣는다.
//   MockTransport: 목업 대본을 시간순으로 재생 (?mock=A|B)
//   RealTransport: 계약대로 음성 서버(WS)·두뇌(/api/live, SSE)에 연결
import type { AgentEvent, Intensity, RoleKind, VoiceEvent } from "@/lib/live/contract";
import type { AgentEventX, LiveAction, MeetingSetup } from "./state";
import { LiveClient, httpOf, pcmWav, playPcm, silentAudio, type AudioOut } from "./client";
import { sentencesOf } from "./state";
import type { MockScenario } from "./mock";
import { attachMic, attachTts, detachMic, ttsOut } from "@/components/meety/levels";

type Dispatch = (a: LiveAction) => void;
type SpeakEv = Extract<AgentEvent, { type: "speak" }>;

export interface Transport {
  start(): Promise<void>;
  stop(): void;
  respond(actionId: string, accept: boolean): void;
  settings(intensity: Intensity, confirmed: boolean): void;
  interrupt(): void; // 화면에서 [말 끊기]
  privateTo?(actionId: string, to: "person" | "all" | "drop"): void; // 호스트의 사설 승인
  participation?(value: number, intensity: Intensity): void; // 참여도 다이얼
  roles?(roles: Partial<Record<RoleKind, boolean>>, intensity: Intensity): void; // 역할 켜기/끄기
  end(): Promise<void>;
  // 목업만
  togglePause?(): boolean;
  // 실제만: 화자 등록, 회의 시작(두뇌로 넘기기 시작)
  enroll?(name: string | null, replace?: boolean): void;
  begin?(opts: { save: boolean; announce?: string }): void;
}

// ── 목업 목소리 ────────────────────────────────────────────────
interface Voice {
  play(ev: SpeakEv): Promise<"done" | "stopped">;
  stop(): void;
  current(): string | null;
}

// 목업 목소리: 소리 없이 글자 수만큼 시간을 보낸다 (한국어 TTS 대략 초당 8~9자)
class MockVoice implements Voice {
  private token = 0;
  private cur: string | null = null;
  constructor(
    private dispatch: Dispatch,
    private sleep: (ms: number) => Promise<boolean>,
  ) {}
  async play(ev: SpeakEv) {
    const my = ++this.token;
    this.cur = ev.actionId;
    const ss = sentencesOf(ev);
    // 목소리 만드는 시간
    if (!(await this.sleep(550)) || my !== this.token) return "stopped";
    for (let i = 0; i < ss.length; i++) {
      this.dispatch({ src: "ui", type: "sentence", actionId: ev.actionId, index: i });
      if (!(await this.sleep(Math.max(1300, ss[i].length * 115))) || my !== this.token) return "stopped";
    }
    this.cur = null;
    this.dispatch({ src: "ui", type: "spoken", actionId: ev.actionId });
    return "done";
  }
  stop() {
    this.token++;
    this.cur = null;
  }
  current() {
    return this.cur;
  }
}

// ── 목업 재생 ─────────────────────────────────────────────────
export class MockTransport implements Transport {
  private alive = true;
  private paused = false;
  private voice: MockVoice;
  private segId = 0;
  constructor(
    private sc: MockScenario,
    private dispatch: Dispatch,
    private opts: { speed: number; barge: boolean },
  ) {
    this.voice = new MockVoice(dispatch, (ms) => this.sleep(ms));
  }

  // 일시정지를 지키는 잠. 멈춘(stop) 뒤엔 false
  private sleep = (ms: number) =>
    new Promise<boolean>((resolve) => {
      let left = ms / this.opts.speed;
      const tick = (step: number) => {
        if (!this.alive) return resolve(false);
        if (!this.paused) left -= step;
        if (left <= 0) return resolve(true);
        const next = Math.min(50, left);
        setTimeout(() => tick(next), next);
      };
      tick(0);
    });

  private voiceEv(ev: VoiceEvent) {
    this.dispatch({ src: "voice", ev });
  }
  private agent(ev: AgentEventX) {
    this.dispatch({ src: "agent", ev });
  }

  private async say(speaker: string, text: string) {
    const id = ++this.segId;
    const dur = Math.max(900, text.length * 95);
    this.voiceEv({ type: "speech_start", id, t: 0 });
    // 말하는 동안 중간 받아쓰기가 조금씩 늘어난다
    const words = text.split(" ");
    const steps = Math.max(1, Math.floor(dur / 700));
    for (let k = 1; k <= steps; k++) {
      if (!(await this.sleep(dur / (steps + 1)))) return;
      this.voiceEv({ type: "partial", id, text: words.slice(0, Math.ceil((words.length * k) / (steps + 1))).join(" ") });
    }
    if (!(await this.sleep(dur / (steps + 1)))) return;
    this.voiceEv({ type: "speech_end", id, t0: 0, t1: dur / 1000 });
    if (!(await this.sleep(280))) return;
    this.voiceEv({ type: "final", id, t0: 0, t1: dur / 1000, text, speaker });
  }

  private async speak(ev: SpeakEv, bargeAfterMs?: number) {
    this.agent(ev);
    if (bargeAfterMs == null) {
      await this.voice.play(ev);
      return;
    }
    const playing = this.voice.play(ev);
    if (!(await this.sleep(bargeAfterMs))) return;
    if (this.voice.current() === ev.actionId) {
      // 사람이 말을 시작 → 음성 서버가 barge_in → 화면이 소리를 끄고 두뇌에 알림 → 두뇌가 cancel
      this.voiceEv({ type: "barge_in", id: this.segId + 1, t: 0 });
      this.voice.stop();
      this.agent({ type: "cancel", actionId: ev.actionId, reason: "barge_in" });
    }
    await playing;
  }

  async start() {
    const steps = this.sc.steps;
    let firstConflict = true;
    for (const st of steps) {
      if (!this.alive) return;
      if ("wait" in st) await this.sleep(st.wait);
      else if ("say" in st) await this.say(st.say.speaker, st.say.text);
      else if ("voice" in st) this.voiceEv(st.voice);
      else if ("gap" in st) {
        for (const ms of [300, 800, 1500] as const) {
          if (ms > st.gap) break;
          if (!(await this.sleep(ms === 300 ? 300 : ms === 800 ? 500 : 700))) return;
          this.voiceEv({ type: "gap", after_id: this.segId, ms });
        }
      } else if ("agent" in st) this.agent(st.agent);
      else if ("speak" in st) {
        // &barge=1: 첫 번째 어긋남 지적을 사람이 두 번째 문장에서 끊는다
        const barge = this.opts.barge && firstConflict && st.speak.kind === "conflict" ? 4200 : st.bargeAfterMs;
        if (st.speak.kind === "conflict") firstConflict = false;
        await this.speak(st.speak, barge);
      } else if ("end" in st) await this.end();
    }
  }
  stop() {
    this.alive = false;
    this.voice.stop();
  }
  togglePause() {
    this.paused = !this.paused;
    return this.paused;
  }
  privateTo(actionId: string, to: "person" | "all" | "drop") {
    this.dispatch({ src: "ui", type: "private_done", actionId, to });
  }
  participation(value: number) {
    this.dispatch({ src: "ui", type: "participation", value });
  }
  roles(roles: Partial<Record<RoleKind, boolean>>) {
    this.dispatch({ src: "ui", type: "roles", roles });
  }
  respond(actionId: string, accept: boolean) {
    this.dispatch({ src: "ui", type: "respond", actionId, accept });
    if (!accept) {
      this.agent({ type: "cancel", actionId, reason: "dismissed" });
      return;
    }
    const ev = this.sc.onAccept[actionId];
    if (!ev) return;
    void this.sleep(400).then((ok) => {
      if (!ok) return;
      this.agent(ev);
      void this.voice.play(ev);
    });
  }
  settings(intensity: Intensity) {
    this.dispatch({ src: "ui", type: "intensity", intensity });
  }
  interrupt() {
    const cur = this.voice.current();
    if (!cur) return;
    this.voice.stop();
    this.agent({ type: "cancel", actionId: cur, reason: "barge_in" });
  }
  async end() {
    this.voice.stop();
    this.dispatch({ src: "ui", type: "ending" });
    await this.sleep(1400);
    this.agent(this.sc.final);
    this.dispatch({ src: "ui", type: "ended" });
    this.alive = false;
  }
}

// ── 실제 연결 (브라우저) ────────────────────────────────────────
// 음성 서버 주소: NEXT_PUBLIC_VOICE_URL이 있으면 그것, 없으면 지금 연 주소의 호스트 + NEXT_PUBLIC_VOICE_PORT(기본 8765).
// 휴대폰에서 노트북 주소로 열어도 음성 서버를 노트북에서 찾게 한다.
export function voiceUrl(): string {
  if (process.env.NEXT_PUBLIC_VOICE_URL) return process.env.NEXT_PUBLIC_VOICE_URL;
  // localhost는 IPv6(::1)로 먼저 가는데 음성 서버는 IPv4(0.0.0.0)로 떠 있어서 127.0.0.1로 바꾼다
  const h = typeof location !== "undefined" ? location.hostname : "localhost";
  const host = h === "localhost" ? "127.0.0.1" : h;
  return `ws://${host}:${process.env.NEXT_PUBLIC_VOICE_PORT || 8765}/ws`;
}

// 마이크 → 16kHz mono int16 PCM. 브라우저 표본율이 달라서 워크릿 안에서 평균 내어 줄인다.
// 0.064초(1024표본)마다 보낸다: 음성 서버가 gap을 제때 내려면 100ms 이하 묶음이 좋다 (S2 보고서)
export const PCM_FRAME = 1024;
const PCM_WORKLET = `
class Pcm16k extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.sum = 0; this.cnt = 0; this.buf = new Int16Array(${PCM_FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.cnt));
        this.sum = 0; this.cnt = 0;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0).buffer, []); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("pcm16k", Pcm16k);
`;

const browserAudio: AudioOut = {
  play(wav) {
    const url = URL.createObjectURL(wav);
    const a = new Audio(url);
    attachTts(a); // 미티 입 움직임용 크기 (못 붙이면 그냥 재생)
    const done = new Promise<boolean>((resolve) => {
      a.onended = () => resolve(true);
      a.onerror = () => resolve(true);
      a.onpause = () => resolve(a.ended);
      a.play().catch(() => resolve(true));
    }).finally(() => URL.revokeObjectURL(url));
    return {
      done,
      stop: () => {
        a.pause();
        a.removeAttribute("src");
      },
    };
  },
  stream(body, rate) {
    const out = ttsOut();
    if (out) return playPcm(out, body, rate);
    // AudioContext가 아직 안 열렸으면 조각을 다 받아 wav로 (첫 소리는 늦지만 소리는 난다)
    let inner: ReturnType<AudioOut["play"]> | null = null;
    let stopped = false;
    const reader = body.getReader();
    const loaded = (async () => {
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return chunks;
    })().catch(() => [] as Uint8Array[]);
    const done = loaded.then((chunks) => {
      if (stopped) return false;
      inner = browserAudio.play(pcmWav(chunks, rate));
      return inner.done;
    });
    return {
      done,
      loaded,
      stop: () => {
        stopped = true;
        reader.cancel().catch(() => {});
        inner?.stop();
      },
    };
  },
};

const AGENT_EVENT_NAMES = ["queued", "prepare", "speak", "hand_raise", "cancel", "change_card", "settings", "checklist", "latency", "status", "show", "private", "budget", "mode", "draft", "think", "backchannel"];
function eventSource(url: string, h: { message(d: string, e?: string): void; open(): void; error(closed: boolean): void }) {
  const es = new EventSource(url);
  es.onmessage = (m) => h.message(m.data);
  for (const t of AGENT_EVENT_NAMES) es.addEventListener(t, ((m: MessageEvent) => h.message(m.data, t)) as EventListener);
  es.onopen = () => h.open();
  es.onerror = () => h.error(es.readyState === EventSource.CLOSED);
  return es;
}

export class RealTransport implements Transport {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  readonly client: LiveClient;

  // viewer: 다른 기기(휴대폰)에서 화면으로만 보기. 마이크·음성 서버 없이 두뇌 이벤트만 받고 소리는 안 낸다
  // opts.brain: 두뇌가 다른 주소에 있을 때 (시험: ?brain=http://127.0.0.1:포트)
  // opts.feed: 마이크 대신 음성 서버의 시험 녹음(voice/recordings/{feed}.wav)을 같은 길로 흘린다 (?feed=A-meeting)
  constructor(
    meetingId: string,
    setup: MeetingSetup | null,
    private dispatch: Dispatch,
    private viewer = false,
    private opts: { brain?: string; feed?: string; token?: string; me?: string } = {},
  ) {
    this.client = new LiveClient({
      meetingId,
      token: opts.token ?? setup?.controlToken,
      me: opts.me,
      brain: opts.brain ?? "",
      voiceUrl: voiceUrl(),
      dispatch,
      openStream: eventSource,
      audio: viewer ? silentAudio : browserAudio,
      participants: setup?.participants,
      onEnded: () => this.stopMic(),
    });
  }

  private async startMic() {
    this.dispatch({ src: "ui", type: "conn", part: "mic", status: "connecting" });
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      let src: AudioNode;
      if (this.opts.feed) {
        const r = await fetch(`${httpOf(voiceUrl())}/samples/${encodeURIComponent(this.opts.feed)}.wav`);
        const buf = await ctx.decodeAudioData(await r.arrayBuffer());
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.start();
        src = s;
      } else {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        src = ctx.createMediaStreamSource(this.stream);
      }
      const node = new AudioWorkletNode(ctx, "pcm16k");
      node.port.onmessage = (m) => this.client.sendPcm(m.data as ArrayBuffer);
      src.connect(node);
      attachMic(src); // 듣는 몸짓용 크기
      // 워크릿이 돌려면 출력에 이어져 있어야 한다 (소리는 0)
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      await ctx.resume();
      this.dispatch({ src: "ui", type: "conn", part: "mic", status: "on" });
    } catch {
      this.dispatch({ src: "ui", type: "conn", part: "mic", status: "error" });
      this.dispatch({ src: "ui", type: "toast", text: "마이크 권한이 필요해요. 주소창에서 마이크를 허용해 주세요", tone: "warn" });
    }
  }

  // 마이크와 음성 서버까지만 연다. 화자 등록을 마치고 begin()해야 두뇌로 말을 넘긴다
  async start() {
    this.client.connectStream();
    if (this.viewer) return;
    await this.client.connectVoice();
    await this.startMic();
  }
  begin(opts: { save: boolean; announce?: string }) {
    this.client.begin(opts);
  }
  enroll(name: string | null, replace = false) {
    this.client.enroll(name, replace);
  }
  private stopMic() {
    detachMic();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
  }
  stop() {
    this.stopMic();
    this.client.close();
  }
  respond(actionId: string, accept: boolean) {
    this.client.respond(actionId, accept);
  }
  privateTo(actionId: string, to: "person" | "all" | "drop") {
    this.client.privateTo(actionId, to);
  }
  participation(value: number, intensity: Intensity) {
    this.client.participation(value, intensity);
  }
  roles(roles: Partial<Record<RoleKind, boolean>>, intensity: Intensity) {
    this.client.roles(roles, intensity);
  }
  settings(intensity: Intensity, confirmed: boolean) {
    this.client.settings(intensity, confirmed);
  }
  interrupt() {
    this.client.interrupt();
  }
  async end() {
    this.stopMic();
    await this.client.end();
  }
}
