// 화면 클라이언트의 말 시작 규칙 (모델·서버 없음):
//  ① 누가 말하는 중이면 미티는 말이 멎을 때까지 기다린다
//  ② 기다리는 사이 들어온 말은 받아써져 두뇌에 간 뒤 잠깐 더 기다린다
//  ③ 기다리는 사이 "끼어들지 마"(설정 하)가 오면 지적은 말하지 않는다
import { describe, expect, it } from "vitest";
import { LiveClient, silentAudio } from "../../src/components/live/client";
import type { AgentEvent } from "../../src/lib/live/contract";

const wav = () => {
  const b = Buffer.alloc(44 + 3200);
  b.write("RIFF", 0);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(32000, 28);
  return new Response(new Blob([new Uint8Array(b)]));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const speak = (actionId: string, kind: "conflict" | "ack" = "conflict"): AgentEvent => ({ type: "speak", actionId, kind, text: "말", sentences: ["말"], evidence: [] });

function make() {
  const log: { kind: string; at: number; data?: unknown }[] = [];
  const t0 = Date.now();
  const c = new LiveClient({
    meetingId: "m",
    brain: "http://brain.test",
    voiceUrl: "ws://voice.test/ws",
    dispatch: () => {},
    openStream: () => ({ close() {} }),
    audio: silentAudio,
    fetch: (async (u: RequestInfo | URL) => (String(u).endsWith("/tts") ? wav() : Response.json({}))) as typeof fetch,
    quietMs: 100,
    trace: (kind, data) => log.push({ kind, at: Date.now() - t0, data }),
  });
  c.forwarding = true;
  const first = () => log.find((l) => l.kind === "first_sound")?.at;
  return { c, log, first };
}

describe("미티가 말을 시작하는 때", () => {
  it("조용하면 바로 말한다", async () => {
    const { c, first } = make();
    c.onAgent(speak("a"));
    await sleep(80);
    expect(first()).toBeLessThan(60);
  });

  it("사람이 말하는 중이면 말이 멎고 조용해진 뒤에 말한다", async () => {
    const { c, first } = make();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent(speak("a"));
    await sleep(200);
    expect(first()).toBeUndefined();
    c.onVoice({ type: "speech_end", id: 1, t0: 0, t1: 1 });
    c.onVoice({ type: "final", id: 1, t0: 0, t1: 1, text: "그건 그렇고" });
    await sleep(60);
    expect(first()).toBeUndefined(); // 받아쓴 말이 두뇌에 간 뒤 잠깐 더 (두뇌가 취소할 틈)
    await sleep(300);
    expect(first()).toBeGreaterThan(300);
  });

  it("기다리는 사이 강도 하가 오면 지적을 말하지 않고, 뒤이은 짧은 대답은 말한다", async () => {
    const { c, log, first } = make();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent(speak("a"));
    await sleep(50);
    c.onVoice({ type: "speech_end", id: 1, t0: 0, t1: 1 });
    c.onVoice({ type: "final", id: 1, t0: 0, t1: 1, text: "미티야 끼어들지 마", speaker: "기헌" });
    await sleep(50);
    c.onAgent({ type: "settings", intensity: "low", by: "기헌" });
    await sleep(300);
    expect(first()).toBeUndefined();
    expect(log.some((l) => l.kind === "dropped_after_low")).toBe(true);
    c.onAgent(speak("b", "ack"));
    await sleep(100);
    expect(log.find((l) => l.kind === "first_sound")?.data).toEqual({ actionId: "b" });
  });
});

describe("왜 카드가 소리보다 먼저 (설계서 §2-2)", () => {
  const queued = (actionId: string, kind: "conflict" | "answer" = "conflict"): AgentEvent => ({ type: "queued", actionId, kind, preview: "…", why: "9/30에 정함" });

  it("queued 뒤 바로 speak가 와도 카드가 뜬 지 600ms는 지나서 소리", async () => {
    const { c, first } = make();
    c.onAgent(queued("a"));
    c.onAgent(speak("a"));
    await sleep(400);
    expect(first()).toBeUndefined();
    await sleep(350);
    expect(first()).toBeGreaterThanOrEqual(590);
  });

  it("두뇌가 leadMs를 주면 그만큼", async () => {
    const { c, first } = make();
    c.onAgent(queued("a"));
    c.onAgent({ ...speak("a"), leadMs: 900 } as AgentEvent);
    await sleep(800);
    expect(first()).toBeUndefined();
    await sleep(250);
    expect(first()).toBeGreaterThanOrEqual(890);
  });

  it("부르면 답하는 말(answer)은 기다리지 않는다", async () => {
    const { c, first } = make();
    c.onAgent(queued("a", "answer"));
    c.onAgent({ type: "speak", actionId: "a", kind: "answer", text: "말", sentences: ["말"], evidence: [] });
    await sleep(100);
    expect(first()).toBeLessThan(80);
  });
});
