"""긴 말 끊기(VOICE_SOFT_CUT_S·VOICE_MAX_SPEECH_S)가 받아쓰기에 주는 영향. 멘토링 녹화 앞 15분(전사 [15:50] 앞까지)으로
끄기 vs 20초 강제(처음 버전) vs 15초 넘으면 쉼에서·30초 강제(지금 기본값)를 비교한다.

사용: voice/.venv/bin/python voice/eval/max_speech.py voice/recordings/mentoring-full.wav docs/mentoring/2026-10-29-멘토링-전사.md
서버를 띄우는 대신 서버 final과 같은 길(Segmenter → transcribe(마디, hint(참석자)))을 직접 부른다.
서버로 흘리면 말하는 동안 partial 받아쓰기가 0.8초마다 GPU를 더 쓰는데 final 글자엔 영향이 없어서다.
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import segmenter  # noqa: E402
from replay import cer  # noqa: E402
from segmenter import FRAME, SR, Segmenter, transcribe  # noqa: E402
from server import hint  # noqa: E402

END = 950  # 15:50 — 전사에서 이 시각 줄 앞까지를 정답으로
NAMES = "기헌, 태은, 지호"
OUT = Path(__file__).resolve().parent.parent / "recordings" / "max_speech.json"


def reference(md: str) -> str:
    body = md[: md.index("**[15:50]")]
    lines = [re.sub(r"^\*\*[^*]+:\*\*\s*", "", l) for l in body.splitlines() if l.startswith("**") or (l and not l.startswith(("#", "-")))]
    return " ".join(l for l in lines if l.strip())


def run(audio: np.ndarray, soft_s: float, max_s: float) -> list[dict]:
    segmenter.SOFT_CUT_S, segmenter.MAX_SPEECH_S = soft_s, max_s
    seg, out = Segmenter(), []
    for k in range(0, len(audio) - FRAME, FRAME):
        for ev in seg.feed(audio[k : k + FRAME]):
            if ev[0] == "end":
                _, t0, t1, a = ev
                out.append({"t0": round(t0, 2), "t1": round(t1, 2), "text": transcribe(a, hint(NAMES))})
    return out


def main():
    audio = sf.read(sys.argv[1], dtype="float32", frames=END * SR)[0]
    audio = np.concatenate([audio, np.zeros(SR, np.float32)])
    ref = reference(Path(sys.argv[2]).read_text())
    transcribe(np.zeros(SR, np.float32))
    res = {}
    cuts = {"끊기 20초": (1e9, 20.0), "쉼 15초·강제 30초": (15.0, 30.0)}
    for name, (soft_s, max_s) in {"끄기": (1e9, 1e9), **cuts}.items():
        segs = run(audio, soft_s, max_s)
        hyp = " ".join(s["text"] for s in segs)
        res[name] = {"마디": len(segs), "CER": round(cer(ref, hyp), 4), "segs": segs}
        print(f"{name}: 마디 {len(segs)}, 15초 넘은 마디 {sum(s['t1'] - s['t0'] >= 15 for s in segs)}, 전사 대비 CER {res[name]['CER']}")
    # 끄기에서 15초 넘은 긴 말마다: 끊긴 쪽 조각들을 이어 붙인 글과 비교
    off = res["끄기"]["segs"]
    for name in cuts:
        on, longs = res[name]["segs"], []
        print(f"\n=== {name}")
        for s in off:
            if s["t1"] - s["t0"] <= 15:
                continue
            parts = [p for p in on if s["t0"] - 0.5 <= p["t0"] and p["t1"] <= s["t1"] + 0.5]
            joined = " ".join(p["text"] for p in parts)
            longs.append({"t0": s["t0"], "len": round(s["t1"] - s["t0"], 1), "조각": len(parts), "끄기": s["text"], "끊기": [p["text"] for p in parts],
                          "두 결과 차이 CER": round(cer(s["text"], joined), 3)})
            print(f"[{s['t0']}초, {longs[-1]['len']}초 → {len(parts)}조각, 차이 CER {longs[-1]['두 결과 차이 CER']}]")
            for p in parts[:-1]:
                print("   끊긴 곳:", "…" + p["text"][-25:], "‖", next(q for q in on if q["t0"] >= p["t1"] - 0.05)["text"][:25] + "…")
        res[name]["long"] = longs
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(f"\n→ {OUT}")


if __name__ == "__main__":
    main()
