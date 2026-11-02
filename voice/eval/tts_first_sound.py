"""목소리 엔진별 첫 소리까지 (키가 생기면 그대로 다시 돌린다).

사용: voice/.venv/bin/python voice/eval/tts_first_sound.py   (키는 환경변수: ELEVENLABS_API_KEY·ELEVENLABS_VOICE_ID, TYPECAST_API_KEY·TYPECAST_VOICE_ID, OPENAI_API_KEY)
  클라우드(스트리밍): 요청 → 첫 PCM 조각까지 = 첫 소리, 마지막 조각까지 = 다 받음. 키 없으면 "키 없음"으로 건너뛴다(돈 안 씀).
  로컬(Supertonic·say): 문장을 다 만들어야 소리가 나가므로 첫 소리 = 다 만든 시간. 캐시를 안 쓰고 매번 새로 만든다.
→ voice/recordings/tts-first-sound.json
"""

import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
import tts.config as config  # noqa: E402
from tts import elevenlabs, openai_tts, say, streaming, supertonic, typecast  # noqa: E402
from tts_compare import setup_supertonic  # noqa: E402

LINES = ["좋아요, 같이 해 봐요.", "기록엔 없지만 제 생각엔 화면부터 정하는 게 먼저예요.", "그럼 디자인 기준부터 같이 정해 볼까요?",
         "잠깐만요, 10월 10일 회의에서는 웹을 먼저 하기로 했어요.", "네, 듣고 있어요."]


def local(name, mod, voice, prep):
    prep()
    with tempfile.TemporaryDirectory() as d:
        mod.synth("네.", Path(d) / "w.wav", voice)
        ms = []
        for i, l in enumerate(LINES):
            t = time.monotonic()
            mod.synth(l, Path(d) / f"{i}.wav", voice)
            ms.append((time.monotonic() - t) * 1000)
    return {"엔진": name, "첫 소리 ms": [round(x) for x in ms], "다 받음 ms": [round(x) for x in ms]}


def cloud(name, mod):
    first, total = [], []
    try:
        for l in LINES:
            t = time.monotonic()
            f = None
            for _ in mod.stream(l):
                f = f or time.monotonic()
            first.append((f - t) * 1000)
            total.append((time.monotonic() - t) * 1000)
    except streaming.NoKey as e:
        return {"엔진": name, "메모": f"키 없음 — {e}"}
    return {"엔진": name, "첫 소리 ms": [round(x) for x in first], "다 받음 ms": [round(x) for x in total]}


def main():
    rows = [
        local("Supertonic-3 F1 8단계 (지금 기본)", supertonic, "F1", setup_supertonic("supertonic-3", 8)),
        local("Supertonic-2 F1", supertonic, "F1", setup_supertonic("supertonic-2", 4)),
        local("맥 Yuna", say, config.SAY_VOICE, lambda: None),
        cloud("ElevenLabs Flash v2.5", elevenlabs),
        cloud("Typecast ssfm-v30", typecast),
        cloud("OpenAI gpt-4o-mini-tts", openai_tts),
    ]
    for r in rows:
        if "첫 소리 ms" in r:
            r["첫 소리 중앙"] = round(statistics.median(r["첫 소리 ms"]))
        print(r, flush=True)
    (VOICE / "recordings" / "tts-first-sound.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
