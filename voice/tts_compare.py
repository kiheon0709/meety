"""한국어 TTS 비교: 미티 대사 3개를 엔진·목소리별로 읽혀서 첫 소리까지 걸린 시간과 샘플을 남긴다.

사용: voice/.venv/bin/python voice/tts_compare.py
  voice/recordings/tts-compare/{엔진}-{목소리}-{n}.wav   듣기 샘플
  voice/recordings/tts-compare/results.json             잰 값
지금 어댑터는 문장을 다 만든 뒤 한 번에 돌려주므로 "첫 소리까지" = 문장 하나 만드는 시간이다.
알아듣기 쉬운지 대신 보려고, 만든 소리를 받아쓰기(whisper)로 다시 받아써서 원문과 글자 차이(CER)도 잰다.
"""

import json
import statistics
import time
from pathlib import Path

import numpy as np
import soundfile as sf

import tts.config as config
from replay import cer
from segmenter import SR, transcribe
from tts import mms, say, supertonic

OUT = Path(__file__).parent / "recordings" / "tts-compare"
# 시나리오 A·B에서 미티가 하는 말 (S3가 실제로 만들 문장과 다를 수 있다)
LINES = [
    "잠깐만요. 10월 10일 회의에서 입구는 웹 중심, 디스코드 봇은 2단계로 정했어요. 바꾸면 그 결정을 다시 여는 거예요.",
    "알겠어요, 이제 화면에 손만 들게요.",
    "기획 문서에는 끼어드는 강도가 상, 중, 하 세 단계로 되어 있어요.",
]


def to16k(path: Path) -> np.ndarray:
    a, sr = sf.read(str(path), dtype="float32", always_2d=True)
    a = a[:, 0]
    if sr != SR:
        a = np.interp(np.arange(0, len(a), sr / SR), np.arange(len(a)), a).astype(np.float32)
    return a


def setup_supertonic(model: str, steps: int):
    def f():
        config.SUPERTONIC_MODEL, config.SUPERTONIC_STEPS = model, steps
        supertonic._tts = None
        supertonic._styles.clear()
        supertonic.load()
    return f


# (이름, 어댑터, 목소리, 준비 함수)
CANDIDATES = [
    ("say", say, "Yuna", None),
    ("say", say, "Sandy", None),
    ("supertonic3", supertonic, "F1", setup_supertonic("supertonic-3", 8)),
    ("supertonic3", supertonic, "F3", setup_supertonic("supertonic-3", 8)),
    ("supertonic3", supertonic, "M1", setup_supertonic("supertonic-3", 8)),
    ("supertonic3-4step", supertonic, "F1", setup_supertonic("supertonic-3", 4)),
    ("supertonic2", supertonic, "F1", setup_supertonic("supertonic-2", 8)),
    ("mms", mms, None, mms.load),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    transcribe(np.zeros(SR, np.float32))
    results = []
    for name, adapter, voice, prep in CANDIDATES:
        t = time.perf_counter()
        if prep:
            prep()
        load_s = time.perf_counter() - t
        rows = []
        for n, line in enumerate(LINES, 1):
            out = OUT / f"{name}-{voice or 'default'}-{n}.wav"
            # 한 번 데우고(첫 호출은 그래프 준비로 느림) 두 번째를 잰다
            adapter.synth(line, out, voice)
            t = time.perf_counter()
            adapter.synth(line, out, voice)
            ms = (time.perf_counter() - t) * 1000
            dur = sf.info(str(out)).duration
            heard = transcribe(to16k(out))
            rows.append({"n": n, "first_sound_ms": round(ms), "audio_s": round(dur, 2), "rtf": round(ms / 1000 / dur, 3), "heard": heard, "cer": round(cer(line, heard), 3)})
        r = {"engine": name, "voice": voice, "load_s": round(load_s, 1), "lines": rows,
             "first_sound_ms_median": round(statistics.median(x["first_sound_ms"] for x in rows)),
             "cer_mean": round(statistics.mean(x["cer"] for x in rows), 3)}
        results.append(r)
        print(f"{name:18} {voice or '-':6} 준비 {r['load_s']:5}s  첫 소리 {[x['first_sound_ms'] for x in rows]}ms  CER {r['cer_mean']}  {[x['heard'] for x in rows]}")
    (OUT / "results.json").write_text(json.dumps({"lines": LINES, "results": results}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
