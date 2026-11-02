"""Soniox 자체 말 끝 판단(enable_endpoint_detection, <end> 조각)이 대본 말 경계와 얼마나 맞나 — 우리 silero 500ms·Smart Turn과 비교용.

사용: MEETY_ENV_FILE=…/.env.local voice/.venv/bin/python voice/eval/soniox_endpoint.py 이름…   (voice/recordings/stable/{이름}.wav·.turns.json, 맥 목소리 대본만)
실시간으로 흘리고 <end>가 온 오디오 시각을 적는다. 말 끝 판정 = <end> 직전 확정 글자의 end_ms. 말 중간(다음 말 시작 전 0.3초 넘게 남음)에서 <end>면 "잘림".
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
import stt_soniox  # noqa: E402

D = VOICE / "recordings" / "stable"


async def one(name: str, delay_ms: int) -> dict:
    a, sr = sf.read(str(D / f"{name}.wav"), dtype="int16")
    a = np.concatenate([a, np.zeros(3 * sr, np.int16)])
    turns = json.loads((D / f"{name}.turns.json").read_text())
    ends, sent, last_end_ms = [], 0, 0
    async with websockets.connect(stt_soniox.URL, additional_headers={"Authorization": f"Bearer {stt_soniox.api_key()}"}, max_size=None) as ws:
        await ws.send(json.dumps({"model": stt_soniox.MODEL, "audio_format": "pcm_s16le", "sample_rate": 16000, "num_channels": 1, "language_hints": ["ko"],
                                  "enable_endpoint_detection": True, "max_endpoint_delay_ms": delay_ms}))

        async def rx():
            nonlocal last_end_ms
            async for m in ws:
                d = json.loads(m)
                for t in d.get("tokens", []):
                    if t["text"] == "<end>":
                        ends.append((sent / sr, last_end_ms / 1000))
                    elif t.get("is_final") and "end_ms" in t:
                        last_end_ms = t["end_ms"]
                if d.get("finished"):
                    return

        task = asyncio.create_task(rx())
        step, t0 = sr // 10, time.monotonic()
        for k in range(0, len(a), step):
            await ws.send(a[k : k + step].tobytes())
            sent = min(k + step, len(a))
            await asyncio.sleep(max(0, t0 + sent / sr - time.monotonic()))
        await ws.send("")
        await asyncio.wait_for(task, 10)
    lat, cut = [], 0
    for at, speech_end in ends:
        # 정답 말(turns) 안이나 끝 1초 안에서 난 <end>만 센다 — 녹음의 다른 소리(미티 목소리 등)에서 난 것은 뺀다
        if not any(u["t0"] - 0.3 <= speech_end <= u["t1"] + 1.0 for u in turns):
            continue
        u = min(turns, key=lambda u: abs(u["t1"] - speech_end))
        nxt = next((v["t0"] for v in turns if v["t0"] > u["t1"]), 1e9)
        if speech_end < u["t1"] - 0.3:
            cut += 1  # 말 중간에서 끝났다고 봄
        else:
            lat.append((at - u["t1"]) * 1000)
    return {"이름": name, "말": len(turns), "<end>": len(ends), "말 중간 <end>": cut, "말 끝→<end> ms 중앙": int(np.median(lat)) if lat else None,
            "p90": int(np.percentile(lat, 90)) if lat else None, "max_endpoint_delay_ms": delay_ms, "보낸 분": round(len(a) / sr / 60, 2)}


async def main():
    for name in sys.argv[1:]:
        print(json.dumps(await one(name, 500), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
