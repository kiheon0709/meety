"""화자 찾기 정확도를 임계값별로 잰다. 서버 없이 speakers.py만 쓴다.

사용: voice/.venv/bin/python voice/eval_speakers.py [멘토링녹화본.mp4]
  가짜 회의: recordings/enroll.wav로 4명 등록 → speakers-test·A-meeting·wake의 마디마다 찾기 (민수는 등록 안 한 사람)
  실제 녹음(주면): 멘토·기헌을 5초씩 등록 → 전사의 다른 시각 4초씩 찾기
fake_meeting은 Yuna 한 목소리를 높낮이만 바꾼 것이라, 진짜 다른 사람끼리보다 쉽거나 어려울 수 있다.
"""

import json
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

from speakers import embed

THRESHOLDS = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]


def turns_audio(name: str):
    a, sr = sf.read(f"recordings/{name}.wav", dtype="float32")
    for u in json.load(open(f"recordings/{name}.turns.json")):
        yield u["speaker"], a[int(u["t0"] * sr) : int(u["t1"] * sr)]


def score(enrolled: dict, tests: list[tuple[str, np.ndarray]]) -> dict:
    rows = []
    for who, x in tests:
        v = embed(x)
        if v is None:
            continue
        sims = {k: float(v @ e) for k, e in enrolled.items()}
        rows.append((who, max(sims, key=sims.get), max(sims.values()), sims))
    out = {}
    for th in THRESHOLDS:
        ok = wrong = unknown_known = unknown_ok = imp_named = 0
        for who, best, s, _ in rows:
            named = best if s >= th else None
            if who in enrolled:
                ok += named == who
                wrong += named is not None and named != who
                unknown_known += named is None
            else:
                unknown_ok += named is None
                imp_named += named is not None
        out[th] = {"맞음": ok, "다른 사람으로": wrong, "모름(등록된 사람)": unknown_known, "모름(등록 안 된 사람, 맞음)": unknown_ok, "등록 안 된 사람에 이름 붙임": imp_named}
    return {"n": len(rows), "by_threshold": out, "rows": [(w, b, round(s, 3)) for w, b, s, _ in rows]}


def clip(mp4: str, start: float, dur: float) -> np.ndarray:
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(start), "-t", str(dur), "-i", mp4, "-vn", "-ac", "1", "-ar", "16000", f.name], check=True)
        return sf.read(f.name, dtype="float32")[0]


def ts(s: str) -> float:
    p = [int(x) for x in s.split(":")]
    return p[0] * 3600 + p[1] * 60 + p[2] if len(p) == 3 else p[0] * 60 + p[1]


def main():
    enrolled = {who: embed(x) for who, x in turns_audio("enroll")}
    tests = [t for n in ("speakers-test", "A-meeting", "wake") for t in turns_audio(n)]
    fake = score(enrolled, tests)
    print("## 가짜 회의 (Yuna 높낮이), 마디", fake["n"])
    for th, r in fake["by_threshold"].items():
        print(f"- {th}: {r}")
    res = {"fake": fake}
    if len(sys.argv) > 1:
        mp4 = sys.argv[1]
        # 전사(docs/mentoring/2026-10-29) 시각에서 3초 들어간 곳. 말 첫머리는 앞사람과 겹칠 수 있어서
        enrolled = {"멘토": embed(clip(mp4, ts("1:00"), 5)), "기헌": embed(clip(mp4, ts("11:53"), 5))}
        tests = [("기헌", clip(mp4, ts(t) + 3, 4)) for t in ["15:50", "32:09", "36:29", "53:09", "58:00", "1:00:18"]]
        tests += [("멘토", clip(mp4, ts(t) + 3, 4)) for t in ["12:48", "17:32", "32:47", "37:52", "52:29", "55:07", "59:27", "1:01:48", "1:06:15"]]
        real = score(enrolled, tests)
        print("\n## 실제 녹음 (멘토링, 2명), 조각", real["n"])
        for th, r in real["by_threshold"].items():
            print(f"- {th}: {r}")
        print("  ", real["rows"])
        res["real"] = real
    json.dump(res, open("recordings/eval_speakers.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
