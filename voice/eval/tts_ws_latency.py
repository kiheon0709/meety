"""글 조각 입력(/tts/ws) 첫 소리: 두뇌가 글을 초당 N자로 쓰는 것처럼 흘려 넣고, 첫 글자를 보낸 때부터 첫 소리 조각까지 잰다.
문장을 다 받은 뒤 /tts/stream으로 청할 때와 비교한다.

사용: (음성 서버를 켠 뒤) voice/.venv/bin/python voice/eval/tts_ws_latency.py [포트] [초당 글자=40]
"""

import asyncio
import json
import sys
import time
import urllib.request

import websockets

ANSWERS = ["기록엔 없지만 제 생각엔 화면부터 정하는 게 먼저예요. 그다음에 디자인 기준을 같이 보면 좋겠어요.",
           "음, 지난번 회의에서는 웹을 먼저 하기로 했어요. 디스코드는 다음 단계로 미뤘고요.",
           "좋아요, 그럼 리허설은 일요일 저녁으로 하고 담당은 지호 님이 맡는 걸로 할게요."]


async def via_ws(port, text, cps, tag):
    async with websockets.connect(f"ws://127.0.0.1:{port}/tts/ws", max_size=None) as ws:
        t0 = time.monotonic()
        first = None
        segs = []

        async def feed():
            for k in range(0, len(text), 2):
                await ws.send(json.dumps({"type": "text", "text": text[k : k + 2] + (tag if k + 2 >= len(text) else "")}))
                await asyncio.sleep(2 / cps)
            await ws.send(json.dumps({"type": "end"}))

        f = asyncio.create_task(feed())
        async for m in ws:
            if isinstance(m, bytes):
                first = first or time.monotonic() - t0
            else:
                d = json.loads(m)
                if d["type"] == "segment":
                    segs.append(d["text"])
                if d["type"] == "done":
                    break
        await f
        return first, len(text) / cps, segs


def via_stream(port, text):
    t0 = time.monotonic()
    r = urllib.request.Request(f"http://127.0.0.1:{port}/tts/stream", data=json.dumps({"text": text}).encode(), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(r) as resp:
        resp.read1(1)
    return time.monotonic() - t0


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8773
    cps = float(sys.argv[2]) if len(sys.argv) > 2 else 40
    for i, a in enumerate(ANSWERS):
        first, write_s, segs = await via_ws(port, a, cps, f" ({i}w)")
        n1 = (a.find(". ") + 1) or len(a)
        sent1 = a[:n1] + f" ({i}s)"
        whole = n1 / cps + via_stream(port, sent1)  # 첫 문장을 다 받은 뒤 청할 때: 첫 문장 쓰는 시간 + 첫 조각
        print(f"글 조각 입력 첫 소리 {first * 1000:.0f}ms | 첫 문장 다 받고 청하면 {whole * 1000:.0f}ms | 글 다 쓰는 데 {write_s:.1f}초 | 구: {segs}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
