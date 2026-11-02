// 능동형 미티 화면 클라이언트: 맞장구는 줄과 따로 짧게(말하는 중이면 안 냄), 여는 말도 "말하는 중"으로
import { describe, expect, it } from "vitest";
import { LiveClient, silentAudio } from "../../src/components/live/client";
import type { AgentEvent } from "../../src/lib/live/contract";
import type { AgentEventX, LiveAction } from "../../src/components/live/state";

// 0.1초짜리 wav
const wav = () => {
  const b = Buffer.alloc(44 + 3200);
  b.write("RIFF", 0);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(32000, 28);
  return new Response(new Blob([new Uint8Array(b)]));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const speak = (actionId: string): AgentEvent => ({ type: "speak", actionId, kind: "answer", text: "말", sentences: ["말"], evidence: [] });
const bc = (text = "네"): AgentEventX => ({ type: "backchannel", text });

function make() {
  const log: { kind: string; data?: unknown }[] = [];
  const acts: LiveAction[] = [];
  const tts: { text: string; on: boolean }[] = [];
  const c = new LiveClient({
    meetingId: "m",
    brain: "http://brain.test",
    voiceUrl: "ws://voice.test/ws",
    dispatch: (a) => acts.push(a),
    openStream: () => ({ close() {} }),
    audio: silentAudio,
    fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).endsWith("/tts")) {
        tts.push({ text: JSON.parse(String(init?.body)).text, on: true });
        return wav();
      }
      return Response.json({});
    }) as typeof fetch,
    quietMs: 0,
    trace: (kind, data) => log.push({ kind, data }),
  });
  c.forwarding = true;
  const sounds = () => log.filter((l) => l.kind === "first_sound").map((l) => (l.data as { actionId: string }).actionId);
  return { c, log, acts, tts, sounds };
}

describe("맞장구", () => {
  it("조용할 때 오면 짧게 소리 내고, 화면엔 끄덕임만 (speak·자막 없음)", async () => {
    const { c, log, acts, tts } = make();
    c.onAgent(bc("네"));
    await sleep(250);
    expect(log.some((l) => l.kind === "backchannel")).toBe(true);
    expect(tts.map((t) => t.text)).toEqual(["네"]);
    expect(acts.some((a) => a.src === "agent" && a.ev.type === "backchannel")).toBe(true);
    expect(acts.some((a) => a.src === "ui" && a.type === "sentence")).toBe(false);
  });

  it("미티가 말하는 중이면 맞장구 소리는 안 낸다 (끄덕임 표시는 그대로 넘긴다)", async () => {
    const { c, log, tts } = make();
    c.onAgent(speak("a"));
    await sleep(20);
    c.onAgent(bc("음"));
    await sleep(300);
    expect(log.some((l) => l.kind === "backchannel")).toBe(false);
    expect(tts.map((t) => t.text)).toEqual(["말"]);
  });

  it("맞장구가 나는 사이 말이 오면 맞장구가 끝난 뒤 말한다 (겹치지 않음)", async () => {
    const { c, log } = make();
    c.onAgent(bc("네"));
    await sleep(5);
    c.onAgent(speak("a"));
    await sleep(400);
    const order = log.filter((l) => l.kind === "backchannel" || l.kind === "first_sound").map((l) => l.kind);
    expect(order).toEqual(["backchannel", "first_sound"]);
  });
});

describe("여는 말", () => {
  it("회의 시작 안내도 화면엔 말하기(speak)로 가고, 두뇌가 먼저 꺼낸 첫말은 그 뒤에 이어진다", async () => {
    const { c, acts, sounds } = make();
    c.begin({ save: false, announce: "회의 녹음과 기록을 시작할게요" });
    c.onAgent(speak("open"));
    await sleep(500);
    const speaks = acts.flatMap((a) => (a.src === "agent" && a.ev.type === "speak" ? [a.ev.actionId] : []));
    expect(speaks).toEqual(["announce", "open"]);
    expect(sounds()).toEqual(["announce", "open"]);
  });
});
