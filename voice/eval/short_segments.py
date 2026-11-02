"""real_voice.py가 모은 1초 미만 마디(거짓 speech_start 후보)를 받아써서 무엇인지 본다.

사용: voice/.venv/bin/python voice/eval/short_segments.py voice/recordings/mentoring-full.wav
  → voice/recordings/real_voice_short.json  (빈 글 = 잡음 거르기에 걸렸거나 말이 아님)
"""

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from segmenter import SR, transcribe  # noqa: E402

REC = Path(__file__).resolve().parent.parent / "recordings"
HINT = "회의 참석자는 기헌, 태은, 지호, 그리고 AI 팀원 미티."  # 서버 hint()와 같은 꼴


def main():
    audio = sf.read(sys.argv[1], dtype="float32")[0]
    short = json.loads((REC / "real_voice.json").read_text())["short_segments"]
    transcribe(np.zeros(SR, np.float32))
    out = []
    for s in short:
        a = audio[int(s["t0"] * SR) : int(s["t1"] * SR)]
        out.append({**s, "dur": round(s["t1"] - s["t0"], 2), "text": transcribe(a, HINT), "text_no_hint": transcribe(a)})
        print(out[-1], flush=True)
    (REC / "real_voice_short.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"빈 글 {sum(not x['text'] for x in out)}/{len(out)}")


if __name__ == "__main__":
    main()
