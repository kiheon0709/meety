// 미티 목소리 조각 재생 (S2 /tts/stream, PCM16 조각): 첫 조각이 오면 바로 소리·tts on, 다음 문장은 지금 문장을 다 받은 뒤 부탁,
// 끊으면 받던 소리·건 조각 다 멈춤, /tts/stream이 없는 서버(404)면 /tts wav로
import { describe, expect, it, vi } from "vitest";
import { LiveClient, pcmWav, playPcm, wavSeconds, type AudioOut } from "../../src/components/live/client";
import type { AgentEvent, VoiceClientMsg } from "../../src/lib/live/contract";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 조각을 손으로 밀어 넣는 응답 본문
function pushBody() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c), cancel: () => void (cancelled = true) });
  return { body, push: (b: number[]) => ctl.enqueue(new Uint8Array(b)), end: () => ctl.close(), cancelled: () => cancelled };
}

// 가짜 AudioContext: 건 조각(시작 시각·샘플)을 적어 둔다
function fakeOut() {
  const started: { at: number; data: number[]; stopped: boolean }[] = [];
  const ctx = {
    currentTime: 0,
    createBuffer: (_c: number, n: number, rate: number) => {
      const d = new Float32Array(n);
      return { duration: n / rate, getChannelData: () => d } as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      let rec: (typeof started)[number];
      const s = {
        buffer: null as AudioBuffer | null,
        connect() {},
        start(at: number) {
          started.push((rec = { at, data: [...s.buffer!.getChannelData(0)], stopped: false }));
        },
        stop() {
          rec.stopped = true;
        },
      };
      return s as unknown as AudioBufferSourceNode;
    },
  };
  return { out: { ctx, node: {} as AudioNode }, started };
}

describe("playPcm", () => {
  it("조각을 이어서 건다 — 홀수 바이트는 다음 조각으로 넘긴다", async () => {
    const { out, started } = fakeOut();
    const b = pushBody();
    const c = playPcm(out, b.body, 1000);
    let first = false;
    void c.first!.then(() => (first = true));
    await sleep(5);
    expect(first).toBe(false);
    b.push([0x00, 0x40, 0x00]); // 16384, 그리고 남은 1바이트
    await sleep(5);
    expect(first).toBe(true);
    b.push([0x80, 0xff, 0x7f]); // (0x00,0x80)=-32768, (0xff,0x7f)=32767
    b.end();
    expect(await c.done).toBe(true);
    expect(started.map((s) => s.data)).toEqual([[0.5], [-1, 32767 / 32768]]);
    expect(started[0].at).toBeCloseTo(0.02);
    expect(started[1].at).toBeCloseTo(0.021); // 앞 조각(1샘플 = 1ms) 바로 뒤
  });

  it("stop()이면 받던 걸 끊고 건 조각도 멈춘다", async () => {
    const { out, started } = fakeOut();
    const b = pushBody();
    const c = playPcm(out, b.body, 1000);
    b.push([0, 0, 0, 0]);
    await sleep(5);
    c.stop();
    expect(await c.done).toBe(false);
    expect(b.cancelled()).toBe(true);
    expect(started.length).toBe(1);
    expect(started.every((s) => s.stopped)).toBe(true);
  });

  it("pcmWav: 조각을 wav로 (AudioContext가 안 열렸을 때)", async () => {
    const w = pcmWav([new Uint8Array(3), new Uint8Array(5)], 24000);
    expect(w.size).toBe(44 + 8);
    expect(await wavSeconds(w)).toBeCloseTo(8 / 48000);
  });
});

describe("LiveClient + /tts/stream", () => {
  const speak = (sentences: string[]): AgentEvent => ({ type: "speak", actionId: "a", kind: "answer", text: sentences.join(" "), sentences, evidence: [] });

  function make(server: (url: string, text: string) => Response) {
    const log: { kind: string; data?: unknown }[] = [];
    const asked: string[] = [];
    const sent: VoiceClientMsg[] = [];
    const clips: { rate: number; stop: boolean }[] = [];
    const { out } = fakeOut();
    const audio: AudioOut = {
      play: () => ({ done: Promise.resolve(true), stop() {} }),
      stream(body, rate) {
        const c = playPcm(out, body, rate);
        const rec = { rate, stop: false };
        clips.push(rec);
        return { ...c, stop: () => ((rec.stop = true), c.stop()) };
      },
    };
    const c = new LiveClient({
      meetingId: "m",
      brain: "http://brain.test",
      voiceUrl: "ws://voice.test/ws",
      dispatch: () => {},
      openStream: () => ({ close() {} }),
      audio,
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        const url = String(u);
        if (!url.includes("/tts")) return Response.json({});
        const text = JSON.parse(String(init?.body)).text as string;
        asked.push(`${url.replace("http://voice.test", "")} ${text}`);
        return server(url, text);
      }) as typeof fetch,
      quietMs: 0,
      trace: (kind, data) => log.push({ kind, data }),
    });
    c.wsSend = (m) => void sent.push(m);
    return { c, log, asked, sent, clips };
  }

  it("첫 조각이 와야 첫 소리·tts on, 다음 문장은 지금 문장을 다 받은 뒤에 부탁한다", async () => {
    const bodies: Record<string, ReturnType<typeof pushBody>> = {};
    const { c, log, asked, sent, clips } = make((_u, text) => {
      bodies[text] = pushBody();
      return new Response(bodies[text].body, { headers: { "content-type": "audio/L16;rate=24000;channels=1" } });
    });
    c.onAgent(speak(["하나.", "둘."]));
    await sleep(10);
    expect(asked).toEqual(["/tts/stream 하나."]);
    expect(log.some((l) => l.kind === "first_sound")).toBe(false);
    expect(sent).toEqual([]);
    bodies["하나."].push([0, 0, 0, 0]);
    await vi.waitFor(() => expect(log.some((l) => l.kind === "first_sound")).toBe(true));
    expect(sent).toEqual([{ type: "tts", on: true, text: "하나." }]);
    expect(asked).toEqual(["/tts/stream 하나."]); // 아직 다 받지 않았다
    bodies["하나."].end();
    await vi.waitFor(() => expect(asked).toEqual(["/tts/stream 하나.", "/tts/stream 둘."]));
    bodies["둘."].push([0, 0]);
    bodies["둘."].end();
    await vi.waitFor(() => expect(sent.map((m) => ("text" in m ? m.text : m.type === "tts" && m.on))).toEqual(["하나.", "둘.", false]));
    expect(clips.map((x) => x.rate)).toEqual([24000, 24000]);
  });

  it("barge_in이면 받던 소리를 끊는다", async () => {
    const b = pushBody();
    const { c, clips } = make(() => new Response(b.body, { headers: { "x-sample-rate": "44100", "content-type": "application/octet-stream" } }));
    c.onAgent(speak(["길게 말한다."]));
    b.push([0, 0, 0, 0]);
    await sleep(10);
    c.onVoice({ type: "barge_in", id: 2, t: 1 });
    await sleep(10);
    expect(clips).toEqual([{ rate: 44100, stop: true }]);
    expect(b.cancelled()).toBe(true);
    expect(c["voice"].current()).toBeNull();
  });

  it("/tts/stream이 없는 음성 서버(404)면 /tts wav로, 그 뒤로는 바로 /tts", async () => {
    const wav = pcmWav([new Uint8Array(32)], 16000);
    const { c, asked, log } = make((u) => (u.endsWith("/tts/stream") ? new Response("", { status: 404 }) : new Response(wav)));
    c.onAgent(speak(["하나.", "둘."]));
    await vi.waitFor(() => expect(asked).toEqual(["/tts/stream 하나.", "/tts 하나.", "/tts 둘."]));
    expect(log.filter((l) => l.kind === "first_sound")).toHaveLength(1);
  });
});
