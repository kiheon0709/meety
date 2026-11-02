// 사설 메시지(조용한 멤버 알림 등): 받는 사람 화면에만, 회의실 큰 화면(호스트)엔 안 뜬다 (security.md ⑪, 콘티 회의 3)
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/lib/live/contract";
import { LiveClient, fetchStream, silentAudio } from "../../src/components/live/client";
import { initState, privatesFor, reduce, type LiveState } from "../../src/components/live/state";
import { startFakeBrain } from "./fake-brain";

const PRIVATE = { type: "private", actionId: "p1", to: "지호", kind: "quiet_member", text: "지호 님은 어떻게 생각하세요? 말로 하기 어려우면 여기 적어 주셔도 돼요.", evidence: [] } satisfies AgentEvent;
const TO_HOST = { type: "private", actionId: "p2", to: "host", kind: "structure", text: "같은 두 안이 세 번째 나와요. 기준표로 나눠 볼까요?", evidence: [] } satisfies AgentEvent;

let brain: Awaited<ReturnType<typeof startFakeBrain>> | null = null;
afterEach(async () => {
  await brain?.close();
  brain = null;
});

function screen(url: string, me?: string) {
  const box = { state: initState("mid") as LiveState };
  const c = new LiveClient({
    meetingId: "fake-1",
    token: "fake-token",
    me,
    brain: url,
    voiceUrl: "ws://voice.test/ws",
    dispatch: (a) => (box.state = reduce(box.state, a)),
    openStream: fetchStream(fetch),
    audio: silentAudio,
  });
  c.connectStream();
  return { c, box };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("사설 메시지는 받는 사람 화면에만", () => {
  it("사람별 스트림: 지호 화면엔 뜨고, 호스트(회의실 큰 화면)엔 아예 안 온다. ?me=로 스트림을 연다", async () => {
    brain = await startFakeBrain();
    const host = screen(brain.url);
    const jiho = screen(brain.url, "지호");
    await sleep(80);
    brain.emit(PRIVATE);
    brain.emit(TO_HOST);
    await sleep(80);
    expect(privatesFor(jiho.box.state, { me: "지호", host: false }).map((p) => p.text)).toEqual([PRIVATE.text]);
    expect(host.box.state.privates.map((p) => p.actionId)).toEqual(["p2"]); // 호스트 스트림엔 호스트 몫만
    expect(privatesFor(host.box.state, { host: true }).map((p) => p.actionId)).toEqual(["p2"]);
    expect(privatesFor(jiho.box.state, { me: "지호", host: false }).some((p) => p.to === "host")).toBe(false);
    expect(brain.calls.filter((c) => c.path.endsWith("/stream")).map((c) => c.path)).toHaveLength(2);
    host.c.close();
    jiho.c.close();
  });

  it("두뇌가 실수로 공용 스트림에 뿌려도 화면이 한 번 더 거른다 (호스트 화면엔 남의 사설이 안 뜸)", async () => {
    brain = await startFakeBrain(0, { broadcastPrivate: true });
    const host = screen(brain.url);
    const taeeun = screen(brain.url, "태은");
    await sleep(80);
    brain.emit(PRIVATE);
    await sleep(80);
    expect(host.box.state.privates).toHaveLength(1); // 받긴 했지만
    expect(privatesFor(host.box.state, { host: true })).toEqual([]); // 보이지 않는다
    expect(privatesFor(taeeun.box.state, { me: "태은", host: false })).toEqual([]);
    host.c.close();
    taeeun.c.close();
  });

  it("스트림 주소에 me가 실린다 (두뇌가 사람별로 나눌 수 있게)", async () => {
    brain = await startFakeBrain();
    let url = "";
    const c = new LiveClient({
      meetingId: "m",
      me: "지호",
      brain: brain.url,
      voiceUrl: "ws://voice.test/ws",
      dispatch: () => {},
      openStream: (u) => ((url = u), { close() {} }),
      audio: silentAudio,
    });
    c.connectStream();
    expect(new URL(url).searchParams.get("me")).toBe("지호");
  });
});
