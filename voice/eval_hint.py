"""받아쓰기 힌트("미티야,") 효과와 부작용을 잰다. 서버 없이 segmenter만 쓴다.

사용: voice/.venv/bin/python voice/eval_hint.py 호출어.wav [짧은말을_뽑을.wav ...]
  1) 호출어.wav를 말 단위로 잘라 힌트 없음/있음으로 받아써서 "미티"가 몇 번 나오는지
  2) 짧은 소리(맞장구·잡음, 1.2초 미만)에 힌트를 줬을 때 힌트를 그대로 읊는지
"""

import re
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

from segmenter import FRAME, SR, Segmenter, transcribe

NAMES = "기헌, 준영, 태은, 지호"
PROMPTS = {
    "없음": None,
    "미티야,": "미티야,",
    "미티야, 이름들": f"미티야, {NAMES}",
    "이름들, 미티": f"{NAMES}, 미티",
    "참석자 문장 (서버 기본)": f"회의 참석자는 {NAMES}, 그리고 AI 팀원 미티.",
    "이름 없을 때 (서버 기본)": "회의에는 AI 팀원 미티도 참석해요.",
}
ECHO = re.compile(r"미티|기헌|준영|태은|지호")
SHORT_SAYS = ["네.", "응.", "음.", "아.", "좋아.", "그래요.", "맞아요.", "어?"]
SHORT_WAKE = ["미티야.", "미티야?", "미티.", "미티야, 잠깐."]  # 짧아도 호출어는 받아써야 한다


def segments(path: str, short_only: bool = False) -> list[np.ndarray]:
    a, _ = sf.read(path, dtype="float32")
    a = np.concatenate([a, np.zeros(SR, np.float32)])
    seg, out = Segmenter(), []
    for k in range(0, len(a) - FRAME, FRAME):
        out += [e[3] for e in seg.feed(a[k : k + FRAME]) if e[0] == "end" and (not short_only or len(e[3]) < SR * 1.2)]
    return out


def say_clips(lines: list[str]) -> list[np.ndarray]:
    clips = []
    with tempfile.TemporaryDirectory() as d:
        for i, t in enumerate(lines):
            subprocess.run(["say", "-v", "Yuna", "-o", f"{d}/{i}.aiff", t], check=True)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{d}/{i}.aiff", "-ac", "1", "-ar", str(SR), f"{d}/{i}.wav"], check=True)
            clips.append(sf.read(f"{d}/{i}.wav", dtype="float32")[0])
    return clips


def noise_clips() -> list[np.ndarray]:
    rng = np.random.default_rng(0)
    return [rng.normal(0, s, int(SR * d)).astype(np.float32) for s, d in [(0.01, 0.5), (0.02, 0.8), (0.05, 1.0)]]


def main():
    wake = segments(sys.argv[1])
    print(f"## 호출어 ({len(wake)}마디)")
    for name, p in PROMPTS.items():
        texts = [transcribe(x, p) for x in wake]
        print(f"- {name}: 미티 {sum(len(re.findall('미티', t)) for t in texts)}번 | " + " / ".join(texts))
    short = say_clips(SHORT_SAYS) + noise_clips() + [x for f in sys.argv[2:] for x in segments(f, short_only=True)]
    short_wake = say_clips(SHORT_WAKE)
    print(f"\n## 짧은 소리 {len(short)}개 (say 맞장구 {len(SHORT_SAYS)} + 잡음 3 + 실제 녹음 짧은 마디) / 짧은 호출 {len(short_wake)}개")
    for name, p in PROMPTS.items():
        texts = [transcribe(x, p) for x in short]
        echo = [t for t in texts if ECHO.search(t)]
        wake_texts = [transcribe(x, p) for x in short_wake]
        hit = sum("미티" in t for t in wake_texts)
        print(f"- {name}: 힌트를 읊음 {len(echo)}/{len(short)} {echo} | 짧은 호출 {hit}/{len(short_wake)} {wake_texts}")


if __name__ == "__main__":
    main()
