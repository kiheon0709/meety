// 말 끝나기 전 미리 판단(brain-design §2-7): 화면은 partial을 두뇌로 넘기고(1.5초에 한 번·10자 이상), 두뇌 draft에 마스코트가 "생각 중"으로만 반응한다
import { afterEach, describe, expect, it } from "vitest";
import { LiveClient, fetchStream, silentAudio } from "../../src/components/live/client";
import { heldOn, initState, meetyMode, reduce, type LiveState } from "../../src/components/live/state";
import { startFakeBrain } from "./fake-brain";

let brain: Awaited<ReturnType<typeof startFakeBrain>> | null = null;
afterEach(async () => {
  await brain?.close();
  brain = null;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function screen(url: string) {
  const box = { state: initState("high") as LiveState };
  const c = new LiveClient({
    meetingId: "fake-1",
    token: "fake-token",
    brain: url,
    voiceUrl: "ws://voice.test/ws",
    dispatch: (a) => (box.state = reduce(box.state, a)),
    openStream: fetchStream(fetch),
    audio: silentAudio,
  });
  c.forwarding = true;
  c.connectStream();
  return { c, box };
}

describe("partial 넘기기", () => {
  it("안정된 앞부분이 10자 이상일 때만, 같은 말은 1.5초에 한 번, stable과 같이", async () => {
    brain = await startFakeBrain();
    const { c } = screen(brain.url);
    c.onVoice({ type: "partial", id: 3, text: "디스코드는 이번에 봇까지", stable: 0 }); // 첫 partial은 안정 0 → 두뇌가 볼 게 없으니 안 보냄
    c.onVoice({ type: "partial", id: 3, text: "디스코드는 이번에 봇까지 만들어서", stable: 5 }); // 안정 5자 → 안 보냄
    c.onVoice({ type: "partial", id: 3, text: "디스코드는 이번에 봇까지 만들어서 입구를", stable: 14 }); // 보냄
    c.onVoice({ type: "partial", id: 3, text: "디스코드는 이번에 봇까지 만들어서 입구를 아예", stable: 20 }); // 같은 말 1.5초 안 → 안 보냄
    c.onVoice({ type: "partial", id: 4, text: "녹음은 그냥 붙여넣기만 받죠", stable: 11 }); // 다른 말 → 보냄
    await sleep(50);
    const posts = () => brain!.calls.filter((x) => x.path.endsWith("/partial")).map((x) => x.body);
    expect(posts()).toEqual([
      { id: 3, text: "디스코드는 이번에 봇까지 만들어서 입구를", stable: 14 },
      { id: 4, text: "녹음은 그냥 붙여넣기만 받죠", stable: 11 },
    ]);
    c.close();
  });

  it("받아쓰기 칸: stable 앞부분과 나머지를 나눠 들고 있다", () => {
    const s = reduce(initState("mid"), { src: "voice", ev: { type: "partial", id: 1, text: "리허설은 토요일", stable: 4 } });
    expect(s.lines[0]).toMatchObject({ text: "리허설은 토요일", stable: 4, final: false });
  });
});

describe("draft: 마스코트만 '생각 중'", () => {
  it("thinking → dropped: 생각 중이 켜졌다가 꺼진다 (말·손·카드 없음)", async () => {
    brain = await startFakeBrain();
    const { c, box } = screen(brain.url);
    await sleep(60);
    brain.emit({ type: "draft", uttId: 4, kind: "conflict", state: "thinking", why: "10/10 '입구는 웹 중심'과 달라 보여요" });
    await sleep(60);
    expect(box.state.draft).toMatchObject({ uttId: 4, why: "10/10 '입구는 웹 중심'과 달라 보여요" });
    expect(meetyMode(box.state)).toBe("listening"); // 상태는 그대로, 마스코트만 살짝
    expect(box.state.queued).toBeUndefined();
    brain.emit({ type: "draft", uttId: 4, kind: "conflict", state: "dropped" });
    await sleep(60);
    expect(box.state.draft).toBeUndefined();
    c.close();
  });

  it("thinking → queued: 할 말이 생기면 생각 중은 '할 말 있음'으로 넘어간다", async () => {
    brain = await startFakeBrain();
    const { c, box } = screen(brain.url);
    await sleep(60);
    brain.emit({ type: "draft", uttId: 4, kind: "conflict", state: "thinking" });
    await sleep(40);
    brain.emit({ type: "queued", actionId: "a1", kind: "conflict", preview: "10/10에 정한 것과 달라요" });
    await sleep(60);
    expect(box.state.draft).toBeUndefined();
    expect(meetyMode(box.state)).toBe("has_something");
    c.close();
  });

  it("너무 빨리 꺼지면 최소 0.6초는 보인다 (깜빡임 막기)", () => {
    expect(heldOn(true, 0, 100)).toBe(true);
    expect(heldOn(false, 1000, 1300)).toBe(true); // 켜진 지 0.3초에 꺼져도 0.6초까진 보임
    expect(heldOn(false, 1000, 1700)).toBe(false);
    expect(heldOn(false, null, 0)).toBe(false);
  });
});
