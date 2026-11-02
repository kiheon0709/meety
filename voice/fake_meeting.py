"""녹취(이름: 말)를 맥 목소리로 읽어 가짜 다자 회의 녹음을 만든다. 재생 평가 장치 점검용.

사용: voice/.venv/bin/python voice/fake_meeting.py 녹취.txt 출력.wav
출력.wav 옆에 출력.turns.json(누가 몇 초부터 몇 초까지 말했는지)도 만든다.
"""

import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
# 맥에서 파일로 나오는 한국어 목소리는 Yuna뿐이라, 높낮이를 바꿔 사람을 나눈다
PITCHES = [1.0, 0.82, 1.15, 0.9, 1.07, 0.75]


def trim(a: np.ndarray, floor: float = 0.005) -> np.ndarray:
    # say는 앞뒤에 0.2초쯤 조용한 꼬리를 붙인다. 그대로 두면 turns.json의 끝 시각이 실제 목소리보다 늦어서 gap 정답이 틀어진다
    w = SR // 100
    rms = np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1))
    on = np.where(rms > floor)[0]
    return a[on[0] * w : (on[-1] + 1) * w] if len(on) else a


def main(src: str, out: str, seed: int = 0):
    rng = random.Random(seed)
    lines = [l.split(":", 1) for l in Path(src).read_text().splitlines() if ":" in l]
    voice_of: dict[str, float] = {}
    chunks, turns, t = [], [], 0.0
    with tempfile.TemporaryDirectory() as d:
        for i, (who, text) in enumerate(lines):
            who, text = who.strip(), text.strip()
            p = voice_of.setdefault(who, PITCHES[len(voice_of) % len(PITCHES)])
            aiff, wav = f"{d}/{i}.aiff", f"{d}/{i}.wav"
            subprocess.run(["say", "-v", "Yuna", "-o", aiff, text], check=True)
            af = f"asetrate=22050*{p},aresample={SR},atempo={1 / p:.4f}"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", aiff, "-af", af, "-ac", "1", wav], check=True)
            a = trim(sf.read(wav, dtype="float32")[0])
            # 사람 사이 틈: 대부분 0.3~1.2초, 가끔 길게
            gap = rng.choice([0.3, 0.5, 0.7, 0.9, 1.2, 2.0])
            chunks += [np.zeros(int(gap * SR), np.float32), a]
            t += gap
            turns.append({"speaker": who, "t0": round(t, 2), "t1": round(t + len(a) / SR, 2), "text": text})
            t += len(a) / SR
    chunks.append(np.zeros(SR, np.float32))
    audio = np.concatenate(chunks)
    audio += np.random.default_rng(seed).normal(0, 0.002, len(audio)).astype(np.float32)  # 약한 잡음
    sf.write(out, audio, SR)
    Path(out).with_suffix(".turns.json").write_text(json.dumps(turns, ensure_ascii=False, indent=1))
    print(f"{out}: {len(audio) / SR:.1f}초, {len(turns)}마디, 높낮이 {voice_of}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
