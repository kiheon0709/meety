"""새 역할(owner_gap·feedback·research·structure·질문형 conflict) 대사를 지금 TTS로 구워 목소리 고르기 자료를 만든다.

사용: voice/.venv/bin/python voice/eval/tts_roles.py
  voice/recordings/tts-compare/roles/{엔진}-{목소리}-{n}.wav   듣기 샘플
  voice/recordings/tts-compare/roles/results.json             잰 값
첫 소리 = 한 번 데운 뒤 문장 하나 만드는 시간 (지금 어댑터는 다 만든 뒤 한 번에 돌려준다).
질문 꼴이라 끝을 올려 읽는지가 중요해서, 마지막 0.35초와 그 앞 0.35~1.2초의 음높이(중앙값) 차이를 반음으로 잰다.
"""

import json
import statistics
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from replay import cer  # noqa: E402
from segmenter import SR, transcribe  # noqa: E402
from tts import say, supertonic  # noqa: E402
from tts_compare import setup_supertonic, to16k  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "recordings" / "tts-compare" / "roles"
# (역할, 대사) — docs/architecture/brain-design.md 표의 예시 대사
LINES = [
    ("owner_gap", "이건 누가 맡을까요?"),
    ("owner_gap", "이 일은 누가 맡나요?"),
    ("feedback", "다른 안은 없었나요?"),
    ("feedback", "정하기 전에, 지난번에 걱정했던 일정은 괜찮을까요?"),
    ("conflict", "10월 10일엔 디스코드 봇을 2단계로 정했는데, 바꾸는 건가요?"),
    ("structure", "두 입장을 한 줄씩 정리해 볼까요?"),
    ("research", "10월 29일 회의 기록에는 마감이 11월 2일로 되어 있어요."),
]

CANDIDATES = [
    ("say", say, "Yuna", None),
    ("supertonic3", supertonic, "F1", setup_supertonic("supertonic-3", 4)),  # 지금 기본값
    ("supertonic3", supertonic, "F2", None),
    ("supertonic3", supertonic, "F3", None),
    ("supertonic3", supertonic, "F4", None),
    ("supertonic3", supertonic, "F5", None),
    ("supertonic3", supertonic, "M1", None),
    ("supertonic3", supertonic, "M2", None),
]


def end_rise(path: Path) -> float | None:
    a, sr = librosa.load(str(path), sr=16000)
    a, _ = librosa.effects.trim(a, top_db=35)
    f0, voiced, _ = librosa.pyin(a, fmin=70, fmax=500, sr=sr, frame_length=1024)
    t = librosa.times_like(f0, sr=sr, hop_length=256)
    end = len(a) / sr
    last = f0[(t > end - 0.35) & voiced]
    before = f0[(t > end - 1.2) & (t <= end - 0.35) & voiced]
    if len(last) < 3 or len(before) < 3:
        return None
    return round(float(12 * np.log2(np.median(last) / np.median(before))), 1)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    transcribe(np.zeros(SR, np.float32))
    results = []
    for name, adapter, voice, prep in CANDIDATES:
        if prep:
            prep()
        rows = []
        for n, (role, line) in enumerate(LINES, 1):
            out = OUT / f"{name}-{voice}-{n}.wav"
            adapter.synth(line, out, voice)  # 데우기
            t = time.perf_counter()
            adapter.synth(line, out, voice)
            ms = (time.perf_counter() - t) * 1000
            heard = transcribe(to16k(out))
            rows.append({"n": n, "role": role, "first_sound_ms": round(ms), "audio_s": round(sf.info(str(out)).duration, 2),
                         "rise_st": end_rise(out), "heard": heard, "cer": round(cer(line, heard), 3)})
        q = [x["rise_st"] for x in rows[:6] if x["rise_st"] is not None]  # 1~6은 질문, 7은 평서문
        r = {"engine": name, "voice": voice, "lines": rows,
             "first_sound_ms_median": round(statistics.median(x["first_sound_ms"] for x in rows)),
             "first_sound_ms_max": max(x["first_sound_ms"] for x in rows),
             "cer_mean": round(statistics.mean(x["cer"] for x in rows), 3),
             "question_rise_st_median": round(statistics.median(q), 1) if q else None}
        results.append(r)
        print(f"{name:12} {voice:5} 첫 소리 {[x['first_sound_ms'] for x in rows]}ms 길이 {[x['audio_s'] for x in rows]} "
              f"끝 올림 {[x['rise_st'] for x in rows]} CER {r['cer_mean']}", flush=True)
        for x in rows:
            if x["cer"] > 0:
                print(f"   {x['n']}: {x['heard']}", flush=True)
    (OUT / "results.json").write_text(json.dumps({"lines": LINES, "results": results}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
