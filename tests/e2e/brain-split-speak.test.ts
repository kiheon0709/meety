// 두뇌 → 화면 끝까지: 부름 대답을 첫 문장 speak + 나머지 speak로 쪼개 보내도(splitSpeak) 화면 줄이 받침말 → 첫 문장 → 나머지 순서로 다 튼다.
// 두뇌는 진짜(meeting.ts), 모델만 가짜(첫 토큰 0.5초 뒤). 화면은 진짜 LiveClient, 소리는 0.1초 wav.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { LiveClient, silentAudio } from "../../src/components/live/client";
import type { LiveAction as Action } from "../../src/components/live/state";
import type { ModelRole } from "../../src/lib/live/contract";
import { setLlm, type CallInput, type LlmFn } from "../../src/lib/live/llm";
import { onUtterance, shutdownMeetings, startMeeting, subscribe, TIMING } from "../../src/lib/live/meeting";
import { ANSWER_SYSTEM, WATCH_SYSTEM } from "../../src/lib/live/prompts";
import { createSpace } from "../../src/lib/service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NONE = JSON.stringify({ conflict: { found: false, node_ids: [], fact_ids: [], said: "", against: "" }, agreement: { found: false, title: "", from: null, to: "", utt_ids: [] }, call: { addressed: true, want: "question", question: "" }, resolved: [] });
const fakeLlm = (async (role: ModelRole, input: CallInput<z.ZodType>) => {
  let text = "";
  if (input.system[0] === WATCH_SYSTEM) text = NONE;
  else if (input.system[0] === ANSWER_SYSTEM) {
    await sleep(500);
    text = input.user.includes("이름") ? "갈피예요.\n근거:" : "세 단계예요.\n상·중·하로 나뉘어요.\n근거:";
    input.onText?.(text);
  } else text = "";
  const out = input.schema ? input.schema.parse(JSON.parse(text || NONE)) : text;
  return { text, out, stat: { role, model: "fake", ms: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
}) as LlmFn;

beforeAll(() => {
  setLlm(fakeLlm);
  TIMING.fastFirst = false; // 대답 모델 한 번인 꼴의 줄 순서를 본다 (빠른 첫 문장은 tests/live에서)
  process.env.LIVE_AUTO_PROCESS = "0";
});
afterAll(() => {
  setLlm(null);
  shutdownMeetings();
});

const wav = () => {
  const b = Buffer.alloc(44 + 3200);
  b.write("RIFF", 0);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(32000, 28);
  return new Response(new Blob([new Uint8Array(b)]));
};

describe("두뇌 splitSpeak → 화면 줄", () => {
  it("받침말 → 첫 문장 → 나머지, 그다음 부름의 대답까지 받은 순서대로 다 튼다", async () => {
    expect(TIMING.splitSpeak).toBe(true);
    const sp = createSpace("split");
    const m = startMeeting({ spaceId: sp.id, title: "둘", agenda: [], intensity: "high", participants: ["기헌", "준영"] }); // 여럿: 받침말(1:1이면 생각 소리 backchannel)
    await m.templatesReady;
    const log: { kind: string; data?: unknown }[] = [];
    const acts: Action[] = [];
    const c = new LiveClient({
      meetingId: m.id,
      brain: "http://brain.test",
      voiceUrl: "ws://voice.test/ws",
      dispatch: (a) => acts.push(a),
      openStream: () => ({ close() {} }),
      audio: silentAudio,
      fetch: (async (u: RequestInfo | URL) => (String(u).endsWith("/tts") ? wav() : Response.json({}))) as typeof fetch,
      quietMs: 0,
      trace: (kind, data) => log.push({ kind, data }),
    });
    c.forwarding = true;
    const said: { actionId: string; text: string }[] = [];
    subscribe(m, (ev) => {
      if (ev.type === "speak") said.push({ actionId: ev.actionId, text: ev.sentences.join(" ") });
      if (ev.type !== "status" && ev.type !== "latency") c.onAgent(ev as never);
    });
    onUtterance(m, { id: 1, t0: 0, t1: 1, text: "미티야 끼어들기 강도는 몇 단계로 정했었지?", speaker: "기헌" }); // 짧은 말엔 한 문장이라 길게
    await sleep(150);
    onUtterance(m, { id: 2, t0: 2, t1: 3, text: "미티야 그리고 서비스 이름은?", speaker: "기헌" });
    await sleep(2500);
    expect(said.map((x) => x.text)).toEqual(["기록 좀 볼게요.", "세 단계예요.", "상·중·하로 나뉘어요.", "갈피예요."]);
    const sounds = log.filter((l) => l.kind === "first_sound").map((l) => (l.data as { actionId: string }).actionId);
    expect(sounds).toEqual(said.map((x) => x.actionId));
  });
});
