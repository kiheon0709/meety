// 가짜 두뇌: 모델 없이 계약대로 대답하는 작은 서버. 화면·노드 클라이언트의 배선만 확인한다.
// 시나리오 A의 [미티 기대]를 낱말 몇 개로 흉내 낸다 (판단 품질 시험이 아님).
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChecklistItem, Intensity, MeetingInfo, StartMeetingReq } from "../../src/lib/live/contract";
import type { AgentEventX } from "../../src/components/live/state";
import { GAP_MS } from "../../src/lib/live/contract";

export interface BrainCall {
  at: number;
  method: string;
  path: string;
  body?: unknown;
  token?: string; // 회의 열쇠 (헤더 x-live-token 또는 ?token=)
}

const has = (t: string, ...ws: string[]) => ws.every((w) => t.replace(/\s/g, "").includes(w));

// opts.broadcastPrivate: 사설을 모든 화면에 뿌리는 (잘못된/옛) 두뇌 흉내 — 화면 쪽 거르기를 시험할 때
export async function startFakeBrain(port = 0, opts: { broadcastPrivate?: boolean } = {}) {
  const calls: BrainCall[] = [];
  const sent: { at: number; ev: AgentEventX }[] = [];
  const clients = new Map<http.ServerResponse, string | null>(); // 스트림 → 연 사람(?me=, 없으면 공용 화면)
  let setup: StartMeetingReq | null = null;
  let intensity: Intensity = "high";
  let ended = false;
  const texts = new Map<number, string>();
  const quiet = new Map<number, number>(); // after_id → 가장 긴 gap
  let waiting: { actionId: string; afterId: number; sentences: string[] } | null = null;
  let seq = 0;
  const t0 = Date.now();
  const checklist: ChecklistItem[] = [];

  // 사설(private)은 공용 스트림에 안 싣고 받는 사람 스트림으로만 (security.md ⑪). to "host"는 공용(호스트) 화면으로
  const emit = (ev: AgentEventX) => {
    sent.push({ at: Date.now() - t0, ev });
    for (const [c, me] of clients) {
      if (ev.type === "private" && !opts.broadcastPrivate && (ev.to === "host" ? me !== null : me !== ev.to)) continue;
      c.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  };
  const speak = (actionId: string, kind: "conflict" | "ack" | "answer", sentences: string[]) =>
    emit({ type: "speak", actionId, kind, text: sentences.join(" "), sentences, evidence: kind === "conflict" ? [{ label: "10/10 회의 3 — 입구는 웹 중심, 디스코드 봇은 2단계" }] : [] });
  const trySpeak = () => {
    if (!waiting || intensity === "low") return;
    const q = quiet.get(waiting.afterId) ?? 0;
    // gap이 final보다 먼저 와도 버리지 않는다 (계약): 둘 다 와야 말한다
    if (texts.has(waiting.afterId) && q >= GAP_MS[intensity]) {
      const w = waiting;
      waiting = null;
      speak(w.actionId, "conflict", w.sentences);
    }
  };
  const done = (agenda: string, expected: string, note: string) => {
    if (!checklist.some((c) => c.expected === expected)) checklist.push({ agenda, expected, status: "done", note, evidence: [] });
    emit({ type: "checklist", items: [...checklist] });
  };

  const onUtterance = (b: { id: number; text: string; speaker?: string; echo?: boolean }) => {
    texts.set(b.id, b.text);
    const t = b.text;
    if (has(t, "순서로가자")) {
      emit({ type: "change_card", cardId: `c${++seq}`, title: "시연 영상 구성", to: "회의 장면 → 정리 화면 순서", evidence: [{ label: "오늘 회의", quote: t }] });
      done("시연 영상 구성", "장면 순서 확정", "회의 장면 → 정리 화면");
    } else if (has(t, "디스코드", "입구")) {
      const actionId = `a${++seq}`;
      const sentences = ["잠깐만요, 10월 10일 회의에서 입구는 웹 중심으로 하고 디스코드 봇은 2단계로 미루기로 정했어요.", "봇을 입구로 만들면 그 결정을 다시 여는 거예요."];
      emit({ type: "queued", actionId, kind: "conflict", preview: "10/10에 정한 '입구는 웹 중심'과 달라요" });
      emit({ type: "prepare", actionId, kind: "conflict", sentences });
      waiting = { actionId, afterId: b.id, sentences };
      trySpeak();
    } else if (has(t, "끼어들지")) {
      intensity = "low";
      waiting = null;
      emit({ type: "settings", intensity: "low", by: b.speaker ?? "누군가" });
      speak(`a${++seq}`, "ack", ["알겠어요, 이제 화면에 손만 들게요."]);
    } else if (has(t, "그걸로하자")) {
      emit({ type: "change_card", cardId: `c${++seq}`, title: "디스코드 연동 범위", from: "봇까지 만들어 입구를 디스코드로", to: "이번엔 알림만, 봇은 2단계 유지", evidence: [] });
      done("디스코드 연동 범위", "이번에 만들 범위 결정", "알림만");
    } else if (has(t, "붙여넣기만")) {
      emit({ type: "hand_raise", actionId: `h${++seq}`, kind: "conflict", preview: "'브라우저 녹음과 붙여넣기 함께 지원'과 달라요", evidence: [] });
    } else if (has(t, "리허설", "일요일")) {
      done("리허설", "날짜", "일요일 저녁");
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString();
      body = raw ? JSON.parse(raw) : undefined;
    }
    if (process.env.FAKE_BRAIN_LOG) console.log(req.method, url.pathname);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "content-type, x-live-token" });
      return res.end();
    }
    calls.push({ at: Date.now() - t0, method: req.method ?? "", path: url.pathname, body, token: req.headers["x-live-token"]?.toString() ?? url.searchParams.get("token") ?? undefined });
    const json = (v: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(v));
    };
    const m = url.pathname.match(/^\/api\/live\/([^/]+)(?:\/(\w+))?$/);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, action] = m;
    if (id === "start" && req.method === "POST") {
      setup = body as StartMeetingReq;
      intensity = setup.intensity;
      return json({ meetingId: "fake-1", controlToken: "fake-token" });
    }
    if (id === "docs") return json([]);
    if (!action && req.method === "GET") {
      const info: MeetingInfo = { ...(setup ?? { spaceId: "", title: "가짜 회의", agenda: [] }), meetingId: id, intensity, ended } as MeetingInfo;
      return json(info);
    }
    if (action === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      res.write(": hi\n\n");
      clients.set(res, url.searchParams.get("me"));
      req.on("close", () => clients.delete(res));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (body ?? {}) as any;
    switch (action) {
      case "utterance":
        onUtterance(b);
        break;
      case "gap":
        quiet.set(b.after_id, Math.max(quiet.get(b.after_id) ?? 0, b.ms));
        trySpeak();
        break;
      case "barge":
        for (const s of [...sent].reverse()) {
          if (s.ev.type === "speak") {
            emit({ type: "cancel", actionId: s.ev.actionId, reason: "barge_in" });
            break;
          }
        }
        break;
      case "respond":
        if (b.accept) speak(b.actionId, "conflict", ["10월 10일 회의에서 브라우저 녹음과 붙여넣기를 함께 지원하기로 바꿨어요."]);
        else emit({ type: "cancel", actionId: b.actionId, reason: "dismissed" });
        break;
      case "settings":
        intensity = b.intensity;
        emit({ type: "settings", intensity, by: "screen" });
        break;
      case "end": {
        ended = true;
        const items = [...checklist, { agenda: "리허설", expected: "담당자", status: "no_owner" as const, evidence: [] }];
        emit({ type: "checklist", items, final: true });
        return json({ sessionId: "se_fake", items });
      }
    }
    return json({ ok: true });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    calls,
    sent,
    emit, // 시험이 두뇌 이벤트를 직접 보낼 때
    close: () =>
      new Promise<void>((r) => {
        for (const c of clients.keys()) c.end();
        server.close(() => r());
      }),
  };
}
