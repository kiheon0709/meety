"""스트리밍 목소리 엔진의 공통 부분: HTTP로 PCM16 조각을 받아 오는 대로 넘긴다 (첫 소리까지 = 첫 조각까지).

엔진 어댑터(elevenlabs·typecast·openai_tts)는 request(text, voice) → (url, headers, body, 샘플레이트)만 정한다.
synth(text, out)은 조각을 다 모아 wav로 쓴다 (서버 캐시·에코 기준 소리가 그대로 동작). stream()은 첫 소리를 재는 데 쓴다.
키가 없으면 NoKey를 던지고, tts.synth가 Supertonic으로 되돌린다.
"""

import json
import os
import urllib.request
import wave
from pathlib import Path
from typing import Iterator


class NoKey(RuntimeError):
    pass


def need(env: str) -> str:
    v = os.environ.get(env, "").strip()
    if not v:
        raise NoKey(f"{env}가 없어요 (기헌 결정 대기) — Supertonic으로 읽어요")
    return v


def stream(req: tuple[str, dict, dict, int], chunk: int = 4096) -> Iterator[bytes]:
    url, headers, body, _ = req
    r = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **headers}, method="POST")
    with urllib.request.urlopen(r, timeout=20) as resp:
        read = getattr(resp, "read1", resp.read)  # read1: 와 있는 만큼 바로 (read는 chunk를 다 채울 때까지 기다린다)
        while True:
            b = read(chunk)
            if not b:
                break
            yield b


def write_wav(chunks: Iterator[bytes], out: Path, sr: int) -> Path:
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        rest = b""
        for b in chunks:
            b = rest + b
            n = len(b) // 2 * 2  # 조각이 바이트 반쪽에서 끊길 수 있다
            w.writeframes(b[:n])
            rest = b[n:]
    return out
