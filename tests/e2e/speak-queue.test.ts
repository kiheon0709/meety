// 미티 말 줄: 받은 순서대로 앞 말이 끝나면 다음 말. 새 speak가 앞 말을 끊지 않는다 (기헌 1:1 시험 — 밀린 대답이 마지막 것만 나옴)
import { describe, expect, it } from "vitest";
import { LiveClient, silentAudio } from "../../src/components/live/client";
import type { AgentEvent } from "../../src/lib/live/contract";
import { initState, reduce, showSpeech, type LiveAction as Action } from "../../src/components/live/state";

// 0.1초짜리 wav
const wav = () => {
  const b = Buffer.alloc(44 + 3200);
  b.write("RIFF", 0);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(32000, 28);
  return new Response(new Blob([new Uint8Array(b)]));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const speak = (actionId: string, kind: "answer" | "conflict" = "answer", sentences = ["말"]): AgentEvent => ({ type: "speak", actionId, kind, text: sentences.join(" "), sentences, evidence: [] });

function make() {
  const log: { kind: string; data?: unknown }[] = [];
  const acts: Action[] = [];
  const c = new LiveClient({
    meetingId: "m",
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
  const sounds = () => log.filter((l) => l.kind === "first_sound").map((l) => (l.data as { actionId: string }).actionId);
  const spoken = () => acts.flatMap((a) => (a.src === "ui" && a.type === "spoken" ? [a.actionId] : []));
  const speaks = () => acts.flatMap((a) => (a.src === "agent" && a.ev.type === "speak" ? [a.ev.actionId] : []));
  return { c, log, acts, sounds, spoken, speaks };
}

describe("미티 말 줄", () => {
  it("speak 3개를 연달아 받으면 3개 다 순서대로 끝까지 말한다", async () => {
    const { c, sounds, spoken, speaks } = make();
    c.onAgent(speak("a"));
    c.onAgent(speak("b"));
    c.onAgent(speak("c"));
    await sleep(60);
    expect(speaks()).toEqual(["a"]); // 화면엔 지금 말하는 것만
    await sleep(600);
    expect(sounds()).toEqual(["a", "b", "c"]);
    expect(spoken()).toEqual(["a", "b", "c"]);
    expect(speaks()).toEqual(["a", "b", "c"]);
  });

  it("barge_in이 오면 지금 말을 끊고 줄 전체를 비운다", async () => {
    const { c, sounds, spoken } = make();
    c.onAgent(speak("a", "answer", ["하나", "둘", "셋"]));
    c.onAgent(speak("b"));
    c.onAgent(speak("c"));
    await sleep(60);
    c.onVoice({ type: "barge_in", id: 2, t: 1 });
    await sleep(600);
    expect(sounds()).toEqual(["a"]);
    expect(spoken()).toEqual([]);
    expect(c["voice"].current()).toBeNull();
  });

  it("같은 actionId가 또 오면 무시한다", async () => {
    const { c, sounds } = make();
    c.onAgent(speak("a"));
    c.onAgent(speak("a"));
    await sleep(400);
    expect(sounds()).toEqual(["a"]);
  });

  it("cancel은 그 말만 뺀다 (기다리는 말이면 줄에서, 나머지는 그대로)", async () => {
    const { c, sounds } = make();
    c.onAgent(speak("a"));
    c.onAgent(speak("b"));
    c.onAgent(speak("c"));
    c.onAgent({ type: "cancel", actionId: "b", reason: "stale" });
    await sleep(600);
    expect(sounds()).toEqual(["a", "c"]);
  });

  it("줄이 3개 넘게 쌓이면 가장 오래 기다린 부름 대답은 소리 없이 자막에만", async () => {
    const { c, sounds, spoken, log } = make();
    c.onAgent(speak("a"));
    c.onAgent(speak("b"));
    c.onAgent(speak("x", "conflict"));
    c.onAgent(speak("c"));
    await sleep(800);
    expect(log.filter((l) => l.kind === "muted_in_line").map((l) => l.data)).toEqual([{ actionId: "b" }]);
    expect(sounds()).toEqual(["a", "x", "c"]);
    expect(spoken()).toEqual(["a", "b", "x", "c"]); // b도 받아쓰기 칸(said)에는 남는다
  });
});

// 관리 10/31: barge로 줄을 비울 때 명령에 대한 대답(ack)은 버리지 않고 사람 말이 끝난 뒤 낸다 — 대답이 없으면 안 들은 것처럼 보인다
describe("barge 뒤 명령 대답(ack)", () => {
  const ack = (actionId: string): AgentEvent => ({ type: "speak", actionId, kind: "ack", text: "알겠어요, 이제 화면에 손만 들게요.", sentences: ["알겠어요, 이제 화면에 손만 들게요."], evidence: [] });

  it("줄에서 기다리던 ack는 남겨 두고, 끼어든 사람 말이 끝난 뒤(final) 낸다 — 다른 말은 지금처럼 버린다", async () => {
    const { c, sounds } = make();
    c.onAgent(speak("a", "conflict", ["하나", "둘", "셋"]));
    c.onAgent(speak("b"));
    c.onAgent(ack("k"));
    await sleep(60);
    c.onVoice({ type: "barge_in", id: 5, t: 1 });
    await sleep(300);
    expect(sounds()).toEqual(["a"]); // 사람이 아직 말하는 중
    c.onVoice({ type: "speech_end", id: 5, t0: 1, t1: 2 });
    await sleep(100);
    expect(sounds()).toEqual(["a"]); // final 전
    c.onVoice({ type: "final", id: 5, t0: 1, t1: 2, text: "아 그건 나중에", speaker: "준영" });
    await sleep(200);
    expect(sounds()).toEqual(["a", "k"]);
  });

  it("남긴 ack에 두뇌가 barge_in cancel을 보내도 빼지 않는다 (두뇌는 가장 최근에 보낸 말을 끊긴 것으로 친다) — 다른 이유 cancel은 뺀다", async () => {
    const { c, sounds } = make();
    c.onAgent(speak("u", "conflict", ["하나", "둘", "셋"]));
    c.onAgent(ack("k"));
    c.onAgent(ack("k2"));
    await sleep(60);
    c.onVoice({ type: "barge_in", id: 5, t: 1 });
    c.onAgent({ type: "cancel", actionId: "k", reason: "barge_in" });
    c.onAgent({ type: "cancel", actionId: "k2", reason: "stale" });
    c.onVoice({ type: "speech_end", id: 5, t0: 1, t1: 2 });
    c.onVoice({ type: "final", id: 5, t0: 1, t1: 2, text: "아 그건 나중에", speaker: "준영" });
    await sleep(300);
    expect(sounds()).toEqual(["u", "k"]);
  });

  it("남긴 ack가 차례가 와 사람 말이 멎기를 기다리는 중에 barge_in cancel이 와도 그대로 (시나리오 A: barge 직후 두뇌 cancel)", async () => {
    const { c, sounds, acts } = make();
    c.onAgent(speak("u", "conflict", ["하나", "둘", "셋"]));
    c.onAgent(ack("k"));
    await sleep(60);
    c.onVoice({ type: "barge_in", id: 5, t: 1 });
    await sleep(30); // k가 지금 말(cur)이 되어 사람 말이 멎기를 기다린다
    c.onAgent({ type: "cancel", actionId: "k", reason: "barge_in" });
    expect(acts.some((a) => a.src === "agent" && a.ev.type === "cancel" && a.ev.actionId === "k")).toBe(false);
    c.onVoice({ type: "speech_end", id: 5, t0: 1, t1: 2 });
    c.onVoice({ type: "final", id: 5, t0: 1, t1: 2, text: "아 그건 나중에", speaker: "준영" });
    await sleep(300);
    expect(sounds()).toEqual(["u", "k"]);
  });

  it("말하던 말은 ack여도 다시 하지 않는다 (여는 말도 ack다)", async () => {
    const { c, sounds } = make();
    c.onAgent(ack("announce"));
    await sleep(40);
    c.onVoice({ type: "barge_in", id: 5, t: 1 });
    c.onVoice({ type: "speech_end", id: 5, t0: 1, t1: 2 });
    c.onVoice({ type: "final", id: 5, t0: 1, t1: 2, text: "잠깐만", speaker: "준영" });
    await sleep(400);
    expect(sounds()).toEqual(["announce"]);
  });

  it("'조용히'(화면 버튼)는 ack까지 다 비운다", async () => {
    const { c, sounds } = make();
    c.onAgent(speak("a", "answer", ["하나", "둘", "셋"]));
    c.onAgent(ack("k"));
    await sleep(60);
    c.interrupt();
    await sleep(500);
    expect(sounds()).toEqual(["a"]);
  });
});

// 관리 10/31: 기다림(QUIET_MAX)이 끝났는데도 사람이 말하는 중이면 명령 대답(ack)은 소리 대신 화면 글자로만 — 사람 말을 덮지 않는다
describe("기다림이 끝나도 사람이 말하면 ack는 글자로만", () => {
  const ack = (actionId: string): AgentEvent => ({ type: "speak", actionId, kind: "ack", text: "알겠어요, 이제 화면에 손만 들게요.", sentences: ["알겠어요, 이제 화면에 손만 들게요."], evidence: [] });
  function mk() {
    const log: { kind: string; data?: unknown }[] = [];
    let state = initState("mid");
    const c = new LiveClient({
      meetingId: "m",
      brain: "http://brain.test",
      voiceUrl: "ws://voice.test/ws",
      dispatch: (a) => (state = reduce(state, a)),
      openStream: () => ({ close() {} }),
      audio: silentAudio,
      fetch: (async (u: RequestInfo | URL) => (String(u).endsWith("/tts") ? wav() : Response.json({}))) as typeof fetch,
      quietMs: 0,
      quietMaxMs: 300,
      trace: (kind, data) => log.push({ kind, data }),
    });
    c.forwarding = true;
    return { c, log, st: () => state, sounded: () => log.some((l) => l.kind === "first_sound") };
  }

  it("사람이 계속 말하면 소리는 안 내고 자막에 글자로 남긴다 (기다리는 사이 받아 적힌 말이 많아도 보인다)", async () => {
    const { c, log, st, sounded } = mk();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent(ack("k"));
    for (let i = 2; i <= 4; i++) {
      // 기다리는 사이 다른 사람들 말이 받아 적힌다 (사람은 계속 말하는 중)
      c.onVoice({ type: "speech_start", id: i, t: 0 });
      c.onVoice({ type: "final", id: i - 1, t0: 0, t1: 1, text: "그래서 그건", speaker: "준영" });
    }
    await sleep(500);
    expect(sounded()).toBe(false);
    expect(log.some((l) => l.kind === "shown_silent")).toBe(true);
    expect(st().speech).toMatchObject({ actionId: "k", status: "done", silent: true });
    expect(showSpeech(st())).toBe(true);
    c.onVoice({ type: "speech_end", id: 4, t0: 0, t1: 1 });
    c.onVoice({ type: "final", id: 4, t0: 0, t1: 1, text: "끝", speaker: "준영" });
    await sleep(200);
    expect(sounded()).toBe(false); // 나중에 조용해져도 소리로 다시 내지 않는다
  });

  it("기다리는 사이 사람 말이 끝나면 소리로 낸다 (지금처럼)", async () => {
    const { c, sounded, st } = mk();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent(ack("k"));
    await sleep(100);
    c.onVoice({ type: "speech_end", id: 1, t0: 0, t1: 1 });
    c.onVoice({ type: "final", id: 1, t0: 0, t1: 1, text: "미티야 끼어들지 마", speaker: "기헌" });
    await sleep(200);
    expect(sounded()).toBe(true);
    expect(st().speech?.silent).toBeUndefined();
  });

  it("ack가 아닌 말은 기다림이 끝나면 지금처럼 소리로 낸다", async () => {
    const { c, sounded } = mk();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent(speak("q", "answer"));
    await sleep(500);
    expect(sounded()).toBe(true);
  });
});

// 계약 8b6718c: POST /barge에 actionId — 끊길 때 화면이 실제로 소리 내던 말. 두뇌는 이걸 끊긴 말로 친다
// (전엔 두뇌가 "가장 최근에 보낸 말"로 추정해, urgent를 말하던 중 끊겨도 그 뒤에 받은 ack를 끊긴 말로 쳤다 — 시나리오 A)
describe("/barge actionId", () => {
  function mk() {
    const bodies: { path: string; body: Record<string, unknown> }[] = [];
    const c = new LiveClient({
      meetingId: "m",
      brain: "http://brain.test",
      voiceUrl: "ws://voice.test/ws",
      dispatch: () => {},
      openStream: () => ({ close() {} }),
      audio: silentAudio,
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        if (String(u).endsWith("/tts")) return wav();
        bodies.push({ path: String(u).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json({});
      }) as typeof fetch,
      quietMs: 0,
    });
    c.forwarding = true;
    return { c, barges: () => bodies.filter((b) => b.path === "barge").map((b) => b.body) };
  }
  const urgent: AgentEvent = { type: "speak", actionId: "u", kind: "conflict", text: "하나 둘 셋", sentences: ["하나", "둘", "셋"], evidence: [], urgent: true };
  const ackEv: AgentEvent = { type: "speak", actionId: "k", kind: "ack", text: "알겠어요.", sentences: ["알겠어요."], evidence: [] };

  it("urgent를 말하던 중 끊기면 그 말의 actionId를 보낸다 — 뒤에 받은 ack가 아니라", async () => {
    const { c, barges } = mk();
    c.onAgent(urgent);
    c.onAgent(ackEv);
    await sleep(60);
    c.onVoice({ type: "barge_in", id: 5, t: 1 });
    await sleep(20);
    expect(barges()).toEqual([{ id: 5, playedMs: expect.any(Number), actionId: "u" }]);
  });

  it("미티가 소리를 안 내던 때의 barge_in엔 actionId가 없다", async () => {
    const { c, barges } = mk();
    c.onVoice({ type: "barge_in", id: 6, t: 1 });
    await sleep(20);
    expect(barges()).toEqual([{ id: 6 }]);
  });

  it("'조용히'(화면 버튼)로 끊어도 그 말의 actionId를 보낸다", async () => {
    const { c, barges } = mk();
    c.onAgent(urgent);
    await sleep(60);
    c.interrupt();
    await sleep(20);
    expect(barges()[0]).toMatchObject({ actionId: "u" });
  });
});

// 관리 10/31 ①: 기다림이 끝나도 사람이 말하면 먼저 꺼내는 말(suggest·여는 질문·어긋남)은 손든 카드로 — urgent·부름 대답은 지금처럼 소리로
// (A2 4판: 두뇌의 여는 질문이 8초 뒤 준영 말 위로 나가 준영 말이 echo로 찍혀 어긋남을 놓쳤다)
describe("기다림이 끝나도 사람이 말하면 먼저 꺼내는 말은 손든 카드로", () => {
  function mk() {
    const log: { kind: string; data?: unknown }[] = [];
    const acts: Action[] = [];
    let state = initState("mid");
    const c = new LiveClient({
      meetingId: "m",
      brain: "http://brain.test",
      voiceUrl: "ws://voice.test/ws",
      dispatch: (a) => (acts.push(a), (state = reduce(state, a))),
      openStream: () => ({ close() {} }),
      audio: silentAudio,
      fetch: (async (u: RequestInfo | URL) => (String(u).endsWith("/tts") ? wav() : Response.json({}))) as typeof fetch,
      quietMs: 0,
      quietMaxMs: 300,
      trace: (kind, data) => log.push({ kind, data }),
    });
    c.forwarding = true;
    const sounded = (id: string) => log.some((l) => l.kind === "first_sound" && (l.data as { actionId: string }).actionId === id);
    const hands = () => acts.flatMap((a) => (a.src === "agent" && a.ev.type === "hand_raise" ? [a.ev.actionId] : []));
    return { c, st: () => state, sounded, hands };
  }
  const opening: AgentEvent = { type: "speak", actionId: "open", kind: "suggest", text: "오늘 세 가지 정해야 하는데, 어디부터 할까요?", sentences: ["오늘 세 가지 정해야 하는데, 어디부터 할까요?"], evidence: [] };

  it("여는 질문(suggest): 사람이 계속 말하면 소리 없이 손든 카드, '할 말이 있어요'는 내린다", async () => {
    const { c, st, sounded, hands } = mk();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent(opening);
    await sleep(500);
    expect(sounded("open")).toBe(false);
    expect(hands()).toEqual(["open"]);
    expect(st().speech).toBeUndefined();
    expect(st().hands[0]).toMatchObject({ actionId: "open", status: "pending" });
  });

  it("손든 카드를 '말해줘' 하면 그때 소리로 낸다", async () => {
    const { c, sounded } = mk();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent(opening);
    await sleep(500);
    c.onVoice({ type: "speech_end", id: 1, t0: 0, t1: 1 });
    c.onVoice({ type: "final", id: 1, t0: 0, t1: 1, text: "그래서 그건", speaker: "준영" });
    c.respond("open", true);
    await sleep(300);
    expect(sounded("open")).toBe(true);
  });

  it("urgent는 지금처럼 기다림 끝에 소리로, 부름 대답(answer)도 소리로", async () => {
    const { c, sounded, hands } = mk();
    c.onVoice({ type: "speech_start", id: 1, t: 0 });
    c.onAgent({ type: "speak", actionId: "u", kind: "conflict", text: "잠깐만요.", sentences: ["잠깐만요."], evidence: [], urgent: true });
    c.onAgent(speak("a", "answer"));
    await sleep(900);
    expect(sounded("u")).toBe(true);
    expect(sounded("a")).toBe(true);
    expect(hands()).toEqual([]);
  });
});
