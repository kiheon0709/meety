// 미티 화면 녹화·시험이 같이 쓰는 것: 페이지에 심는 기록 갈고리(HOOK), 미티 목소리 조각을 한 줄 wav로, 목소리 숫자.
// scripts/record-screen.ts(시나리오 녹화)와 가짜 두뇌 + 진짜 음성 서버 시험이 쓴다
import fs from "node:fs";

// 페이지에 미리 심는 것: 미티 목소리(/tts/stream 조각 BufferSource, 또는 문장마다 새 <audio>)를 재생 순간에 붙잡아 두고, 마이크 대신 흘린 녹음이 시작한 때를 적는다.
// 목소리 숫자용으로 tts on/off·barge_in·speak 도착·/tts/stream 부탁·자막 글·입 크기(TTS Analyser)도 적는다
export const HOOK = `(() => {
  // 개발 서버 표시(왼쪽 아래 Next 배지)는 녹화에 안 나오게
  const hide = () => { const st = document.createElement("style"); st.textContent = "nextjs-portal{display:none!important}"; document.documentElement.appendChild(st); };
  if (document.documentElement) hide(); else addEventListener("DOMContentLoaded", hide);
  const rec = (window.__rec = { clips: [], chunks: [], feedAt: null, labels: [], drafts: [], fps: [], speaks: [], tts: [], barges: [], asks: [], subs: [], mouth: [], voice: [], forbidden: [], brain: [], finals: [] });
  // 화면에 보이면 안 되는 글자(window.__forbid, 녹화 --forbid): 0.5초마다 보이는 글 전체에서 찾아 그 언저리를 적는다
  setInterval(() => {
    for (const w of window.__forbid || []) {
      const tx = document.body?.innerText || "";
      const i = tx.indexOf(w);
      if (i < 0) continue;
      const near = tx.slice(Math.max(0, i - 20), i + 20).replace(/\s+/g, " ");
      if (!rec.forbidden.some((x) => x[1] === near)) rec.forbidden.push([Date.now(), near]);
    }
  }, 500);
  // 화면이 매끄러운지: 1초마다 그린 장 수
  let n = 0, sec = performance.now();
  const frame = () => { n++; const now = performance.now(); if (now - sec >= 1000) { rec.fps.push(n); n = 0; sec = now; } requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  // 두뇌의 draft(말 끝나기 전 미리 판단) 횟수 — 이름 붙은 이벤트(event: draft)든 data 안 type이든
  // window.__urgentConflict(녹화 --urgent-conflict): 두뇌가 아직 speak.urgent를 안 보낼 때 시험용으로 conflict speak에 urgent:true를 붙여 화면에 넘긴다
  const mark = (e, d, named) => {
    if (!window.__urgentConflict || !d || d.kind !== "conflict" || d.urgent || !(named || d.type === "speak")) return e;
    rec.urgentMarked = (rec.urgentMarked || 0) + 1;
    return new MessageEvent(e.type, { data: JSON.stringify({ ...d, urgent: true }) });
  };
  const add = EventSource.prototype.addEventListener;
  // 두뇌가 보낸 것 전부(latency 빼고) — 말풍선 장면 기록(scripts/chat-log.ts)이 쓴다
  const keep = (d) => { if (d && d.type !== "latency") rec.brain.push([Date.now(), d]); };
  EventSource.prototype.addEventListener = function (type, fn, o) {
    if (type !== "error" && type !== "open") {
      const orig = fn;
      fn = function (e) {
        let d = null;
        try {
          d = JSON.parse(e.data);
          keep(d.type ? d : { ...d, type });
          if (type === "draft" || d.type === "draft") rec.drafts.push([Date.now(), d.state]);
          if (type === "speak" || d.type === "speak") rec.speaks.push([Date.now(), d.actionId, d.kind, d.sentences || [d.text], d.urgent ? 1 : 0]);
        } catch {}
        return orig.call(this, mark(e, d, type === "speak"));
      };
    }
    return add.call(this, type, fn, o);
  };
  const desc = Object.getOwnPropertyDescriptor(EventSource.prototype, "onmessage");
  if (desc && desc.set) Object.defineProperty(EventSource.prototype, "onmessage", { set(fn) { desc.set.call(this, (e) => { let d = null; try { d = JSON.parse(e.data); keep(d); if (d.type === "draft") rec.drafts.push([Date.now(), d.state]); if (d.type === "speak") rec.speaks.push([Date.now(), d.actionId, d.kind, d.sentences || [d.text], d.urgent ? 1 : 0]); } catch {} return fn(mark(e, d, false)); }); }, get: desc.get, configurable: true });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const clip = { at: Date.now(), end: null, b64: null };
    rec.clips.push(clip);
    fetch(this.src).then((r) => r.arrayBuffer()).then((b) => {
      let s = ""; const u = new Uint8Array(b);
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      clip.b64 = btoa(s);
    }).catch(() => {});
    const done = () => { if (!clip.end) clip.end = Date.now(); };
    this.addEventListener("ended", done, { once: true });
    this.addEventListener("pause", done, { once: true });
    return play.call(this);
  };
  // 미티 목소리 길: 스피커로 가는 Analyser(입 크기) ← BufferSource 조각. 마이크 대신 흘린 녹음은 이 길이 아니다
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (d, ...r) {
    if (this instanceof AnalyserNode && d instanceof AudioDestinationNode) this.__tts = true;
    if (this instanceof AudioBufferSourceNode && d && d.__tts) this.__tts = true;
    return connect.call(this, d, ...r);
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...a) {
    if (this.__tts && this.buffer) {
      const ch = this.buffer.getChannelData(0), u = new Uint8Array(ch.length * 2), v = new DataView(u.buffer);
      for (let i = 0; i < ch.length; i++) v.setInt16(i * 2, Math.max(-1, Math.min(1, ch[i])) * 32767, true);
      let s = "";
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      const now = Date.now();
      this.__c = { call: now, at: now + Math.max(0, when - this.context.currentTime) * 1000, ms: this.buffer.duration * 1000, sr: this.buffer.sampleRate, end: null, b64: btoa(s) };
      rec.chunks.push(this.__c);
    } else if (this.buffer && this.buffer.duration > 5 && !rec.feedAt) rec.feedAt = Date.now();
    return start.call(this, when, ...a);
  };
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (...a) {
    if (this.__c && !this.__c.end) this.__c.end = Date.now();
    return stop.apply(this, a);
  };
  // 입 크기: 3D가 매 프레임 읽는 TTS Analyser 값을 levels.ts와 같은 식으로 (0.05초에 한 번만 적는다)
  const tdd = AnalyserNode.prototype.getFloatTimeDomainData;
  let mouthAt = 0;
  AnalyserNode.prototype.getFloatTimeDomainData = function (b) {
    tdd.call(this, b);
    const now = Date.now();
    if (this.__tts && now - mouthAt >= 50) {
      mouthAt = now;
      let sum = 0;
      for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
      rec.mouth.push([now, Math.min(1, Math.max(0, (Math.sqrt(sum / b.length) - 0.02) / 0.15))]);
    }
  };
  // --mic(window.__micRec): 앱이 연 마이크를 그대로 같이 녹음한다(마이크를 다시 열면 새 조각). 녹화가 끝날 때 record-screen이 꺼내 간다
  if (window.__micRec && navigator.mediaDevices) {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      if (c && c.audio && s.getAudioTracks().length) {
        const m = { at: Date.now(), parts: [], mr: new MediaRecorder(s, { mimeType: "audio/webm;codecs=opus" }) };
        m.mr.ondataavailable = (e) => { if (e.data.size) m.parts.push(e.data); };
        m.mr.start(1000);
        (window.__mics = window.__mics || []).push(m);
      }
      return s;
    };
  }
  // 음성 서버와 주고받은 것: tts on/off(문장 시작), barge_in, /tts/stream 부탁
  const wsend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    if (typeof d === "string") try { const m = JSON.parse(d); if (m.type === "tts") rec.tts.push([Date.now(), m.on, m.text || null]); } catch {}
    return wsend.call(this, d);
  };
  const wdesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  if (wdesc && wdesc.set) Object.defineProperty(WebSocket.prototype, "onmessage", { set(fn) { wdesc.set.call(this, (e) => { try { if (typeof e.data === "string") { const d = JSON.parse(e.data); if (d.type === "barge_in") rec.barges.push(Date.now()); if (d.type === "speech_start" || d.type === "speech_end" || d.type === "final") rec.voice.push([Date.now(), d.type, d.id, d.turn ?? null, d.echo ? 1 : 0]); if (d.type === "final") rec.finals.push([Date.now(), d]); } } catch {} return fn(e); }); }, get: wdesc.get, configurable: true });
  const f = window.fetch;
  window.fetch = function (u, o) {
    if (String(u).endsWith("/tts/stream")) try { rec.asks.push([Date.now(), JSON.parse(o.body).text]); } catch {}
    return f.apply(this, arguments);
  };
  // 상태 글(듣고 있어요·말하는 중…)이 바뀐 때 — 소리와 화면이 맞는지 볼 때 쓴다
  let last = "";
  setInterval(() => {
    const l = (document.querySelector("main section [aria-live]")?.innerText || "").split("\\n")[0];
    if (l && l !== last) { last = l; rec.labels.push([Date.now(), l]); }
    const sub = [...document.querySelectorAll("[aria-live]")].find((e) => e.className.includes("max-w-[720px]"))?.querySelector("div.mt-1")?.innerText || "";
    if (sub !== (rec.subs.at(-1) || [0, ""])[1]) rec.subs.push([Date.now(), sub]);
  }, 30);
})();`;

export type Chunk = {
  call: number;
  at: number;
  ms: number;
  sr: number;
  end: number | null;
  b64: string;
};
export type Rec = {
  clips: { at: number; end: number | null; b64: string | null }[];
  chunks: Chunk[];
  feedAt: number | null;
  labels: [number, string][];
  drafts: [number, string][];
  fps: number[];
  speaks: [number, string, string, string[], number?][];
  tts: [number, boolean, string | null][];
  barges: number[];
  asks: [number, string][];
  subs: [number, string][];
  mouth: [number, number][];
  urgentMarked?: number;
  voice: [number, string, number, number | null, number][]; // 사람 말 시작·끝·final(turn, echo)
  forbidden: [number, string][]; // 화면에 보인 금지 글자 언저리
  mic?: { at: number; file: string; parts: number[] }; // --mic: 녹화 시작(t0)에 맞춘 마이크 녹음 파일, parts: 조각마다 시작 시각
  brain?: [number, { type: string; [k: string]: unknown }][]; // 두뇌 이벤트 전부(latency 빼고)
  finals?: [number, { id: number; t0: number; t1: number; text: string; speaker?: string; echo?: boolean }][]; // 사람 말 글·화자
};
// 끝까지 안 나고 멈춘 조각 (다 난 뒤에 stop()이 불려도 end가 적힌다 — 회의 끝 등)
const cutShort = (c: Chunk) => c.end !== null && c.end < c.at + c.ms - 5;
export const chunkEnd = (c: Chunk) => Math.min(c.at + c.ms, c.end ?? Infinity);

// /tts/stream 조각들을 실제로 소리 난 시각에 놓아 한 줄짜리 미티 목소리 wav로 (끊긴 조각은 끊긴 데까지만)
export function chunkTrack(chunks: Chunk[], t0: number, file: string) {
  const SR = 24000;
  const len =
    Math.ceil(((Math.max(...chunks.map(chunkEnd)) - t0) / 1000) * SR) + 1;
  const out = new Int16Array(len);
  for (const c of chunks) {
    const pcm = new Int16Array(
      Uint8Array.from(Buffer.from(c.b64, "base64")).buffer,
    );
    const from = Math.round(((c.at - t0) / 1000) * SR);
    const n = Math.max(0, Math.round(((chunkEnd(c) - c.at) / 1000) * SR));
    for (let i = 0; i < n && from + i < len; i++)
      if (from + i >= 0)
        out[from + i] =
          pcm[Math.min(pcm.length - 1, Math.floor((i * c.sr) / SR))];
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + out.byteLength, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(out.byteLength, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(out.buffer)]));
}

// 미티 목소리 숫자: speak 도착→첫 소리, /tts/stream 부탁→첫 소리, 문장 사이 빈틈, barge_in→소리 멈춤, 자막-소리, 입 크기
export function voiceStats(rec: Rec, t0: number): string[] {
  if (!rec.chunks.length)
    return ["목소리 조각: 없음 (/tts/stream을 안 썼어요 — wav 통째 재생)"];
  const sec = (t: number) => ((t - t0) / 1000).toFixed(2);
  const med = (a: number[]) =>
    a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN;
  const sum = (a: number[], k: string) =>
    a.length
      ? `${k} 중앙 ${med(a)}ms · 최소 ${Math.min(...a)} · 최대 ${Math.max(...a)} (${a.length}개)`
      : `${k}: 없음`;
  // 문장 = tts on(문장 글). 조각은 자기 call 직후(+50ms) 안에 있는 마지막 tts on 문장에 붙는다 (첫 조각이 tts on보다 몇 ms 먼저 걸린다)
  const ons = rec.tts
    .filter(([, on, text]) => on && text)
    .map(([t, , text]) => ({ t, text: text!, chunks: [] as Chunk[] }));
  for (const c of rec.chunks) {
    const s = ons.filter((o) => o.t <= c.call + 50).at(-1);
    s?.chunks.push(c);
  }
  const sents = ons
    .filter((o) => o.chunks.length)
    .map((o) => ({
      ...o,
      first: Math.min(...o.chunks.map((c) => c.at)),
      last: Math.max(...o.chunks.map(chunkEnd)),
      cut: o.chunks.some(cutShort),
    }));
  // speak 도착 → 첫 문장 첫 소리 (두뇌가 정한 기다림 — 사람 말 끝·왜 카드 0.6초 — 이 들어 있다)
  const speakLead = rec.speaks.flatMap(([t, , , ss]) => {
    const s = sents.find((x) => x.text === ss[0] && x.first >= t);
    return s ? [Math.round(s.first - t)] : [];
  });
  // 말의 첫 문장: 앞 문장이 없거나, 앞 문장 뒤에 tts off가 있었거나, 앞 문장이 끊겼다 (뒤 문장은 미리 받아 두고 차례를 기다려서 아래 '문장 사이 빈틈'으로 본다)
  const opens = sents.filter(
    (s, i) =>
      i === 0 ||
      sents[i - 1].cut ||
      rec.tts.some(([t, on]) => !on && t > sents[i - 1].t && t < s.t),
  );
  // /tts/stream 부탁 → 그 말 첫 소리 (목소리 서버 + 화면 재생. 사람 말이 멎기를 기다린 시간도 들어 있다)
  const askLead = opens.flatMap((s) => {
    const a = rec.asks
      .filter(([t, text]) => text === s.text && t <= s.first)
      .at(-1);
    return a ? [Math.round(s.first - a[0])] : [];
  });
  // 한 speak 안 문장 사이 빈틈: 앞 문장 마지막 소리 끝 → 다음 문장 첫 소리 (사이에 tts off가 없으면 같은 speak)
  const gaps: number[] = [];
  for (let i = 1; i < sents.length; i++) {
    const a = sents[i - 1];
    const b = sents[i];
    if (a.cut || rec.tts.some(([t, on]) => !on && t > a.t && t < b.t)) continue;
    gaps.push(Math.round(b.first - a.last));
  }
  // 조각 사이 끊김(한 문장 안에서 다음 조각이 늦게 와 소리가 빈 곳). 끊긴 문장은 끊기기 전 조각만
  const under = sents.flatMap((s) => {
    const cutAt = Math.min(...s.chunks.filter(cutShort).map((c) => c.end!));
    const cs = s.chunks.filter((c) => c.at < cutAt);
    return cs
      .slice(1)
      .map((c, i) => Math.round(c.at - chunkEnd(cs[i])))
      .filter((g) => g > 5);
  });
  // barge_in → 소리 멈춤
  const barge = rec.barges.flatMap((t) => {
    const playing = rec.chunks.filter((c) => c.at <= t + 20 && c.at + c.ms > t);
    const pending = rec.chunks.filter((c) => c.call <= t && c.at > t);
    if (!playing.length && !pending.length) return [];
    const stopped = [...playing, ...pending].filter(
      (c) => c.end !== null && c.end >= t - 5,
    );
    const later = rec.chunks.filter(
      (c) => c.call > t + 5 && c.call < t + 3000,
    ).length;
    return [
      `${sec(t)}초: 소리 나던 조각 ${playing.length} + 걸어 둔 조각 ${pending.length} → 멈춘 것 ${stopped.length}, 멈추기까지 ${stopped.length ? Math.round(Math.max(...stopped.map((c) => c.end!)) - t) : "?"}ms, 3초 안에 새로 건 조각 ${later}`,
    ];
  });
  // 자막: 그 문장(첫 장)이 화면에 뜬 때 - 첫 소리 (+면 자막이 늦음)
  const norm = (x: string) => x.replace(/\s+/g, "");
  const subLag = sents.flatMap((s) => {
    const hit = rec.subs.find(
      ([t, text]) =>
        text &&
        norm(s.text).startsWith(norm(text).replace(/—$/, "")) &&
        t >= s.first - 2000,
    );
    return hit ? [Math.round(hit[0] - s.first)] : [];
  });
  // 상태 글 '말하는 중'이 뜬 때 - 그 speak 첫 소리 (+면 화면이 늦음)
  const speakLabels = rec.labels
    .filter(([, l]) => l.startsWith("말하는 중"))
    .map(([t]) => t);
  const labelLag = opens.flatMap((s) => {
    const near = speakLabels
      .filter((t) => Math.abs(t - s.first) < 2000)
      .sort((a, b) => Math.abs(a - s.first) - Math.abs(b - s.first))[0];
    return near !== undefined ? [Math.round(near - s.first)] : [];
  });
  // 입: 소리 나는 동안 입 크기 > 0.05인 비율, 소리 없을 때(앞뒤 0.3초 뺌) > 0.05인 비율
  const sounding = (t: number, pad: number) =>
    rec.chunks.some((c) => t >= c.at - pad && t <= chunkEnd(c) + pad);
  const inS = rec.mouth.filter(([t]) => sounding(t, 0));
  const outS = rec.mouth.filter(([t]) => !sounding(t, 300));
  const pct = (a: [number, number][]) =>
    a.length
      ? `${Math.round((a.filter(([, v]) => v > 0.05).length / a.length) * 100)}%`
      : "?";
  const mean = inS.length
    ? (inS.reduce((a, [, v]) => a + v, 0) / inS.length).toFixed(2)
    : "?";
  return [
    ...(rec.urgentMarked
      ? [`urgent 붙인 conflict speak(--urgent-conflict): ${rec.urgentMarked}개`]
      : []),
    `목소리 조각: ${rec.chunks.length}개, 문장 ${sents.length}개 (끊긴 문장 ${sents.filter((s) => s.cut).length}), 표본율 ${[...new Set(rec.chunks.map((c) => c.sr))].join("/")}`,
    sum(speakLead, "speak 도착→첫 소리"),
    sum(askLead, "말 첫 문장 /tts/stream 부탁→첫 소리"),
    sum(gaps, "문장 사이 빈틈"),
    `한 문장 안 조각 끊김(5ms 넘게 빈 곳): ${under.length ? `${under.length}번 (문장 ${sents.length}개), 합 ${under.reduce((a, b) => a + b, 0)}ms, 최대 ${Math.max(...under)}ms` : "없음"}`,
    `barge_in: ${rec.barges.length}번${barge.length ? " — " + barge.join(" / ") : " (미티 소리 중엔 없음)"}`,
    sum(subLag, "자막(그 문장 첫 장)-첫 소리 (+면 자막이 늦음)"),
    sum(labelLag, "상태 글 '말하는 중'-첫 소리 (+면 화면이 늦음)"),
    `입: 소리 나는 동안 움직인 비율 ${pct(inS)} (평균 크기 ${mean}), 조용할 때 움직인 비율 ${pct(outS)} (표본 ${inS.length}/${outS.length})`,
    `문장별: ${sents.map((s) => `${sec(s.first)}~${sec(s.last)}${s.cut ? "(끊김)" : ""} ${s.text.slice(0, 14)}`).join(" | ")}`,
  ];
}
