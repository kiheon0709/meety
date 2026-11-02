import { withMeeting, type Ctx } from "@/lib/live/http";
import { statusOf, subscribe, type OutEvent } from "@/lib/live/meeting";

export const dynamic = "force-dynamic";

// SSE. 이벤트 하나당 `data: <json>\n\n`.
//   ?replay=1  지난 이벤트부터 다시 보냄 (화면을 새로 열었을 때. speak는 다시 틀지 말 것)
//   prepare 이벤트는 늘 보낸다 (계약). 회의 열쇠는 ?token= 으로
export async function GET(req: Request, ctx: Ctx) {
  return withMeeting(req, ctx, (m) => {
    const url = new URL(req.url);
    const replay = url.searchParams.get("replay") === "1";
    const enc = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const send = (ev: OutEvent) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          } catch {
            cleanup();
          }
        };
        if (replay) for (const e of m.events) send(e.ev);
        const unsub = subscribe(m, send);
        // 판단이 쉬거나 꺼진 상태면 새로 붙은 화면도 알 수 있게 지금 상태부터 (계약 확장 status)
        if (m.health.state !== "ok") send(statusOf(m));
        const ping = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: ping\n\n`));
          } catch {
            cleanup();
          }
        }, 15_000);
        cleanup = () => {
          clearInterval(ping);
          unsub();
        };
        req.signal.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  });
}
