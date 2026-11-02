"""온디바이스 실시간 받아쓰기 후보: WhisperLiveKit 0.2.26 (SimulStreaming 정책 + mlx-whisper large-v3-turbo, 이 맥).

서버: voice/cache/venvs/wlk/bin/wlk serve --backend mlx-whisper --backend-policy simulstreaming --model large-v3-turbo --lan ko --port 8792 --pcm-input
사용: voice/.venv/bin/python voice/eval/stt_wlk.py 녹음.wav [turns.json] [속도=1]
PCM16을 실시간으로 흘리고 응답마다 오디오 시계와 함께 남긴다. WLK는 말 차례로 끊지 않고 확정 글(lines)을 늘려 가서,
"말 i의 글이 확정된 때" = 마지막 확정 글에서 말 i의 끝 글자가 나오는 자리까지 확정 글이 자란 때로 어림한다.
"""

import asyncio
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
from replay import cer  # noqa: E402


def norm(s: str) -> str:
    return re.sub(r"[\s\W]", "", s)


async def run(wav: str, speed: float):
    a, sr = sf.read(wav, dtype="int16")
    a = np.concatenate([a, np.zeros(4 * sr, np.int16)])
    got = []
    async with websockets.connect("ws://127.0.0.1:8792/asr", max_size=None) as ws:
        sent = 0

        async def rx():
            async for m in ws:
                d = json.loads(m)
                if "lines" in d:
                    got.append((sent / sr, "".join(l.get("text", "") for l in d["lines"]), d.get("buffer_transcription", "")))

        task = asyncio.create_task(rx())
        step = sr // 10
        t0 = time.monotonic()
        for k in range(0, len(a), step):
            await ws.send(a[k : k + step].tobytes())
            sent = min(k + step, len(a))
            if speed:
                await asyncio.sleep(max(0, t0 + sent / sr / speed - time.monotonic()))
        await asyncio.sleep(8)
        task.cancel()
    return got


def main():
    wav = sys.argv[1]
    turns = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 and sys.argv[2] != "-" else None
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    got = asyncio.run(run(wav, speed))
    final = got[-1][1] if got else ""
    out = {"응답 수": len(got), "확정 글": final}
    if turns:
        ref = " ".join(u["text"] for u in turns)
        out["CER"] = round(cer(ref, final), 4)
        # 말 i의 끝 = 마지막 확정 글에서 그 말 끝 글자 3개(못 찾으면 2개)가 처음 나오는 곳(앞 말 다음부터)
        fin, pos, lat, part = norm(final), 0, [], []
        for u in turns:
            tail, idx = norm(u["text"]), -1
            for n in (3, 2):
                idx = fin.find(tail[-n:], pos)
                if idx >= 0 and idx - pos < len(tail) * 2:
                    idx += n
                    break
                idx = -1
            if idx < 0:
                lat.append(None), part.append(None)
                continue
            pos = idx
            t_fix = next((t for t, lines, _ in got if len(norm(lines)) >= idx), None)
            t_any = next((t for t, lines, buf in got if len(norm(lines + buf)) >= idx), None)
            lat.append(None if t_fix is None else round((t_fix - u["t1"]) * 1000))
            part.append(None if t_any is None else round((t_any - u["t1"]) * 1000))
        ok = [x for x in lat if x is not None]
        out["말 끝→확정 ms 중앙"] = int(np.median(ok)) if ok else None
        out["말 끝→(확정+임시) ms 중앙"] = int(np.median([x for x in part if x is not None])) if any(x is not None for x in part) else None
        out["말별 확정 ms"] = lat
    print(json.dumps(out, ensure_ascii=False))
    Path(wav).with_suffix(".wlk.json").write_text(json.dumps({"out": out, "got": got}, ensure_ascii=False))


if __name__ == "__main__":
    main()
