"""단계별 지연 기록(server.py lat_*)이 제대로 남나 + 포스터 그래프 재료: 녹음을 /ws로 흘리고, final마다 "두뇌"를 흉내 내
(정해 둔 시간 뒤) /tts/stream으로 대답을 청해 첫 조각이 오면 화면처럼 tts on을 보낸다. 끝나면 data/meeting-logs/latency-날짜.jsonl의 새 줄을 표로.

사용: (음성 서버를 켠 뒤) voice/.venv/bin/python voice/eval/latency_demo.py 녹음.wav [포트] [두뇌ms=800]
"""

import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

VOICE = Path(__file__).resolve().parent.parent
LOG = VOICE.parent / "data" / "meeting-logs" / f"latency-{time.strftime('%Y%m%d')}.jsonl"


async def main():
    wav, port = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8773
    brain = (float(sys.argv[3]) if len(sys.argv) > 3 else 800) / 1000
    before = LOG.read_text().count("\n") if LOG.exists() else 0
    a, sr = sf.read(wav, dtype="int16")
    a = np.concatenate([a, np.zeros(3 * sr, np.int16)])
    loop = asyncio.get_running_loop()
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws", max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "save": False}))

        def answer(text):
            r = urllib.request.Request(f"http://127.0.0.1:{port}/tts/stream", data=json.dumps({"text": text}).encode(), headers={"content-type": "application/json"}, method="POST")
            resp = urllib.request.urlopen(r)
            resp.read1(1)
            return resp

        async def reply(final_text):
            await asyncio.sleep(brain)  # 두뇌 흉내
            text = f"네, {final_text[:12]} 말씀이죠. 정리해 둘게요."
            resp = await loop.run_in_executor(None, answer, text)
            await ws.send(json.dumps({"type": "tts", "on": True, "text": text}))  # 화면: 첫 조각이 오면 재생 + tts on
            await loop.run_in_executor(None, resp.read)
            await ws.send(json.dumps({"type": "tts", "on": False}))

        async def rx():
            async for m in ws:
                e = json.loads(m)
                if e["type"] == "final" and e.get("text") and not e.get("echo"):
                    asyncio.create_task(reply(e["text"]))

        task = asyncio.create_task(rx())
        step = sr // 50
        t0 = time.monotonic()
        for k in range(0, len(a), step):
            await ws.send(a[k : k + step].tobytes())
            await asyncio.sleep(max(0, t0 + (k + step) / sr - time.monotonic()))
        await asyncio.sleep(4)
        task.cancel()
    rows = [json.loads(l) for l in LOG.read_text().splitlines()[before:]]
    keys = ["말끝판정", "받아쓰기", "두뇌", "목소리첫조각", "재생시작", "말끝→첫소리"]
    print("| 턴 | " + " | ".join(keys) + " |")
    for r in rows:
        print(f"| {r['text'][:14]} | " + " | ".join(str(r.get(k)) for k in keys) + " |")
    if rows:
        print("| 중앙 | " + " | ".join(str(int(np.median([r[k] for r in rows if r.get(k) is not None]))) if any(r.get(k) is not None for r in rows) else "-" for k in keys) + " |")


if __name__ == "__main__":
    asyncio.run(main())
