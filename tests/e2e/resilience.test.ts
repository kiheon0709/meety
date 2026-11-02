// 장애에서 버티기 (모델·서버 없음): 음성 서버가 죽으면 알리고 다시 붙는다, 두뇌가 오류여도 멈추지 않고 알린다
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveClient, silentAudio } from "../../src/components/live/client";
import { initState, reduce, type LiveAction, type LiveState } from "../../src/components/live/state";

const sockets: Sock[] = [];
class Sock {
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => {
      if (Sock.down) {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 5);
  }
  static down = false;
  bytes = 0;
  send(d: string | ArrayBuffer | Uint8Array) {
    if (typeof d === "string") this.sent.push(d);
    else this.bytes += d.byteLength;
  }
  close() {
    this.readyState = 3;
  }
  // 서버 쪽에서 끊김
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function make(fetchImpl: typeof fetch, trace?: (kind: string, data: unknown) => void) {
  let state: LiveState = initState("mid");
  const c = new LiveClient({
    trace,
    meetingId: "m",
    token: "t",
    brain: "http://brain.test",
    voiceUrl: "ws://voice.test/ws",
    dispatch: (a: LiveAction) => (state = reduce(state, a)),
    openStream: () => ({ close() {} }),
    audio: silentAudio,
    fetch: fetchImpl,
    participants: ["기헌"],
  });
  return { c, get state() { return state; } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sockets.length = 0;
  Sock.down = false;
});

describe("장애에서 버티기", () => {
  it("음성 서버 연결이 끊기면 알리고, 살아나면 다시 붙어 참석자 힌트를 다시 보낸다", async () => {
    vi.stubGlobal("WebSocket", Sock);
    const t = make((async () => Response.json({})) as typeof fetch);
    await t.c.connectVoice();
    expect(t.state.conn.voice).toBe("on");
    Sock.down = true;
    sockets[0].drop();
    expect(t.state.conn.voice).toBe("error");
    expect(t.state.toast?.text).toContain("받아쓰기 연결이 끊겼어요");
    await sleep(1100); // 1초 뒤 다시 시도 → 아직 죽어 있음
    expect(sockets.length).toBe(2);
    Sock.down = false;
    await sleep(2100); // 2초 뒤 다시 시도 → 붙음
    expect(sockets.length).toBe(3);
    expect(t.state.conn.voice).toBe("on");
    expect(t.state.toast?.text).toContain("다시 붙었어요");
    expect(JSON.parse(sockets[2].sent[0])).toMatchObject({ type: "start", prompt: "기헌" });
    t.c.close();
  });

  it("일부러 끝낸 회의는 다시 붙지 않는다", async () => {
    vi.stubGlobal("WebSocket", Sock);
    const t = make((async () => Response.json({})) as typeof fetch);
    await t.c.connectVoice();
    t.c.close();
    sockets[0].drop();
    await sleep(1200);
    expect(sockets.length).toBe(1);
  });

  it("소리를 보내는데 15초 넘게 음성 서버가 조용하면 끊는다(→ 다시 붙기). tick이 오면 살아 있는 것", async () => {
    vi.stubGlobal("WebSocket", Sock);
    const t = make((async () => Response.json({})) as typeof fetch);
    await t.c.connectVoice();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const frame = new ArrayBuffer(2048);
    for (let i = 0; i < 300; i++) {
      now += 64;
      t.c.sendPcm(frame);
      if (i % 78 === 0) sockets[0].onmessage?.({ data: JSON.stringify({ type: "tick", t: i * 0.064 }) }); // 5초마다
    }
    expect(sockets[0].readyState).toBe(1);
    expect(t.state.lines).toEqual([]); // tick은 화면에 안 닿는다
    for (let i = 0; i < 240; i++) {
      now += 64;
      t.c.sendPcm(frame);
    }
    expect(sockets[0].readyState).toBe(3);
    t.c.close();
  });

  it("소리가 늦게 흐르기 시작해도(마이크 허락 기다림) 그 대기를 멎음으로 치지 않는다", async () => {
    vi.stubGlobal("WebSocket", Sock);
    const t = make((async () => Response.json({})) as typeof fetch);
    await t.c.connectVoice();
    const now = Date.now() + 20_000; // 열고 20초 뒤에 첫 소리
    vi.spyOn(Date, "now").mockImplementation(() => now);
    t.c.sendPcm(new ArrayBuffer(2048));
    expect(sockets[0].readyState).toBe(1);
    t.c.close();
  });

  it("두뇌가 500·연결 실패여도 받아쓰기는 계속 넘기고, 알림은 한 번만 띄운다", async () => {
    let n = 0;
    const t = make((async () => {
      n++;
      if (n === 2) throw new Error("down");
      return new Response("err", { status: 500 });
    }) as typeof fetch);
    t.c.forwarding = true;
    for (let i = 1; i <= 3; i++) {
      t.c.onVoice({ type: "final", id: i, t0: 0, t1: 1, text: `말 ${i}` });
      await sleep(5);
    }
    expect(n).toBe(3); // 실패해도 다음 말을 계속 보낸다
    expect(t.state.conn.brain).toBe("error");
    expect(t.state.toast?.text).toContain("미티 두뇌가 응답하지 않아요");
    const first = t.state.toast!.id;
    t.c.onVoice({ type: "final", id: 4, t0: 0, t1: 1, text: "말 4" });
    await sleep(5);
    expect(t.state.toast!.id).toBe(first); // 30초 안엔 다시 안 띄움
    expect(t.state.lines.map((l) => l.text)).toEqual(["말 1", "말 2", "말 3", "말 4"]); // 화면엔 다 보인다
  });

  it("회의 열쇠가 틀리면(401) 그렇게 알린다", async () => {
    const t = make((async () => new Response("no", { status: 401 })) as typeof fetch);
    t.c.forwarding = true;
    t.c.onVoice({ type: "final", id: 1, t0: 0, t1: 1, text: "안녕" });
    await sleep(5);
    expect(t.state.toast?.text).toContain("회의 열쇠");
  });
});
