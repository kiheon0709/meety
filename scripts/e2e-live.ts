// 끝까지(E2E) 시험: 브라우저 대신 노드가 화면이 하는 일을 그대로 한다 (같은 LiveClient 코드).
//   시나리오 A 음성(wav)을 음성 서버 WS에 실제 속도로 흘림 → final·gap·barge_in을 두뇌로 → SSE 구독
//   → prepare면 /tts/prefetch, speak면 /tts로 소리를 받아 "재생"(그 길이만큼 tts on) → 회의 끝 체크리스트
// 기대 행동(시나리오 [미티 기대])과 말 끝→미티 첫 소리까지 지연을 단계별로 재서 tests/e2e/results/에 쓴다.
//
//   npm run e2e:live -- --fake-brain                 모델 없이 (가짜 두뇌). 음성 서버는 진짜
//   LIVE_LLM=1 npm run e2e:live                      진짜 두뇌 (모델 호출 → 돈이 든다)
// 옵션: --brain http://127.0.0.1:3107  --voice ws://127.0.0.1:8767/ws  --wav voice/recordings/A-meeting.wav
//       --echo      미티 소리를 스피커에서 다시 들어온 것처럼 마이크 입력에 섞는다 (에코 시험)
//       --no-wait   사람들이 미티를 기다려 주지 않는다 (대본 간격 그대로 → 끼어들기 시험)
//       --space ID  회의를 열 스페이스 (기본: 복사본 DB에서 이름에 "갈피"가 든 것)
//   실제 녹음(대본 turns.json 없음)이면 "자유 모드": 대본 채점 대신 미티가 끼어든 수·거짓 barge_in·받아쓰기 오류율·지연·비용·자원을 잰다
//       --ref 전사.md         받아쓰기 오류율 기준 (**[mm:ss] 이름:** 꼴, 흘린 구간 전체를 한 번에 견줌)
//       --participants 재훈,기헌,태은,지호   --intensity mid   --title "멘토링"
//       --host 기헌  --mode decision|brainstorm|presentation  --participation 0~10  --roles conflict,research,-suggest
//                   (시작 요청에 실음. 기본: 첫 참석자·decision·참여도는 회의 종류 초깃값·역할은 두뇌 기본)
//       --free      대본(turns.json)이 있어도 자유 모드로 (같은 날 두 번째 회의 시험 등)
//       --enroll    회의 전에 voice/recordings/enroll.wav로 네 사람 목소리를 화면과 같은 방법(웹소켓 enroll)으로 등록
import "./env";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AgentEvent, MeetingMode, StartMeetingReq, VoiceEvent } from "../src/lib/live/contract";
import { parseRoles, withHostMode } from "../src/components/live/start-req";
import { LiveClient, fetchStream, wavSeconds, type AudioOut } from "../src/components/live/client";
import { initState, meetyMode, reduce, type LiveAction, type LiveState } from "../src/components/live/state";
import { startFakeBrain } from "../tests/e2e/fake-brain";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);
const FAKE = flag("fake-brain");
const ECHO = flag("echo");
const WAIT = !flag("no-wait");
const WAV = opt("wav", "voice/recordings/A-meeting.wav")!;
const VOICE = opt("voice", `ws://127.0.0.1:${process.env.VOICE_PORT ?? 8767}/ws`)!;
const SR = 16000;
const CH = 1024; // 64ms 묶음 (화면과 같음)

if (!FAKE && process.env.LIVE_LLM !== "1") {
  console.log("진짜 두뇌 시험은 모델을 불러서 LIVE_LLM=1일 때만 돌아요. 배선만 보려면 --fake-brain");
  process.exit(0);
}

// ── wav 읽기 (16bit PCM, 아무 표본율 → 16kHz mono) ─────────────────
function readWav(buf: Buffer): Int16Array {
  let off = 12;
  let rate = 16000;
  let ch = 1;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      ch = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
    } else if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error("wav data 없음");
  const n = Math.floor(data.length / 2 / ch);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2);
    mono[i] = s / ch;
  }
  if (rate === SR) return Int16Array.from(mono);
  const m = Math.floor((n * SR) / rate);
  const out = new Int16Array(m);
  for (let i = 0; i < m; i++) {
    const x = (i * rate) / SR;
    const k = Math.floor(x);
    const f = x - k;
    out[i] = Math.round(mono[k] * (1 - f) + (mono[Math.min(k + 1, n - 1)] ?? 0) * f);
  }
  return out;
}

async function main() {
  const wav = readWav(fs.readFileSync(WAV));
  const turnsPath = WAV.replace(/\.wav$/, ".turns.json");
  const turns: { speaker: string; t0: number; t1: number; text: string }[] = fs.existsSync(turnsPath) ? JSON.parse(fs.readFileSync(turnsPath, "utf8")) : [];
  const FREE = turns.length === 0 || flag("free"); // 실제 녹음(대본 없음) 또는 --free: 시나리오 A 채점 대신 수만 센다

  // ── 두뇌 ──
  const fake = FAKE ? await startFakeBrain() : null;
  const BRAIN = fake?.url ?? opt("brain", `http://127.0.0.1:${process.env.PORT ?? 3107}`)!;
  let spaceId = opt("space", "")!;
  if (!spaceId && !FAKE) {
    const now = new Date();
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`; // npm run meeting과 같은 현지 날짜
    const dbPath = process.env.GALPI_DB_PATH ?? path.join("data", `meeting-${day}.db`);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT id, name FROM spaces ORDER BY created_at").all() as { id: string; name: string }[];
    spaceId = (rows.find((r) => r.name.includes("5조")) ?? rows[0])?.id ?? "";
    db.close();
  }
  const plain: StartMeetingReq = FREE
    ? {
        spaceId,
        title: opt("title", `실제 녹음 E2E — ${path.basename(WAV)}`)!,
        participants: opt("participants", "기헌,준영,태은,지호")!.split(","),
        intensity: (opt("intensity", "mid") as StartMeetingReq["intensity"])!,
        agenda: [{ title: opt("title", "회의")!, expected: [] }],
      }
    : {
        spaceId,
        title: "회의 4 — 대회 준비 (E2E)",
        participants: ["기헌", "준영", "태은", "지호"],
        intensity: "high",
        agenda: [
          { title: "시연 영상 구성", expected: ["장면 순서 확정"] },
          { title: "디스코드 연동 범위", expected: ["이번에 만들 범위 결정"] },
          { title: "리허설", expected: ["날짜", "담당자"] },
        ],
      };
  const setup = withHostMode(plain, { host: opt("host"), mode: opt("mode", "decision") as MeetingMode, roles: parseRoles(opt("roles")), participation: opt("participation") ? Number(opt("participation")) : undefined });
  if (!FAKE) {
    const docs = (await fetch(`${BRAIN}/api/live/docs?spaceId=${encodeURIComponent(spaceId)}`).then((r) => (r.ok ? r.json() : []))) as { id: string; path: string }[];
    const plan = docs.find((d) => d.path?.includes("current-plan"));
    if (plan) setup.docIds = [plan.id];
  }
  const t0 = Date.now();
  const sr = await fetch(`${BRAIN}/api/live/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(setup) });
  if (!sr.ok) throw new Error(`/api/live/start ${sr.status}: ${await sr.text()}`);
  const { meetingId, controlToken } = (await sr.json()) as { meetingId: string; controlToken?: string };
  console.log(`회의 ${meetingId} · 두뇌 ${FAKE ? "가짜" : BRAIN} · 음성 ${VOICE} · ${WAV}${ECHO ? " · 에코 섞음" : ""}${WAIT ? "" : " · 안 기다림"}`);

  // ── 소리: "재생"은 마이크 입력 쪽 섞개에 넣고, 실제 시간만큼 흘려 보낸다 ─────────
  let echoQ: Int16Array[] = [];
  let echoDone: (() => void) | null = null;
  const nodeAudio: AudioOut = {
    play(w) {
      let stopped = false;
      let finish!: (ok: boolean) => void;
      const done = new Promise<boolean>((r) => (finish = r));
      (async () => {
        const secs = await wavSeconds(w);
        if (ECHO) {
          const pcm = readWav(Buffer.from(await w.arrayBuffer()));
          // 노트북 스피커 → 마이크로 돌아온 소리: 작게, 0.03초 늦게
          const q = new Int16Array(pcm.length + 480);
          for (let i = 0; i < pcm.length; i++) q[i + 480] = Math.round(pcm[i] * 0.35);
          echoQ = [q];
          echoDone = () => !stopped && finish(true);
        } else setTimeout(() => !stopped && finish(true), secs * 1000);
      })();
      return {
        done,
        stop: () => {
          stopped = true;
          echoQ = [];
          finish(false);
        },
      };
    },
  };

  // ── 기록 ──
  type Rec = { at: number; kind: string; data?: unknown };
  const log: Rec[] = [];
  let state: LiveState = initState(setup.intensity);
  const dispatch = (a: LiveAction) => (state = reduce(state, a));
  let sentSamples = 0;
  let enrollSamples = 0; // 회의 전 등록으로 보낸 소리 (음성 서버 시계엔 들어간다)
  const wavPosAt: number[] = []; // 음성 서버가 받은 묶음 번호 → 그 묶음이 wav의 어디였나 (-1: 등록·기다림)
  let lastFinalAt = 0;
  let meetySpoke = 0; // 미티가 소리를 낸 횟수
  let lastSpeechEndAt = 0;
  const audioAt: number[] = []; // 보낸 오디오 0.1초마다의 벽시계 (말 끝 시각 → 벽시계)
  const client = new LiveClient({
    meetingId,
    token: controlToken,
    brain: BRAIN,
    voiceUrl: VOICE,
    dispatch,
    openStream: fetchStream(fetch),
    audio: nodeAudio,
    participants: setup.participants,
    trace: (kind, data) => {
      const at = Date.now() - t0;
      log.push({ at, kind, data });
      const t = (data as { type?: string })?.type;
      if (kind === "voice" && t === "final") lastFinalAt = at;
      if (kind === "voice" && t === "speech_end") lastSpeechEndAt = at;
      if (kind === "first_sound") meetySpoke++;
    },
  });
  client.connectStream();
  await client.connectVoice();
  if (state.conn.voice !== "on") throw new Error(`음성 서버에 못 붙었어요: ${VOICE}`);
  // ── 화자 등록 (화면의 목소리 등록과 같은 순서: 이름 → 말하기 → 말이 멎은 뒤 끝) ──
  const enrollRes: { name: string; ok: boolean; seconds?: number; message?: string; ms: number }[] = [];
  if (flag("enroll")) {
    const ew = readWav(fs.readFileSync("voice/recordings/enroll.wav"));
    const et: { speaker: string; t0: number; t1: number }[] = JSON.parse(fs.readFileSync("voice/recordings/enroll.turns.json", "utf8"));
    for (const t of et) {
      const t1 = Date.now();
      client.enroll(t.speaker, true); // 시험 도구가 화면 확인을 대신 누른 것으로
      // 그 사람 말만 + 1초 조용함 (다음 사람 말이 섞이면 말이 안 끝나서 다음 사람 것까지 한 사람으로 등록된다)
      const voice = ew.subarray(Math.round((t.t0 - 0.2) * SR), Math.round((t.t1 + 0.05) * SR));
      const part = new Int16Array(voice.length + SR);
      part.set(voice);
      for (let k = 0; k < part.length; k += CH) {
        const c = new Int16Array(CH);
        c.set(part.subarray(k, k + CH));
        client.sendPcm(c.buffer);
        wavPosAt.push(-1);
        enrollSamples += CH;
        await new Promise((r) => setTimeout(r, (CH / SR) * 1000));
      }
      client.enroll(null);
      for (let i = 0; i < 40 && !state.enrolled[t.speaker]; i++) await new Promise((r) => setTimeout(r, 100));
      const r = state.enrolled[t.speaker];
      enrollRes.push({ name: t.speaker, ok: !!r?.ok, seconds: r?.seconds, message: r?.message, ms: Date.now() - t1 });
      console.log(`등록 ${t.speaker}: ${r?.ok ? `${r.seconds?.toFixed?.(1) ?? r.seconds}초` : (r?.message ?? "응답 없음")}`);
    }
  }
  client.begin({ save: flag("save") });

  // ── 자원: 음성 서버·앱 프로세스의 메모리(RSS)·CPU를 10초마다 ──
  const { execSync } = await import("node:child_process");
  const portOf = (u: string) => new URL(u.replace(/^ws/, "http")).port;
  const pidsOn = (port: string) => {
    try {
      return execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`).toString().trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const watch = { voice: pidsOn(portOf(VOICE)), app: FAKE ? [] : pidsOn(portOf(BRAIN)) };
  // sent: 지금까지 보낸 소리(초). 서버 이벤트의 t와 견주면 멎은 쪽이 클라이언트인지 서버인지 갈린다 (71분 E2E 43분 버그)
  const usage: { at: number; sent: number; voice?: { rss: number; cpu: number }; app?: { rss: number; cpu: number } }[] = [];
  const sample = () => {
    const one = (pids: string[]) => {
      if (!pids.length) return undefined;
      try {
        const rows = execSync(`ps -o rss=,pcpu= -p ${pids.join(",")}`).toString().trim().split("\n");
        return rows.reduce((a, r) => {
          const [rss, cpu] = r.trim().split(/\s+/).map(Number);
          return { rss: a.rss + rss / 1024, cpu: a.cpu + cpu };
        }, { rss: 0, cpu: 0 });
      } catch {
        return undefined; // 죽었다
      }
    };
    usage.push({ at: Date.now() - t0, sent: Math.round(sentSamples / SR), voice: one(watch.voice), app: one(watch.app) });
  };
  sample();
  const sampler = setInterval(sample, 10_000);

  // ── 흘려 보내기 ──
  const turnStart = turns.map((t) => Math.max(0, Math.round((t.t0 - 0.15) * SR)));
  // 미티 말에 대답하는 줄("아 맞다, 고마워…")은 미티가 말을 마친 뒤에야 나온다 (대본의 인과). 최대 12초 기다림
  const repliesToMeety = turns.map((t) => /고마워|맞아요, 세 단계/.test(t.text));
  let pos = 0;
  let nextTurn = 0;
  let holdUntil = 0;
  let held = 0;
  const start = performance.now();
  const tail = Math.round(3 * SR);
  while (pos < wav.length + tail) {
    const speakingOrPending = ["speaking", "has_something"].includes(meetyMode(state)) || client.isSpeaking();
    // 다음 사람이 말을 시작하려는 순간: 미티가 할 말이 있거나 말하는 중이면 기다린다 (최대 10초)
    if (WAIT && nextTurn < turnStart.length && pos >= turnStart[nextTurn]) {
      // 사람은 앞사람 말이 끝나면 한 박자 쉰다: 앞 말이 받아써질 때까지(최대 2초) + 미티가 할 말이 있거나 말하는 중이면 끝날 때까지(최대 30초)
      const beat = held < 2 * SR && (state.talking || lastFinalAt < lastSpeechEndAt || Date.now() - t0 - lastFinalAt < 300);
      const reply = repliesToMeety[nextTurn] && meetySpoke === 0 && held < 12 * SR;
      if ((speakingOrPending && held < 30 * SR) || beat || reply) holdUntil = Infinity;
      else {
        if (holdUntil === Infinity) holdUntil = sentSamples + Math.round(0.5 * SR); // 미티 말이 끝나고 0.5초 뒤 이어 말한다
        if (sentSamples >= holdUntil) {
          nextTurn++;
          held = 0;
          holdUntil = 0;
        }
      }
    }
    const holding = WAIT && nextTurn < turnStart.length && pos >= turnStart[nextTurn];
    const chunk = new Int16Array(CH);
    if (!holding) {
      chunk.set(wav.subarray(pos, Math.min(pos + CH, wav.length)));
      pos += CH;
    } else held += CH;
    // 에코 섞기
    if (echoQ.length) {
      const q = echoQ[0];
      const n = Math.min(CH, q.length);
      for (let i = 0; i < n; i++) chunk[i] = Math.max(-32768, Math.min(32767, chunk[i] + q[i]));
      echoQ[0] = q.subarray(n);
      if (!echoQ[0].length) {
        echoQ = [];
        (echoDone as (() => void) | null)?.();
      }
    }
    client.sendPcm(chunk.buffer);
    wavPosAt.push(holding ? -1 : pos - CH);
    sentSamples += CH;
    while (audioAt.length <= Math.floor(sentSamples / 1600)) audioAt.push(Date.now() - t0);
    const wait = start + (sentSamples / SR) * 1000 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  // 남은 받아쓰기·말하기가 끝나길
  for (let i = 0; i < 40 && (client.isSpeaking() || meetyMode(state) === "has_something"); i++) await new Promise((r) => setTimeout(r, 250));
  // 손 든 건 그대로 두고 회의 끝
  const endAt = Date.now() - t0;
  const res = await client.end();
  for (let i = 0; i < 120 && !state.checklist.length; i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 500));
  client.close();
  await fake?.close();

  clearInterval(sampler);
  sample();
  if (FREE) {
    await freeReport({ log, t0, meetingId, controlToken, BRAIN, res: usage, watch, endAt, state, setup });
    process.exit(0);
  }

  // ── 채점: 시나리오 [미티 기대] ─────────────────────────────
  const voice = log.filter((l) => l.kind === "voice").map((l) => ({ at: l.at, ev: l.data as VoiceEvent }));
  const agent = log.filter((l) => l.kind === "agent").map((l) => ({ at: l.at, ev: l.data as AgentEvent }));
  const finals = voice.filter((v) => v.ev.type === "final") as { at: number; ev: Extract<VoiceEvent, { type: "final" }> }[];
  const finalOf = (re: RegExp) => finals.find((f) => re.test(f.ev.text.replace(/\s/g, "")));
  const agentBetween = (from: number, to: number) => agent.filter((a) => a.at >= from && a.at < to);
  const nextFinalAt = (at: number) => finals.find((f) => f.at > at + 50)?.at ?? endAt;
  type Check = { name: string; ok: boolean; note: string };
  const checks: Check[] = [];
  const expectAfter = (name: string, re: RegExp, want: (evs: AgentEvent[]) => string | true, late = true) => {
    const f = finalOf(re);
    if (!f) return checks.push({ name, ok: false, note: "받아쓰기에서 그 말을 못 찾음" });
    // 그 말 뒤 ~ 그다음 사람 말까지 (안 기다리는 모드면 +3초: 미티가 다음 말보다 늦을 수 있다)
    const evs = agentBetween(f.at, nextFinalAt(f.at) + (WAIT || !late ? 0 : 3000)).map((a) => a.ev);
    const r = want(evs);
    checks.push({ name, ok: r === true, note: r === true ? `"${f.ev.text}" → ${evs.map((e) => e.type).join(", ") || "없음"}` : r });
  };
  const speaks = (evs: AgentEvent[]) => evs.filter((e) => e.type === "speak") as Extract<AgentEvent, { type: "speak" }>[];
  const earlyCard = (re: RegExp) => {
    // 합의 말보다 먼저(제안 때) 카드가 나왔는지
    const f = finalOf(re);
    const prev = f && [...finals].reverse().find((x) => x.at < f.at);
    return f && prev && agentBetween(prev.at, f.at).some((a) => a.ev.type === "change_card") ? ` (카드가 합의 ${((f.at - agentBetween(prev.at, f.at).find((a) => a.ev.type === "change_card")!.at) / 1000).toFixed(1)}초 전, 제안 때 나옴)` : "";
  };
  expectAfter("영상 순서 합의 → 바뀐 것 카드, 말 안 함", /순서로가자/, (evs) => (evs.some((e) => e.type === "change_card") ? (speaks(evs).length ? "말을 해 버림" : true) : `change_card 없음${earlyCard(/순서로가자/)}`), false);
  const heard = (id: string) => log.some((l) => l.kind === "first_sound" && (l.data as { actionId: string }).actionId === id);
  expectAfter("디스코드 봇 → 강도 상이라 말로 짚음(conflict, 실제로 소리 냄)", /디스코드.*(입구|임팩트)/, (evs) => {
    const c = speaks(evs).filter((s) => s.kind === "conflict");
    if (!c.length) return "conflict speak 없음";
    return c.some((s) => heard(s.actionId)) ? true : "speak는 왔지만 소리를 못 냄 (사람이 말하는 중이라 기다리다 취소)";
  });
  expectAfter("'미티야 끼어들지 마' → 강도 하 + 짧은 대답", /끼어들/, (evs) => {
    const st = evs.find((e) => e.type === "settings") as Extract<AgentEvent, { type: "settings" }> | undefined;
    if (st?.intensity !== "low") return "settings low 없음";
    return speaks(evs).some((s) => s.kind === "ack") ? true : "ack speak 없음 (강도는 바뀜)";
  });
  expectAfter("봇은 알림만 → 바뀐 것 카드, 말 안 함", /그걸로하자/, (evs) => (evs.some((e) => e.type === "change_card") ? (speaks(evs).length ? "말을 해 버림" : true) : "change_card 없음"), false);
  expectAfter("붙여넣기만 → 손만 듦 (강도 하)", /붙여넣기만/, (evs) => (evs.some((e) => e.type === "hand_raise") ? (speaks(evs).length ? "손 들고 말도 함" : true) : "hand_raise 없음"), false);
  const final = state.checklist;
  const st = (exp: string) => final.find((c) => c.expected.includes(exp))?.status;
  checks.push({
    name: "회의 끝 체크리스트 (영상·디스코드·날짜 done, 담당 no_owner)",
    ok: st("장면 순서") === "done" && st("범위") === "done" && st("날짜") === "done" && st("담당") === "no_owner",
    note: final.map((c) => `${c.expected}:${c.status}`).join(", ") || "없음",
  });
  const allSpeaks = agent.filter((a) => a.ev.type === "speak").map((a) => a.ev as Extract<AgentEvent, { type: "speak" }>);
  checks.push({ name: "말로 끼어든 횟수 (기대: conflict 1 + ack 1)", ok: allSpeaks.filter((s) => s.kind === "conflict").length === 1, note: allSpeaks.map((s) => s.kind).join(", ") });
  checks.push({ name: "회의 끝 → 정리 회의 sessionId", ok: !!res.sessionId, note: res.sessionId ?? "없음" });
  const wavTimeOf = (serverT: number) => {
    for (let i = Math.floor((serverT * SR) / CH); i < wavPosAt.length; i++) if (wavPosAt[i] >= 0) return wavPosAt[i] / SR;
    return NaN;
  };
  if (enrollRes.length) {
    // 받아쓴 말의 화자가 대본(turns)의 화자와 맞는지: final 시각(t0)이 가장 많이 겹치는 turn과 견준다
    // 등록하며 읽은 말(회의 전, 두뇌에 안 넘김)은 빼고 회의 중 말만
    const human = finals.filter((f) => f.ev.text.trim() && !f.ev.echo && f.ev.t0 >= enrollSamples / SR);
    let hit = 0;
    const rows = human.map((f) => {
      const want = turns.find((t) => Math.abs(t.t0 - wavTimeOf(f.ev.t0)) < 1.2)?.speaker;
      if (want && f.ev.speaker === want) hit++;
      return `${f.ev.speaker ?? "?"}/${want ?? "?"}`;
    });
    checks.push({ name: `목소리 등록 4명 → 받아쓰기 화자 이름 (${hit}/${human.length} 맞음)`, ok: enrollRes.every((e) => e.ok) && hit >= human.length - 2, note: `등록 ${enrollRes.map((e) => `${e.name}${e.ok ? "✓" : "✗"}`).join(" ")} · 붙은/정답 ${rows.join(", ")}` });
  }

  // ── 지연: 말 끝 → 미티 첫 소리 (말한 것마다) ──────────────────────
  const firsts = log.filter((l) => l.kind === "first_sound");
  const lat = allSpeaks.map((s) => {
    const spoke = agent.find((a) => a.ev === s)!;
    // 이 말을 낳은 사람 말: speak 직전의 final
    const trig = [...finals].reverse().find((f) => f.at <= spoke.at);
    const endWall = trig ? (audioAt[Math.round((trig.ev.t1 - enrollSamples / SR) * 10)] ?? trig.at) : NaN;
    const queued = agent.find((a) => a.ev.type === "queued" && a.ev.actionId === s.actionId)?.at;
    const prepare = agent.find((a) => a.ev.type === "prepare" && a.ev.actionId === s.actionId)?.at;
    const first = firsts.find((f) => (f.data as { actionId: string }).actionId === s.actionId)?.at;
    const tts = log.find((l) => l.kind === "tts_ready" && l.at >= spoke.at && (l.data as { text: string }).text === s.sentences[0]);
    return {
      kind: s.kind,
      trigger: trig?.ev.text ?? "?",
      transcribe: trig ? trig.at - endWall : NaN, // 말 끝 → final 받음
      judge: trig ? spoke.at - trig.at : NaN, // final → speak 받음 (gap 기다림 포함)
      queued: queued != null && trig ? queued - trig.at : null,
      prepare: prepare != null && trig ? prepare - trig.at : null,
      tts: first != null ? first - spoke.at : NaN, // speak → 첫 문장 소리 준비
      ttsServer: (tts?.data as { ms?: number })?.ms ?? null,
      total: first != null ? first - endWall : NaN, // 말 끝 → 첫 소리
    };
  });
  const echoDropped = log.filter((l) => l.kind === "echo_dropped").length;
  const bargeIns = voice.filter((v) => v.ev.type === "barge_in").length;
  const echoFinals = finals.filter((f) => f.ev.echo).length;

  // ── 쓰기 ──
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const tag = `A-${FAKE ? "fake" : "live"}${ECHO ? "-echo" : ""}${WAIT ? "" : "-nowait"}${flag("enroll") ? "-enroll" : ""}`;
  const dir = path.join("tests", "e2e", "results");
  fs.mkdirSync(dir, { recursive: true });
  const ms = (n: number | null) => (n == null || Number.isNaN(n) ? "–" : `${Math.round(n)}`);
  const md = [
    `# E2E ${tag} — ${stamp}`,
    "",
    `두뇌: ${FAKE ? "가짜(tests/e2e/fake-brain.ts, 판단 0ms)" : BRAIN} · 음성 서버: ${VOICE} (진짜 받아쓰기) · 입력: ${WAV}${ECHO ? " + 미티 소리 에코(0.35배)" : ""} · 사람들이 미티를 ${WAIT ? "기다려 줌" : "안 기다림"}`,
    "",
    `## 기대 행동 ${checks.filter((c) => c.ok).length}/${checks.length}`,
    "",
    "| | 기대 | 결과 |",
    "| --- | --- | --- |",
    ...checks.map((c) => `| ${c.ok ? "✅" : "❌"} | ${c.name} | ${c.note.replace(/\|/g, "/")} |`),
    "",
    "## 말 끝 → 미티 첫 소리 (ms)",
    "",
    "| 말 | 계기 | 받아쓰기(말 끝→final) | 판단(final→speak) | queued | prepare | TTS(speak→첫 소리) | TTS 서버 | **합계** |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...lat.map((l) => `| ${l.kind} | ${l.trigger.slice(0, 24)} | ${ms(l.transcribe)} | ${ms(l.judge)} | ${ms(l.queued)} | ${ms(l.prepare)} | ${ms(l.tts)} | ${ms(l.ttsServer)} | **${ms(l.total)}** |`),
    "",
    `에코: echo 표시된 final ${echoFinals}개 · 미티 자기 소리라 두뇌에 안 넘긴 것 ${echoDropped}개 · barge_in ${bargeIns}번`,
    "",
    "## 받아쓰기",
    "",
    ...finals.map((f) => `- [${(f.at / 1000).toFixed(1)}s] ${f.ev.speaker ?? "?"}${f.ev.echo ? " (echo)" : ""}: ${f.ev.text}`),
    "",
    "## 미티 이벤트",
    "",
    ...agent.filter((a) => a.ev.type !== "latency").map((a) => `- [${(a.at / 1000).toFixed(1)}s] ${a.ev.type} ${JSON.stringify(a.ev).slice(0, 160)}`),
  ].join("\n");
  fs.writeFileSync(path.join(dir, `${tag}-${stamp}.md`), md + "\n");
  fs.writeFileSync(path.join(dir, `${tag}-${stamp}.json`), JSON.stringify({ tag, checks, lat, echoFinals, echoDropped, bargeIns, log }, null, 1));
  console.log(md.split("## 받아쓰기")[0]);
  console.log(`→ ${path.join(dir, `${tag}-${stamp}.md`)}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

// ── 자유 모드 결과 ─────────────────────────────────────────
// 글자만 남기기 (띄어쓰기·문장부호 무시)
const norm = (t: string) => t.replace(/\[\?\]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
// **[mm:ss] 이름:** 말  /  **이름:** 말(앞 시각을 이어 씀)  /  이어지는 문단
function readRef(file: string): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  let t = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\*\*(?:\[(\d+):(\d+)(?::(\d+))?\]\s*)?[^*]*:\*\*\s*(.*)$/);
    if (m) {
      if (m[1]) t = m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
      out.push({ t, text: m[4] });
    } else if (out.length && line.trim() && !line.startsWith("#") && !line.startsWith("- ")) out[out.length - 1].text += " " + line.trim();
  }
  return out;
}
// 정답 쪽 끝을 모를 때: 받아쓴 것 전체(h)를 정답의 앞부분 r[0..j]와 맞추고 오류가 가장 적은 j를 고른다
// (보정 전사는 문단마다 시각이 하나라 "15분까지"가 어디인지 시각으로는 못 자른다)
function prefixAlign(h: string, r: string): { d: number; j: number } {
  // 시작은 r[0]으로 고정, 끝만 자유
  let prev = new Uint32Array(r.length + 1).map((_, j) => j);
  let cur = new Uint32Array(r.length + 1);
  for (let i = 1; i <= h.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= r.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (h[i - 1] === r[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  let best = { d: Infinity, j: 0 };
  // 너무 짧은 앞부분을 고르지 않게, 오류율(d/j)이 가장 낮은 끝을 고른다
  for (let j = Math.floor(h.length / 2); j <= r.length; j++) if (prev[j] / j < best.d / Math.max(best.j, 1) || best.j === 0) best = { d: prev[j], j };
  return best;
}
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};

async function freeReport(o: {
  log: { at: number; kind: string; data?: unknown }[];
  t0: number;
  meetingId: string;
  controlToken?: string;
  BRAIN: string;
  res: { at: number; voice?: { rss: number; cpu: number }; app?: { rss: number; cpu: number } }[];
  watch: { voice: string[]; app: string[] };
  endAt: number;
  state: LiveState;
  setup: StartMeetingReq;
}) {
  const voice = o.log.filter((l) => l.kind === "voice").map((l) => ({ at: l.at, ev: l.data as VoiceEvent }));
  const agent = o.log.filter((l) => l.kind === "agent").map((l) => ({ at: l.at, ev: l.data as AgentEvent }));
  const finals = voice.filter((v) => v.ev.type === "final" && (v.ev as { text: string }).text.trim()) as { at: number; ev: Extract<VoiceEvent, { type: "final" }> }[];
  const count = (t: string) => agent.filter((a) => a.ev.type === t).length;
  // 받아쓰기 지연: speech_end 받음 → 같은 id final 받음
  const endAt = new Map<number, number>();
  for (const v of voice) if (v.ev.type === "speech_end") endAt.set(v.ev.id, v.at);
  const sttLag = finals.map((f) => f.at - (endAt.get(f.ev.id) ?? f.at)).filter((x) => x >= 0);
  const brainLat = agent.filter((a) => a.ev.type === "latency").map((a) => a.ev as Extract<AgentEvent, { type: "latency" }>);
  const byRole = (r: string) => brainLat.filter((l) => l.role === r).map((l) => l.ms);
  // 비용 (두뇌 확인용 상태, 회의 열쇠 필요)
  let cost: number | null = null;
  try {
    const st = await fetch(`${o.BRAIN}/api/live/${encodeURIComponent(o.meetingId)}/state`, { headers: o.controlToken ? { "x-live-token": o.controlToken } : {} }).then((r) => r.json());
    cost = typeof st.cost === "number" ? st.cost : null;
  } catch {
    /* 가짜 두뇌 */
  }
  // 받아쓰기 오류율: 흘린 구간 전체를 한 번에 견준다. 보정 전사는 긴 문단마다 시각이 하나라(00:42 문단이 몇 분짜리) 5분 창으로 자르면 어긋난다.
  // 끝은 흘린 길이까지 시작한 문단만 (마지막 문단이 넘쳐 들어가면 그만큼 오류로 잡힌다), 맞장구는 정답에 거의 없어서 받아쓴 쪽이 더 길다
  const cerRows: string[] = [];
  let cer = NaN;
  const refFile = opt("ref");
  if (refFile) {
    const ref = readRef(refFile);
    const dur = Math.max(...finals.map((f) => f.ev.t1), 0);
    // 흘린 길이 + 10분 안에서 시작한 문단까지 후보로 두고, 내용으로 끝을 찾는다
    const r = norm(ref.filter((x) => x.t < dur + 600).map((x) => x.text).join(""));
    const h = norm(finals.map((f) => f.ev.text).join(""));
    if (r.length && h.length) {
      const { d, j } = prefixAlign(h, r);
      cer = d / j;
      cerRows.push(`| 0~${Math.round(dur / 60)}분 (정답 앞 ${j}글자와 맞춤) | ${j} | ${h.length} | ${(cer * 100).toFixed(1)}% |`);
    }
  }
  const alive = (pids: string[]) => pids.length > 0 && pids.every((p) => {
    try {
      process.kill(+p, 0);
      return true;
    } catch {
      return false;
    }
  });
  const maxOf = (k: "voice" | "app", f: "rss" | "cpu") => Math.max(...o.res.map((r) => r[k]?.[f] ?? 0));
  const avgOf = (k: "voice" | "app", f: "cpu") => {
    const xs = o.res.map((r) => r[k]?.[f]).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };
  const r0 = (n: number) => (Number.isFinite(n) ? Math.round(n) : "–");
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const tag = `${path.basename(WAV, ".wav")}-${FAKE ? "fake" : "live"}`;
  const speaks = agent.filter((a) => a.ev.type === "speak").map((a) => a.ev as Extract<AgentEvent, { type: "speak" }>);
  const hands = agent.filter((a) => a.ev.type === "hand_raise").map((a) => a.ev as Extract<AgentEvent, { type: "hand_raise" }>);
  const md = [
    `# 실제 녹음 E2E ${tag} — ${stamp}`,
    "",
    `입력: ${WAV} (${((o.endAt) / 60000).toFixed(1)}분 흘림, 실제 속도) · 두뇌: ${FAKE ? "가짜" : o.BRAIN} · 음성 서버: ${VOICE} · 강도 ${o.setup.intensity} · 참석자 힌트 ${o.setup.participants?.join(", ")} · 자료 ${o.setup.docIds?.join(", ") ?? "없음"}`,
    "",
    "## 결과",
    "",
    "| 잰 것 | 값 | 기대 |",
    "| --- | --- | --- |",
    `| 미티가 말함 (speak) | ${speaks.length} (${speaks.map((s) => s.kind).join(", ") || "-"}) | 0 (확정 결정과 어긋난 말이 없는 회의) |`,
    `| 손 듦 (hand_raise) | ${hands.length} | 0 |`,
    `| 할 말 대기 (queued) | ${count("queued")} | 0 |`,
    `| 바뀐 것 카드 (change_card) | ${count("change_card")} | (참고) |`,
    `| barge_in (미티가 말 안 하는데 나온 것 = 거짓) | ${voice.filter((v) => v.ev.type === "barge_in").length} | 0 |`,
    `| 받아쓴 말 (final, 빈 것 빼고) | ${finals.length} | |`,
    `| 받아쓰기 글자 오류율 (보정 전사 기준) | ${Number.isFinite(cer) ? (cer * 100).toFixed(1) + "%" : "–"} | |`,
    `| 받아쓰기 지연 speech_end→final p50 / p90 / 최대 (ms) | ${r0(pct(sttLag, 0.5))} / ${r0(pct(sttLag, 0.9))} / ${r0(Math.max(...sttLag, 0))} | |`,
    `| 두뇌 감시(watch) 판단 p50 / p90 (ms) | ${r0(pct(byRole("watch"), 0.5))} / ${r0(pct(byRole("watch"), 0.9))} (${byRole("watch").length}번) | |`,
    `| 두뇌 비용 (회의 중) | ${cost == null ? "–" : "$" + cost.toFixed(4)} | |`,
    `| 음성 서버 메모리 최대 / CPU 평균·최대 | ${r0(maxOf("voice", "rss"))} MB / ${r0(avgOf("voice", "cpu"))}%·${r0(maxOf("voice", "cpu"))}% | |`,
    `| 앱(Next) 메모리 최대 / CPU 평균·최대 | ${r0(maxOf("app", "rss"))} MB / ${r0(avgOf("app", "cpu"))}%·${r0(maxOf("app", "cpu"))}% | |`,
    `| 끝까지 살아 있음 (음성 / 앱) | ${alive(o.watch.voice) ? "예" : "아니오"} / ${FAKE ? "-" : alive(o.watch.app) ? "예" : "아니오"} | 예 |`,
    `| 회의 끝 정리 회의 | ${o.state.sessionId ?? "–"} | |`,
    "",
    ...(cerRows.length ? ["## 받아쓰기 오류율 (흘린 구간 전체)", "", "| 구간 | 정답 글자 | 받아쓴 글자 | 오류율 |", "| --- | --- | --- | --- |", ...cerRows, ""] : []),
    "## 미티 이벤트 (latency 빼고)",
    "",
    ...agent.filter((a) => a.ev.type !== "latency").map((a) => `- [${(a.at / 1000).toFixed(1)}s] ${a.ev.type} ${JSON.stringify(a.ev).slice(0, 200)}`),
    "",
    "## 자원 (10초마다)",
    "",
    "| 시각(초) | 음성 MB | 음성 CPU% | 앱 MB | 앱 CPU% |",
    "| --- | --- | --- | --- | --- |",
    ...o.res.filter((_, i) => i % 6 === 0 || i === o.res.length - 1).map((r) => `| ${Math.round(r.at / 1000)} | ${r0(r.voice?.rss ?? NaN)} | ${r0(r.voice?.cpu ?? NaN)} | ${r0(r.app?.rss ?? NaN)} | ${r0(r.app?.cpu ?? NaN)} |`),
    "",
    "## 받아쓰기 (처음 40개)",
    "",
    ...finals.slice(0, 40).map((f) => `- [${f.ev.t0.toFixed(0)}s] ${f.ev.speaker ?? "?"}${f.ev.echo ? " (echo)" : ""}: ${f.ev.text}`),
  ].join("\n");
  const dir = path.join("tests", "e2e", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${tag}-${stamp}.md`), md + "\n");
  fs.writeFileSync(path.join(dir, `${tag}-${stamp}.json`), JSON.stringify({ tag, cer, sttLag, res: o.res, agent: agent.map((a) => ({ at: a.at, ev: a.ev })), finals: finals.map((f) => f.ev) }, null, 1));
  console.log(md.split("## 받아쓰기 오류율")[0].split("## 미티 이벤트")[0]);
  console.log(`→ ${path.join(dir, `${tag}-${stamp}.md`)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
