"""미티가 말하는 중 짧은 소리("네"·"음"·기침)에 멈추나, 진짜 끊는 말("잠깐만요, 그건 아니에요")엔 멈추나 — 실제 서버 /ws에 1배속.

사용: (음성 서버를 켠 뒤) voice/.venv/bin/python voice/eval/barge_short.py [포트]
미티는 긴 문장을 말하는 중(스피커→마이크 에코, eval/echo_backchannel.py와 같은 방). 사람 소리는 미티가 말을 시작하고 1초 뒤 0.6m에서.
"""

import asyncio
import json
import sys
from pathlib import Path

import numpy as np

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
sys.path.insert(0, str(VOICE / "eval"))
import tts  # noqa: E402
from echo_backchannel import run  # noqa: E402
from room_mix import PITCH, place, say  # noqa: E402
from tts_compare import to16k  # noqa: E402

SR = 16000
MEETY = "잠깐만요, 10월 10일 회의에서 입구는 웹 중심으로 정했어요. 바꾸면 그 결정을 다시 여는 거예요."


def cough(seed=0):
    rng = np.random.default_rng(seed)
    n = int(0.25 * SR)
    a = rng.normal(0, 1, n) * np.exp(-np.arange(n) / (0.06 * SR))
    return (a / np.abs(a).max() * 0.3).astype(np.float32)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8773
    me = to16k(tts.synth(MEETY))
    echo = place(me, 1.0, 7) * 10 ** (-6 / 20)
    cases = {"네": say("네", PITCH["기헌"]), "음": say("음", PITCH["기헌"]), "네네": say("네네", PITCH["태은"]), "기침": cough(),
             "잠깐만요, 그건 아니에요": say("잠깐만요, 그건 아니에요.", PITCH["기헌"]), "근데 그거 다음 주에 다시 봐요": say("근데 그거 다음 주에 다시 봐요.", PITCH["태은"])}
    rows = []
    for name, h in cases.items():
        on, delay = 1.0, 0.12
        a = np.zeros(int((on + delay + len(echo) / SR + 2.5) * SR), np.float32)
        s = int((on + delay) * SR)
        a[s : s + len(echo)] += echo
        hp = place(h, 0.6, 3)
        k = int((on + 1.0) * SR)
        a[k : k + len(hp)] += hp
        a += np.random.default_rng(1).normal(0, 0.0005, len(a)).astype(np.float32)
        ev = asyncio.run(run(port, a, on, on + len(me) / SR, MEETY))
        b = [e for e in ev if e["type"] == "barge_in"]
        rows.append({"소리": name, "길이(초)": round(len(h) / SR, 2), "barge_in": len(b), "끊은 때(초)": round(b[0]["t"], 2) if b else None})
        print(rows[-1], flush=True)
    (VOICE / "recordings" / "barge_short.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
