"""Soniox 왕복 지연(한국 → 리전): 연결 시간, finalize를 보내고 <fin>이 올 때까지, 소리를 보내고 그 글자가 처음 올 때까지.

사용: MEETY_ENV_FILE=…/.env.local voice/.venv/bin/python voice/eval/soniox_rtt.py [URL]   (기본 stt-rt.soniox.com, 미국)
소리는 시나리오 A(맥 목소리 합성) 앞 6초 — 실제 사람 녹음은 보내지 않는다. 비용: 번당 약 6초 ≈ $0.0002.
"""

import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

import soundfile as sf

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
import stt_soniox  # noqa: E402


async def once(url: str, pcm: bytes) -> dict:
    stt_soniox.URL = url
    s = stt_soniox.SonioxSTT([], 0)
    t = time.monotonic()
    await s.connect()
    conn = time.monotonic() - t
    first = None
    step = 16000 * 2 // 10  # 0.1초씩 실시간으로
    t0 = time.monotonic()
    for k in range(0, len(pcm), step):
        await s.send(pcm[k : k + step])
        if first is None and (s.final or s.nonfinal):
            first = time.monotonic() - t0
        await asyncio.sleep(0.1)
    want = s.fins + 1
    t = time.monotonic()
    await s.ws.send(json.dumps({"type": "finalize"}))
    while s.fins < want and time.monotonic() - t < 5:
        await asyncio.sleep(0.005)
    fin = time.monotonic() - t
    await s.close()
    return {"연결": round(conn * 1000), "첫 글자(보내기 시작부터)": round(first * 1000) if first else None, "finalize→<fin>": round(fin * 1000)}


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "wss://stt-rt.soniox.com/transcribe-websocket"
    a, sr = sf.read(str(VOICE / "recordings" / "A-meeting.wav"), dtype="int16")
    pcm = a[: 6 * sr].tobytes()
    rows = [await once(url, pcm) for _ in range(5)]
    for r in rows:
        print(r, flush=True)
    print(url, {k: statistics.median([r[k] for r in rows if r[k] is not None]) for k in rows[0]})


if __name__ == "__main__":
    asyncio.run(main())
