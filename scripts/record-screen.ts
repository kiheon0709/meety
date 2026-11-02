// 미티 화면 녹화: 헤드리스 크롬으로 미티 회의 화면을 1920×1080 mp4로 남긴다 (영상 편집용 화면 소스).
// 크롬 개발자 프로토콜(CDP)을 직접 쓴다 — 새 의존성 없음. 영상은 화면이 바뀔 때마다 오는 프레임을 벽시계 기준 30fps로 채워 넣어
// 실제 시간과 길이가 같다. ffmpeg 필요(brew install ffmpeg).
//
//   npx tsx scripts/record-screen.ts --mock A                       목업 재생 녹화 (서버는 앱만, 소리 없음)
//   npx tsx scripts/record-screen.ts --scenario A                   이 도구가 실제 회의를 열어 시나리오 녹음을 마이크 대신 흘리고
//                                                                    미티 목소리 + 사람 목소리까지 넣어 녹화 (npm run meeting 먼저)
//   npx tsx scripts/record-screen.ts --meeting <id> --token <열쇠>   진행 중인 실제 회의를 "다른 기기 보기"로 화면만 녹화 (소리 없음 —
//                                     [--space sp_…] [--me 지호]     소리는 회의실 녹음을 쓴다). --me면 그 사람 화면(사설 포함)
//   npx tsx scripts/record-screen.ts --mic --dump 기록.json             진짜 마이크 회의: 크롬 창이 뜨면 사람이 거기서 회의를 만들고 시작한다.
//                                     사람은 마이크로, 미티는 스피커로. 영상에 마이크 소리 + 미티 목소리, 옆에 .mic.wav·.meety.wav (말풍선 장면용, scripts/chat-log.ts)
//   --scenario에 --participation 8 처럼 참여도를 주면 회의 만들기 슬라이더를 그 값으로 (partial 선판단은 7 이상에서만)
//   --urgent-conflict: 두뇌가 아직 speak.urgent를 안 보낼 때 시험용 — 화면에 넘기기 전에 conflict speak에 urgent:true를 붙인다
// 옵션: --forbid 갈피,… (화면 글에 보이면 적음, 기본 갈피) · --brain-dump 두뇌.json(회의 끝에 두뇌 /state 기록) · --out 파일.mp4 (기본 data/recordings/screen-시각.mp4) · --dump 기록.json(목소리·자막 시각, 소리 데이터 빼고) · --port 3107 · --voice-port 8767 · --max 초(기본 3600) · --fps 30 · --w 1920 --h 1080
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOK, chunkTrack, voiceStats, type Rec } from "./screen-voice";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = opt("port", process.env.PORT ?? "3107")!;
const VOICE_PORT = opt("voice-port", process.env.VOICE_PORT ?? "8767")!;
const W = Number(opt("w", "1920"));
const H = Number(opt("h", "1080"));
const FPS = Number(opt("fps", "30"));
const MAX_S = Number(opt("max", "3600"));
const MOCK = opt("mock");
const SCENARIO = opt("scenario");
const FEED = opt("feed", SCENARIO === "A" ? "A-meeting" : SCENARIO);
const MEETING = opt("meeting");
const MIC = argv.includes("--mic");
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
const OUT = path.resolve(opt("out", `data/recordings/screen-${stamp}.mp4`)!);
const APP = `http://localhost:${PORT}`;
if (!MOCK && !SCENARIO && !MEETING && !MIC) {
  console.log("--mock A | --scenario A | --meeting <id> --token <열쇠> | --mic 중 하나를 주세요 (파일 맨 위 설명)");
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 이 도구가 부르는 주소는 모두 이 컴퓨터 안(127.0.0.1: 크롬 조종 포트·음성 서버)뿐 — 밖으로 나가는 호출 없음
const local = (port: string | number, p: string) => `http://127.0.0.1:${port}${p}`;

// ── 크롬 ────────────────────────────────────────────────────────
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debugPort = 9400 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "meety-rec-"));
const chrome = spawn(
  CHROME,
  [
    // --mic: 사람이 보고 누르는 창 + 진짜 마이크·스피커
    ...(MIC ? [`--window-size=${Math.min(W, 1600)},${Math.min(H, 1000) + 90}`] : ["--headless=new", "--use-fake-device-for-media-stream"]),
    "--use-angle=metal", // 3D 미티를 GPU로 (없으면 소프트웨어라 느려 2D로 바뀔 수 있다)
    "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required", // 미티 목소리 재생
    "--use-fake-ui-for-media-stream",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown; sessionId?: string };
let ws: WebSocket;
let seq = 0;
const pending = new Map<number, (m: Msg) => void>();
const listeners: ((m: Msg) => void)[] = [];
function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result ?? {})));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evaluate<T>(sid: string, expression: string): Promise<T> {
  const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid)) as { result?: { value?: T }; exceptionDetails?: unknown };
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value as T;
}
const waitFor = async (sid: string, js: string, ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate<boolean>(sid, `!!(${js})`).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};
const click = (sid: string, text: string, exact = false) =>
  evaluate<boolean>(sid, `(()=>{const b=[...document.querySelectorAll('button,a')].filter(x=>${exact ? `x.textContent.trim()===${JSON.stringify(text)}` : `x.textContent.includes(${JSON.stringify(text)})`}).at(-1);if(b){b.click();return true}return false})()`);


// ── 녹화 ────────────────────────────────────────────────────────
async function main() {
  let ver: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 60 && !ver; i++) {
    try {
      ver = (await (await fetch(local(debugPort, "/json/version"))).json()) as typeof ver;
    } catch {
      await sleep(200);
    }
  }
  if (!ver) throw new Error("크롬을 못 켰어요");
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Msg;
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else listeners.forEach((l) => l(m));
  };
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId: sid } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await send("Page.enable", {}, sid);
  await send("Runtime.enable", {}, sid);
  if (!MIC) await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sid); // --mic는 창 크기 그대로(영상에서 가운데 맞춤)
  const forbid = JSON.stringify(opt("forbid", "갈피")!.split(",").filter(Boolean));
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__forbid = ${forbid};\n` + (argv.includes("--urgent-conflict") ? "window.__urgentConflict = true;\n" : "") + (MIC ? "window.__micRec = true;\n" : "") + HOOK }, sid);

  const go = (url: string) => send("Page.navigate", { url }, sid);
  if (MOCK) await go(`${APP}/live/demo-${MOCK.toLowerCase()}?mock=${MOCK}&speed=${opt("speed", "1")}&clean=1`);
  else if (MEETING) {
    const q = new URLSearchParams({ ...(opt("space") ? { space: opt("space")! } : {}), token: opt("token") ?? "", ...(opt("me") ? { me: opt("me")! } : {}) });
    await go(`${APP}/live/${encodeURIComponent(MEETING)}?${q}`);
  } else await go(`${APP}/live/new`);
  await sleep(2500);

  // 화면 프레임 받기 시작 → 벽시계로 30fps에 맞춰 ffmpeg에 넣는다 (바뀐 게 없으면 앞 프레임을 되풀이)
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const videoOnly = SCENARIO || MIC ? OUT.replace(/\.mp4$/, ".video.mp4") : OUT;
  const ff: ChildProcess = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", MIC ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:white` : `scale=${W}:${H}`, videoOnly], { stdio: ["pipe", "inherit", "inherit"] });
  let latest: Buffer | null = null;
  let received = 0;
  listeners.push((m) => {
    if (m.method === "Page.screencastFrame" && m.sessionId === sid) {
      const p = m.params as { data: string; sessionId: number };
      latest = Buffer.from(p.data, "base64");
      received++;
      void send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
    }
  });
  await send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 }, sid);
  const t0 = Date.now();
  let written = 0;
  const tick = setInterval(() => {
    if (!latest) return;
    const want = Math.floor(((Date.now() - t0) / 1000) * FPS);
    while (written < want) {
      ff.stdin!.write(latest);
      written++;
    }
  }, 1000 / FPS / 2);

  // 회의 진행
  const ended = `/회의 끝에 확인했어요|회의가 끝났어요/.test(document.body.innerText)`;
  if (SCENARIO) {
    if (!(await click(sid, "예시 회의로 채우기"))) await click(sid, "예시로 채우기"); // S10(10/31)에서 이름이 바뀜
    await sleep(800);
    await evaluate(sid, `(()=>{const c=[...document.querySelectorAll('input[type=checkbox]')].find(x=>x.closest('label')?.textContent.includes('예시 대본대로'));if(c&&c.checked)c.click();return 1})()`);
    if (opt("participation")) {
      // React가 아는 방식으로 슬라이더 값을 바꾼다
      await evaluate(sid, `(()=>{const r=document.querySelector('input[type=range]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'${Number(opt("participation"))}');r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));return r.value})()`);
      await sleep(300);
    }
    await click(sid, "회의 시작", true);
    await waitFor(sid, `/\\/live\\/[0-9a-f-]{20,}/.test(location.pathname)`, 20000);
    await sleep(1200);
    await evaluate(sid, `location.href = location.href + '&feed=${FEED}'`);
    await sleep(3500);
    await click(sid, "마이크 켜기");
    await sleep(1500);
    await click(sid, "회의 시작", true);
    console.log(`회의 시작 — ${FEED} 녹음을 마이크 대신 흘려요`);
  } else if (MEETING) {
    await click(sid, "화면으로만 볼게요");
  } else if (MIC) console.log("크롬 창에서 회의를 만들고 시작하세요. 회의를 끝내면 녹화도 끝나요.");
  const endedOk = await waitFor(sid, ended, MAX_S * 1000);
  if (!endedOk && SCENARIO) {
    await click(sid, "회의 끝");
    await waitFor(sid, ended, 30000);
  }
  await sleep(3000); // 끝 화면 조금 더
  clearInterval(tick);
  await send("Page.stopScreencast", {}, sid).catch(() => {});
  const seconds = (Date.now() - t0) / 1000;
  const rec = await evaluate<Rec>(sid, `window.__rec`);
  if (MIC) {
    // 마이크 녹음 조각(마이크를 껐다 켜면 여러 개)을 받아 녹화 시작(t0)에 맞춘 .mic.wav 하나로
    const segs = await evaluate<{ at: number; b64: string }[]>(sid, `(async()=>{const out=[];for(const m of window.__mics||[]){if(m.mr.state!=='inactive'){const done=new Promise(r=>m.mr.onstop=r);m.mr.stop();await done}const u=new Uint8Array(await new Blob(m.parts).arrayBuffer());let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));out.push({at:m.at,b64:btoa(s)})}return out})()`);
    if (segs.length) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meety-mic-"));
      const ins = segs.flatMap((m, k) => { const f = path.join(tmp, `${k}.webm`); fs.writeFileSync(f, Buffer.from(m.b64, "base64")); return ["-i", f]; });
      const d = segs.map((m) => Math.max(0, Math.round(m.at - t0)));
      const graph = `${d.map((ms, k) => `[${k}:a]adelay=${ms}|${ms}[m${k}]`).join(";")};${d.map((_, k) => `[m${k}]`).join("")}amix=inputs=${d.length}:normalize=0:duration=longest[out]`;
      const file = OUT.replace(/\.mp4$/, ".mic.wav");
      await new Promise<void>((res, rej) => spawn("ffmpeg", ["-y", "-loglevel", "error", ...ins, "-filter_complex", graph, "-map", "[out]", "-ac", "1", "-ar", "48000", file], { stdio: "inherit" }).on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));
      fs.rmSync(tmp, { recursive: true, force: true });
      rec.mic = { at: t0, file, parts: segs.map((m) => m.at) };
    }
  }
  // 두뇌 쪽 기록(/api/live/{id}/state — 개발 서버에서만, 회의 열쇠로): 판단 기록·미리 판단·말할 것 후보·시간. 어긋남을 놓친 판을 두뇌가 보게
  if (opt("brain-dump")) {
    const st = await evaluate<string>(sid, `(async()=>{const id=location.pathname.split('/').pop();const k=JSON.parse(localStorage.getItem('meety:setup:'+id)||'{}').controlToken||new URLSearchParams(location.search).get('token');const r=await fetch('/api/live/'+id+'/state',{headers:{'x-live-token':k||''}});return r.ok?await r.text():'{"error":'+r.status+'}'})()`);
    fs.writeFileSync(opt("brain-dump")!, st);
  }
  if (opt("dump")) fs.writeFileSync(opt("dump")!, JSON.stringify({ t0, ...rec, chunks: rec.chunks.map(({ b64, ...c }) => ({ ...c, bytes: b64.length })) }, null, 1));
  ff.stdin!.end();
  await new Promise((r) => ff.on("close", r));

  const fps = rec.fps.slice(2); // 첫 2초(불러오는 중) 빼고
  const lines = [
    `화면: ${W}×${H} ${FPS}fps, ${seconds.toFixed(1)}초, 받은 화면 프레임 ${received}개(초당 ${(received / seconds).toFixed(1)}), 영상 프레임 ${written}개`,
    `페이지가 그린 장 수(초당): 평균 ${fps.length ? (fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1) : "?"} · 가장 낮은 1초 ${fps.length ? Math.min(...fps) : "?"}`,
    `화면에 보이면 안 되는 글자(${opt("forbid", "갈피")}): ${rec.forbidden.length ? rec.forbidden.map(([t, x]) => `${((t - t0) / 1000).toFixed(1)}초 "${x}"`).join(" / ") : "없음"}`,
    `두뇌 draft(미리 판단): ${rec.drafts.length}번 ${rec.drafts.map(([t, st]) => `${((t - t0) / 1000).toFixed(1)}초 ${st}`).join(", ")}`,
  ];
  if (SCENARIO || MIC) lines.push(...(await mixAudio(rec, t0, videoOnly, seconds)), ...voiceStats(rec, t0));
  else lines.push("소리: 없음 (목업·다른 기기 보기는 소리를 내지 않아요 — 회의실 녹음과 맞춰 편집)");
  console.log(lines.join("\n"));
  console.log(`→ ${OUT}`);
}

// 미티 목소리 문장들 + 마이크 대신 흘린 녹음을 재생된 시각에 맞춰 섞어 영상에 붙인다
async function mixAudio(rec: Rec, t0: number, video: string, seconds: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meety-mix-"));
  const inputs: string[] = [];
  const filters: string[] = [];
  const add = (file: string, atMs: number, durS?: number) => {
    const i = inputs.length / 2 + 1; // 0번은 영상
    inputs.push("-i", file);
    const delay = Math.max(0, Math.round(atMs - t0));
    filters.push(`[${i}:a]${durS ? `atrim=0:${durS.toFixed(3)},` : ""}adelay=${delay}|${delay}[a${i}]`);
  };
  if (rec.feedAt && FEED) {
    const wav = path.join(tmp, "feed.wav");
    fs.writeFileSync(wav, Buffer.from(await (await fetch(local(VOICE_PORT, `/samples/${FEED}.wav`))).arrayBuffer()));
    add(wav, rec.feedAt);
  }
  if (rec.mic) add(rec.mic.file, rec.mic.at);
  if (rec.chunks.length) {
    const wav = path.join(tmp, "meety-stream.wav");
    chunkTrack(rec.chunks, t0, wav);
    add(wav, t0);
    if (MIC) fs.copyFileSync(wav, OUT.replace(/\.mp4$/, ".meety.wav")); // 녹화 시작(t0)부터 미티 목소리만
  }
  const clips = rec.clips.filter((c) => c.b64);
  clips.forEach((c, k) => {
    const wav = path.join(tmp, `meety-${k}.wav`);
    fs.writeFileSync(wav, Buffer.from(c.b64!, "base64"));
    add(wav, c.at, c.end ? (c.end - c.at) / 1000 : undefined); // 끊긴 문장은 끊긴 데까지만
  });
  if (!filters.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.renameSync(video, OUT);
    return ["소리: 잡힌 게 없어요"];
  }
  const n = filters.length;
  const graph = `${filters.join(";")};${Array.from({ length: n }, (_, k) => `[a${k + 1}]`).join("")}amix=inputs=${n}:normalize=0:duration=longest[aout]`;
  await new Promise<void>((res, rej) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", video, ...inputs, "-filter_complex", graph, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", seconds.toFixed(2), OUT], { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}`))));
  });
  fs.rmSync(video);
  fs.rmSync(tmp, { recursive: true, force: true });
  // 소리-화면 맞춤: 미티 문장 재생 시각 vs 화면 상태 글이 "말하는 중"으로 바뀐 시각
  const speakLabels = rec.labels.filter(([, l]) => l.startsWith("말하는 중")).map(([t]) => t);
  const offsets = clips.map((c) => {
    const near = speakLabels.filter((t) => Math.abs(t - c.at) < 2000).sort((a, b) => Math.abs(a - c.at) - Math.abs(b - c.at))[0];
    return near !== undefined ? near - c.at : null;
  }).filter((x): x is number => x !== null);
  return [
    `소리: 사람(마이크 대신 흘린 ${FEED}.wav, ${rec.feedAt ? ((rec.feedAt - t0) / 1000).toFixed(2) + "초부터" : "없음"}) + 미티 ${rec.chunks.length ? `조각 ${rec.chunks.length}개(/tts/stream)` : ""}${clips.length || !rec.chunks.length ? ` 문장 ${clips.length}개(wav)` : ""}${rec.clips.length > clips.length ? ` (못 잡은 것 ${rec.clips.length - clips.length})` : ""}`,
    `미티 문장 시각(영상 기준 초): ${clips.map((c) => `${((c.at - t0) / 1000).toFixed(2)}~${c.end ? ((c.end - t0) / 1000).toFixed(2) : "?"}`).join(", ") || "없음"}`,
    offsets.length ? `소리-화면: 미티 문장이 나는 순간과 화면이 '말하는 중'이 되는 순간의 차이 ${offsets.map((o) => `${o}ms`).join(", ")} (+면 화면이 늦음)` : "소리-화면: 견줄 '말하는 중' 순간 없음",
  ];
}

main()
  .catch((e) => {
    console.error("녹화 실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {}
    // 크롬이 다 꺼진 뒤에 임시 프로필을 지운다 (꺼지는 중에 지우면 ENOTEMPTY로 죽었다)
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
