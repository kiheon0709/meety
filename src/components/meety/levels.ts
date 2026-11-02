// 소리 크기: 미티 TTS(입 움직임)와 마이크(듣는 몸짓). 3D는 매 프레임 level()만 읽는다 — React state에 넣지 않는다.
// TTS 조각(/tts/stream)은 BufferSource를 같은 Analyser에 잇고, wav 통째(<audio>)는 문장마다 새 <audio>라 요소마다 createMediaElementSource를 한 번씩 만들어 같은 Analyser에 잇는다.
// AudioContext는 사용자 동작(회의 시작 버튼)에서 unlock()으로 연다. 그 전이거나 막혀 있으면 소리를 바로 재생하고 크기는 0
let ctx: AudioContext | null = null;
let tts: AnalyserNode | null = null;
let mic: AnalyserNode | null = null;
const buf = new Float32Array(512);

export function unlock() {
  if (typeof window === "undefined" || !("AudioContext" in window)) return;
  ctx ??= new AudioContext();
  void ctx.resume().catch(() => {});
}

// TTS 소리가 나가는 곳 (크기 재는 Analyser → 스피커). AudioContext가 아직 안 열렸으면 null
export function ttsOut(): { ctx: AudioContext; node: AudioNode } | null {
  if (!ctx || ctx.state !== "running") return null;
  if (!tts) {
    tts = ctx.createAnalyser();
    tts.fftSize = 512;
    tts.connect(ctx.destination);
  }
  return { ctx, node: tts };
}

// 이 <audio>를 크기 재는 길로 보낸다. 못 하면 false (그대로 재생하면 된다)
export function attachTts(el: HTMLAudioElement): boolean {
  const out = ttsOut();
  if (!out) return false;
  try {
    out.ctx.createMediaElementSource(el).connect(out.node);
    return true;
  } catch {
    return false;
  }
}

// 마이크 소리 노드(RealTransport의 AudioContext 안)에 크기 재기를 붙인다
export function attachMic(node: AudioNode) {
  try {
    mic = node.context.createAnalyser();
    mic.fftSize = 512;
    node.connect(mic);
  } catch {
    mic = null;
  }
}
export function detachMic() {
  mic = null;
}

// 0~1. RMS를 말소리 크기에 맞게 늘린다 (조용함 0.02 아래는 0)
export function level(which: "tts" | "mic"): number {
  const a = which === "tts" ? tts : mic;
  if (!a) return 0;
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.max(0, (Math.sqrt(sum / buf.length) - 0.02) / 0.15));
}
