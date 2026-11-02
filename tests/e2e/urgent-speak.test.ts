// speak.urgent (계약 1302725): 확정 어긋남은 다음 final 뒤 짧은 틈에 바로 시작, "끼어들지 마"보다 먼저 받은 건 안 버림, 끊기면 손든 카드.
// 시나리오 A에서 다음 사람이 final 0.23초 뒤 말을 시작해 어긋남 지적이 끝내 소리로 안 나온 문제 (S3 분석)
import { describe, expect, it } from "vitest";
import { LiveClient, silentAudio } from "../../src/components/live/client";
import type { AgentEvent } from "../../src/lib/live/contract";
import type { LiveAction } from "../../src/components/live/state";

// 0.3초짜리 wav
const wav = () => {
  const b = Buffer.alloc(44 + 9600);
  b.write("RIFF", 0);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(32000, 28);
  return new Response(new Blob([new Uint8Array(b)]));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conflict = (actionId: string, urgent: boolean): AgentEvent => ({
  type: "speak",
  actionId,
  kind: "conflict",
  text: "잠깐만요. 디스코드 봇은 10월 30일에 2단계로 미뤘어요.",
  sentences: ["잠깐만요.", "디스코드 봇은 10월 30일에 2단계로 미뤘어요."],
  evidence: [{ label: "10/30 회의 — 봇은 2단계" }],
  ...(urgent ? { urgent: true as const } : {}),
});

function make() {
  const log: { kind: string; at: number; data?: unknown }[] = [];
  const posted: string[] = [];
  const acts: LiveAction[] = [];
  const c = new LiveClient({
    meetingId: "m",
    brain: "http://brain.test",
    voiceUrl: "ws://voice.test/ws",
    dispatch: (a) => acts.push(a),
    openStream: () => ({ close() {} }),
    audio: silentAudio,
    fetch: (async (u: RequestInfo | URL) => (String(u).endsWith("/tts") ? wav() : (posted.push(String(u).split("/").pop()!), Response.json({})))) as typeof fetch,
    trace: (kind, data) => log.push({ kind, at: Date.now(), data }),
  });
  c.forwarding = true;
  const sounded = (id: string) => log.find((l) => l.kind === "first_sound" && (l.data as { actionId: string }).actionId === id);
  const hands = () => acts.flatMap((a) => (a.src === "agent" && a.ev.type === "hand_raise" ? [a.ev] : []));
  const cancels = () => acts.flatMap((a) => (a.src === "agent" && a.ev.type === "cancel" ? [a.ev.actionId] : []));
  return { c, log, sounded, hands, cancels, posted };
}

describe("speak.urgent", () => {
  it("다음 사람이 말하는 중에 받으면, 그 말의 final(말끝 확률 높음) 바로 뒤에 시작한다 — 왜 카드 뜸·0.4초 여유를 안 기다린다", async () => {
    const { c, sounded } = make();
    c.onAgent({ type: "queued", actionId: "u", kind: "conflict", preview: "디스코드 봇" });
    c.onVoice({ type: "speech_start", id: 100, t: 0 }); // 다음 사람이 이미 말하는 중
    c.onAgent(conflict("u", true));
    await sleep(150);
    expect(sounded("u")).toBeUndefined(); // 사람 말 위로는 안 낸다
    c.onVoice({ type: "speech_end", id: 100, t0: 0, t1: 0.2 });
    const finalAt = Date.now();
    c.onVoice({ type: "final", id: 100, t0: 0, t1: 0.2, text: "근데 영상은 회의 장면 먼저", speaker: "태은", turn: 0.92 });
    await sleep(200);
    expect(sounded("u")).toBeDefined();
    expect(sounded("u")!.at - finalAt).toBeLessThan(150);
  });

  it("말끝 확률이 낮으면 0.3초 조용해질 때 시작한다 (보통 speak는 final 뒤 0.4초)", async () => {
    const u = make();
    const n = make();
    for (const [x, urgent] of [[u, true], [n, false]] as const) {
      x.c.onVoice({ type: "speech_start", id: 100, t: 0 });
      x.c.onAgent(conflict("a", urgent));
    }
    await sleep(50);
    const endAt = Date.now();
    for (const x of [u, n]) {
      x.c.onVoice({ type: "speech_end", id: 100, t0: 0, t1: 0.2 });
      x.c.onVoice({ type: "final", id: 100, t0: 0, t1: 0.2, text: "음 그러니까", speaker: "태은", turn: 0.3 });
    }
    await sleep(700);
    const lag = u.sounded("a")!.at - endAt;
    expect(lag).toBeGreaterThanOrEqual(280);
    expect(lag).toBeLessThan(380);
    expect(n.sounded("a")!.at - endAt).toBeGreaterThanOrEqual(390); // 보통 speak는 final 뒤 0.4초
  });

  it("'끼어들지 마'(settings low)보다 먼저 받은 urgent는 버리지 않는다 — 보통 지적은 지금처럼 버린다", async () => {
    const u = make();
    const n = make();
    for (const [x, urgent] of [[u, true], [n, false]] as const) {
      x.c.onVoice({ type: "speech_start", id: 100, t: 0 });
      x.c.onAgent(conflict("a", urgent));
    }
    await sleep(50);
    for (const x of [u, n]) x.c.onAgent({ type: "settings", intensity: "low", by: "기헌" });
    for (const x of [u, n]) {
      x.c.onVoice({ type: "speech_end", id: 100, t0: 0, t1: 0.2 });
      x.c.onVoice({ type: "final", id: 100, t0: 0, t1: 0.2, text: "미티야 끼어들지 마", speaker: "기헌", turn: 0.9 });
    }
    await sleep(1500);
    expect(u.sounded("a")).toBeDefined();
    expect(u.log.some((l) => l.kind === "dropped_after_low")).toBe(false);
    expect(n.sounded("a")).toBeUndefined();
    expect(n.log.some((l) => l.kind === "dropped_after_low")).toBe(true);
  });

  it("말하다가 사람이 말을 시작하면(barge) 멈추고 손든 카드로 남긴다 — 줄에서 기다리던 urgent도", async () => {
    const { c, sounded, hands } = make();
    c.onAgent({ type: "speak", actionId: "ack", kind: "ack", text: "네.", sentences: ["네."], evidence: [] });
    c.onAgent(conflict("u1", true));
    c.onAgent(conflict("u2", true));
    await sleep(80);
    expect(sounded("ack")).toBeDefined();
    c.onVoice({ type: "barge_in", id: 7, t: 1 });
    await sleep(50);
    expect(hands().map((h) => h.actionId)).toEqual(["u1", "u2"]);
    expect(hands()[0]).toMatchObject({ kind: "conflict", preview: expect.stringContaining("디스코드 봇"), evidence: [{ label: "10/30 회의 — 봇은 2단계" }] });

    const b = make();
    b.c.onAgent(conflict("u3", true));
    await sleep(120);
    expect(b.sounded("u3")).toBeDefined();
    b.c.onVoice({ type: "barge_in", id: 8, t: 1 });
    await sleep(20);
    expect(b.hands().map((h) => h.actionId)).toEqual(["u3"]);
  });

  it("보통 speak가 끊기면 손든 카드를 만들지 않는다 (지금처럼)", async () => {
    const { c, sounded, hands } = make();
    c.onAgent(conflict("n", false));
    await sleep(120);
    expect(sounded("n")).toBeDefined();
    c.onVoice({ type: "barge_in", id: 9, t: 1 });
    await sleep(20);
    expect(hands()).toEqual([]);
  });

  // 시나리오 A 녹화(--urgent-conflict): 두뇌가 "끼어들지 마" 때 방금 어긋남을 손으로 남기고, 화면도 끊긴 urgent로 손을 들어 같은 카드가 둘 떴다
  const brainHand = { type: "hand_raise" as const, actionId: "h1", kind: "conflict" as const, preview: "디스코드 봇은 10월 30일에 2단계로 미뤘어요.", evidence: [] };

  it("두뇌가 같은 지적으로 이미 손을 들었으면 끊긴 urgent로 카드를 하나 더 띄우지 않는다", async () => {
    const { c, sounded, hands, log } = make();
    c.onAgent(brainHand);
    c.onAgent(conflict("u", true));
    await sleep(120);
    expect(sounded("u")).toBeDefined();
    c.onVoice({ type: "barge_in", id: 7, t: 1 });
    await sleep(20);
    expect(hands().map((h) => h.actionId)).toEqual(["h1"]);
    expect(log.some((l) => l.kind === "urgent_hand_dup")).toBe(true);
  });

  it("화면이 먼저 든 손과 같은 지적으로 두뇌가 손을 들면 화면 쪽 카드를 내린다", async () => {
    const { c, sounded, hands, cancels } = make();
    c.onAgent(conflict("u", true));
    await sleep(120);
    expect(sounded("u")).toBeDefined();
    c.onVoice({ type: "barge_in", id: 7, t: 1 });
    await sleep(20);
    c.onAgent(brainHand);
    expect(hands().map((h) => h.actionId)).toEqual(["u", "h1"]);
    expect(cancels()).toEqual(["u"]);
  });

  it("화면이 든 손을 '말해줘' 하면 화면이 그 지적을 다시 말한다 (두뇌엔 respond를 안 보낸다 — 두뇌엔 이미 말한 것)", async () => {
    const { c, log, posted } = make();
    c.onAgent(conflict("u", true));
    await sleep(120);
    c.onVoice({ type: "barge_in", id: 7, t: 1 });
    c.onVoice({ type: "speech_end", id: 7, t0: 1, t1: 2 });
    c.onVoice({ type: "final", id: 7, t0: 1, t1: 2, text: "아 그건", speaker: "준영", turn: 0.9 });
    await sleep(20);
    c.respond("u", true);
    await sleep(700); // 끼어든 사람 말이 끝나고(final) 0.4초 뒤
    expect(log.filter((l) => l.kind === "first_sound" && (l.data as { actionId: string }).actionId === "u")).toHaveLength(2);
    expect(posted).not.toContain("respond");
  });
});
