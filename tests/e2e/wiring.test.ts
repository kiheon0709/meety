// 배선 시험 (모델·GPU 없음): 음성 서버가 실제로 낸 시나리오 A 이벤트(S2 녹화)를 10배 빠르게 흘리고,
// 화면과 같은 LiveClient가 계약대로 두뇌(가짜)·음성 서버(가짜)와 주고받는지 본다.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { VoiceEvent } from "../../src/lib/live/contract";
import { LiveClient, fetchStream, overlap, silentAudio } from "../../src/components/live/client";
import { initState, reduce, type LiveAction, type LiveState } from "../../src/components/live/state";
import { startFakeBrain } from "./fake-brain";

const SCALE = 0.1; // 녹화 1초 → 0.1초
const VOICE = "ws://voice.test/ws";
const recorded = fs
  .readFileSync(path.join(__dirname, "fixtures", "A-voice-events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as VoiceEvent & { recv: number });
// 스피커로 나간 미티 첫 문장이 마이크로 다시 들어온 것 (echo)
const OWN_ECHO = { type: "final", id: 90, t0: 22.0, t1: 22.4, text: "잠깐만요 10월 10일 회의에서 입구는 웹 중심으로", echo: true, recv: 22.45 } as const;

// 음성 서버 흉내: start를 받으면 녹화 이벤트를 시각대로 보낸다
const sockets: FakeSocket[] = [];
class FakeSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  done: Promise<void>;
  private finish!: () => void;
  constructor(public url: string) {
    sockets.push(this);
    this.done = new Promise((r) => (this.finish = r));
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 5);
  }
  send(d: string | ArrayBuffer) {
    if (typeof d !== "string") return;
    const m = JSON.parse(d);
    this.sent.push(m);
    if (m.type === "start" && this.sent.length === 1) this.replay();
  }
  private replay() {
    const evs = [...recorded, OWN_ECHO].sort((a, b) => a.recv - b.recv);
    for (const e of evs) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { recv, audio, ...ev } = e as typeof e & { audio?: number };
      setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify(ev) }), recv * 1000 * SCALE);
    }
    setTimeout(() => this.finish(), (evs.at(-1)!.recv + 1) * 1000 * SCALE);
  }
  close() {
    this.readyState = 3;
  }
}

// 0.25초짜리 조용한 wav
function wav(sec = 0.25) {
  const n = Math.round(16000 * sec);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

describe("실제 연결 배선 (가짜 두뇌 + 녹화된 음성 이벤트)", () => {
  let brain: Awaited<ReturnType<typeof startFakeBrain>>;
  let state: LiveState = initState("high");
  const voiceHttp: { path: string; body: unknown }[] = [];
  const trace: { kind: string; data: unknown; at: number }[] = [];
  let client: LiveClient;
  let endRes: { sessionId?: string } = {};

  beforeAll(async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    brain = await startFakeBrain();
    // 브라우저처럼: fetch를 다른 객체의 메서드로 부르면 "Illegal invocation" (노드는 안 따져서 놓쳤던 버그)
    const f = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      const u = String(input);
      if (u.startsWith("http://voice.test")) {
        voiceHttp.push({ path: new URL(u).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return u.endsWith("/tts") ? new Response(new Blob([new Uint8Array(wav())], { type: "audio/wav" })) : Response.json({ queued: 1, cached: 0 });
      }
      return fetch(input, init);
    } as typeof fetch;
    // 회의 시작 화면이 하는 일
    const r = await f(`${brain.url}/api/live/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "sp", title: "회의 4", agenda: [], intensity: "high", participants: ["기헌", "준영", "태은", "지호"] }),
    });
    const { meetingId, controlToken } = await r.json();
    const dispatch = (a: LiveAction) => (state = reduce(state, a));
    client = new LiveClient({
      meetingId,
      token: controlToken,
      brain: brain.url,
      voiceUrl: VOICE,
      dispatch,
      openStream: fetchStream(f),
      audio: silentAudio,
      fetch: f,
      participants: ["기헌", "준영", "태은", "지호"],
      quietMs: 300 * SCALE,
      minLeadMs: 0, // 녹화(A-voice-events)는 미티가 예고 없이 바로 말하던 때 것이라 시각이 맞으려면 0. 예고 시간은 client-timing 시험이 본다
      trace: (kind, data) => trace.push({ kind, data, at: Date.now() }),
    });
    client.connectStream();
    await client.connectVoice();
    client.begin({ save: false });
    await sockets[0].done;
    // 손 든 것을 [말해줘]로
    const hand = state.hands.find((h) => h.status === "pending");
    if (hand) client.respond(hand.actionId, true);
    await new Promise((r) => setTimeout(r, 800));
    endRes = await client.end();
    await new Promise((r) => setTimeout(r, 100));
  }, 20_000);

  afterAll(async () => {
    client?.close();
    await brain?.close();
    vi.unstubAllGlobals();
  });

  const posts = (p: string) => brain.calls.filter((c) => c.path.endsWith(`/${p}`));

  it("두뇌 요청마다 회의 열쇠를 붙인다 (POST는 헤더, SSE는 ?token=)", () => {
    const live = brain.calls.filter((c) => /^\/api\/live\/fake-1\//.test(c.path));
    expect(live.length).toBeGreaterThan(20);
    expect(live.every((c) => c.token === "fake-token")).toBe(true);
  });

  it("음성 서버에 참석자 이름을 힌트로 보낸다", () => {
    expect(sockets[0].sent[0]).toEqual({ type: "start", prompt: "기헌, 준영, 태은, 지호", save: false });
  });

  it("final(사람 말)은 모두 utterance로, gap은 모두 gap으로 넘긴다", () => {
    const finals = recorded.filter((e) => e.type === "final");
    const sentIds = posts("utterance").map((c) => (c.body as { id: number }).id);
    expect(sentIds).toEqual(finals.map((f) => (f as { id: number }).id));
    expect(posts("utterance")[0].body).toMatchObject({ id: 1, speaker: "기헌", text: expect.stringContaining("안건") });
    expect(posts("gap").length).toBe(recorded.filter((e) => e.type === "gap").length);
  });

  it("미티 자기 목소리가 다시 들어온 echo는 두뇌에 안 넘기고, 사람이 끼어든 echo는 표시를 달아 넘긴다", () => {
    expect(posts("utterance").some((c) => (c.body as { id: number }).id === 90)).toBe(false);
    expect(posts("utterance").find((c) => (c.body as { id: number }).id === 4)?.body).toMatchObject({ echo: true, text: expect.stringContaining("끼어들") });
    expect(overlap(OWN_ECHO.text, "잠깐만요, 10월 10일 회의에서 입구는 웹 중심으로 하고 디스코드 봇은 2단계로 미루기로 정했어요.")).toBeGreaterThan(0.9);
  });

  it("prepare를 받으면 /tts/prefetch로 미리 굽고, speak면 문장마다 /tts를 받는다", () => {
    const pre = voiceHttp.find((v) => v.path === "/tts/prefetch");
    expect(pre?.body).toMatchObject({ texts: [expect.stringContaining("10월 10일"), expect.any(String)] });
    expect(voiceHttp.filter((v) => v.path === "/tts").length).toBeGreaterThanOrEqual(2);
    expect(voiceHttp.findIndex((v) => v.path === "/tts/prefetch")).toBeLessThan(voiceHttp.findIndex((v) => v.path === "/tts"));
  });

  it("말하는 동안 음성 서버에 tts on을, barge_in이 오면 소리를 끄고 tts off + /barge", () => {
    const tts = sockets[0].sent.filter((m) => (m as { type: string }).type === "tts") as { on: boolean }[];
    // 문장마다 tts on + 읽는 문장 (음성 서버가 스피커 에코를 걸러 낸다)
    expect(tts[0]).toMatchObject({ type: "tts", on: true, text: expect.stringContaining("10월 10일") });
    // 말이 끝나거나 끊기면 꺼진다: on 뒤엔 언젠가 off, 마지막은 off
    expect(tts.at(-1)).toEqual({ type: "tts", on: false });
    expect(tts.filter((t) => !t.on).length).toBeGreaterThanOrEqual(2);
    // playedMs: 첫 소리부터 끊긴 때까지 (두뇌가 2초 미만이면 다시 말한다)
    const barge = posts("barge").find((c) => (c.body as { id: number }).id === 4)?.body as { id: number; playedMs?: number };
    expect(barge).toMatchObject({ id: 4, playedMs: expect.any(Number) });
    expect(barge.playedMs).toBeGreaterThanOrEqual(0);
    expect(state.said.some((s) => s.status === "cut")).toBe(true);
  });

  it("두뇌 이벤트가 화면 상태로 바뀐다: 말로 강도 하, 바뀐 것 카드, 손 듦 → 수락하면 말함", () => {
    expect(state.intensity).toBe("low");
    expect(state.cards.map((c) => c.title)).toEqual(["시연 영상 구성", "디스코드 연동 범위"]);
    expect(posts("respond")[0]?.body).toMatchObject({ accept: true });
    expect(state.hands[0]?.status).toBe("accepted");
  });

  it("회의 끝: /end 응답의 sessionId와 최종 체크리스트", () => {
    expect(endRes.sessionId).toBe("se_fake");
    expect(state.phase).toBe("ended");
    expect(state.sessionId).toBe("se_fake");
    expect(state.checklist.map((c) => c.status)).toEqual(["done", "done", "done", "no_owner"]);
  });
});

describe("끊은 목소리 판정 넘기기", () => {
  it("final.barge(누가 미티를 끊었나)를 utterance에 그대로 붙여 두뇌로 보낸다", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const c = new LiveClient({
      meetingId: "m",
      brain: "http://brain.test",
      voiceUrl: VOICE,
      dispatch: () => {},
      openStream: () => ({ close() {} }),
      audio: silentAudio,
      fetch: (async (url: string, init?: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
        return Response.json({});
      }) as typeof fetch,
    });
    c.forwarding = true;
    c.onVoice({ type: "final", id: 7, t0: 1, t1: 3, text: "잠깐만요 그건", speaker: "기헌", barge: "member" });
    c.onVoice({ type: "final", id: 8, t0: 4, t1: 6, text: "택배 왔어요", barge: "other" });
    c.onVoice({ type: "final", id: 9, t0: 7, t1: 8, text: "네 좋아요" });
    await new Promise((r) => setTimeout(r, 5));
    const utt = sent.filter((x) => x.url.endsWith("/utterance")).map((x) => x.body as { id: number; barge?: string });
    expect(utt.map((u) => [u.id, u.barge])).toEqual([
      [7, "member"],
      [8, "other"],
      [9, undefined],
    ]);
  });
});
