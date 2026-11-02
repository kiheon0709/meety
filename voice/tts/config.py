"""미티 목소리 설정은 여기 한 곳에서 고른다.

엔진은 환경변수 MEETY_TTS로 바꾼다 (기본: Qwen3-TTS 작업자 venv가 있으면 qwen3, 아니면 supertonic, 그것도 없으면 say). 예: MEETY_TTS=supertonic npm run meeting
비교 결과는 docs/research/voice-tts-compare.md, 듣기 샘플은 voice/recordings/tts-compare/.
"""

import os

def _default_engine() -> str:
    # 10/31 밤 기헌 결정: 스트리밍 목소리. Qwen3-TTS 1.7B Sohee(첫 소리 0.12~0.15초, Apache-2.0)를 따로 venv의 작업자로 —
    # 그 venv가 있으면 기본. 작업자가 안 뜨면 문장마다 Supertonic으로 되돌아간다
    # 작업자 venv는 공유 자리(~/.cache/meety/venvs/mlx)에 없으면 서버가 켤 때 만든다(voice/setup_mlx.sh). 애플 실리콘 맥에서만
    import platform

    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "qwen3"
    return _local_default()


def _local_default() -> str:
    # 잠정 기본값 (S7, 10/30): Supertonic-3 F1 4단계. 설치 안 돼 있으면 맥 내장 say(Yuna).
    # 이유: 받아쓰기로 되짚었을 때 틀린 글자 0 (say는 "봇은"→"곳은"), 4단계면 문장당 0.3~1.5초.
    # 두뇌가 prepare로 미리 굽게 해서 첫 소리는 보통 캐시에서 나온다. 비교: docs/research/voice-tts-compare.md
    try:
        import supertonic  # noqa: F401

        return "supertonic"
    except ImportError:
        return "say"


ENGINE = os.environ.get("MEETY_TTS") or _default_engine()

# 엔진별 목소리
SAY_VOICE = os.environ.get("MEETY_SAY_VOICE", "Yuna")
SUPERTONIC_MODEL = os.environ.get("MEETY_SUPERTONIC_MODEL", "supertonic-3")
SUPERTONIC_VOICE = os.environ.get("MEETY_SUPERTONIC_VOICE", "F1")  # F1–F5, M1–M5
# 10/31 기헌 "깨지고 째진다" → 4에서 8로. 4단계는 합성 잡음이 커서(스펙트럼 평탄도 4단계 0.143 / 8단계 0.113, 관리 세션 측정) 째지게 들린다.
# 대신 문장당 1.5~2배 느리다 — 화면이 첫 문장 소리가 오면 바로 틀고 다음 문장은 틀면서 굽고, 받침말·여는 말(FILLERS)은 미리 굽는다
SUPERTONIC_STEPS = int(os.environ.get("MEETY_SUPERTONIC_STEPS", 8))  # 높을수록 좋고 느림
MMS_MODEL = "facebook/mms-tts-kor"

# 받침말·여는 말: 서버가 켜질 때 미리 구워 둔다 → 두뇌가 이 문장을 그대로 보내면 /tts가 캐시에서 바로(수 ms) 나온다.
# 부름("미티야")에 대답이 준비되는 동안 먼저 틀 말과 rules.ts OPENERS(말로 짚을 때 붙이는 여는 말). 글자가 하나라도 다르면 새로 굽는다.
# 안 구우면 "네, 잠깐만요."도 0.9~1초쯤 걸린다 (S2 10/31 측정)
FILLERS = ["네?", "네, 잠깐만요.", "네, 말씀하세요.", "음, 잠깐 생각해 볼게요.", "네, 듣고 있어요.", "잠깐만요.", "하나만요.", "참고로요.", "기록 좀 볼게요.", "네, 한번 찾아볼게요."]  # 끝 둘: S3 기록 찾는 물음, 웹으로 갈 부름 (rules.ts FILLER.lookup·web)

# 맞장구·생각 소리: 사람 말 사이·대답 앞에 미티가 끼워 넣는 짧은 소리. 서버가 켜질 때 미리 굽는다(짧은 말이라 앞뒤 무음 다듬기·크기 맞춤, tts.tidy).
# 종류마다 3~4벌 — 같은 소리만 되풀이하면 기계 같아서 GET /tts/backchannel/{종류}가 무작위로 하나 고른다.
# 벌은 문장부호만 바꿔 억양을 달리한 것 (voice/eval/backchannels.py, 듣기: tts-compare/index.html 맞장구 표) — 기헌이 듣고 바꾼다.
# 뺀 것: "그렇죠."(0.42초로 뭉개져 "저"로 들림), "음… 잠깐만요."(1.4초로 김),
# "으음"·"오, 좋네요."(Qwen3 목소리로 바꾼 뒤 에코만 들어와도 끼어들기로 잡힘 — eval/echo_backchannel.py 22개 중 이 둘만)
BACKCHANNEL_KINDS = {
    "ack": ["네네", "네, 네.", "아 네", "네네."],  # 듣고 있어요
    "agree": ["맞아요", "맞아요.", "그렇죠", "그쵸"],  # 동의
    "think": ["음", "음…", "음..."],  # 생각 중
    "recall": ["아 그거요", "아~ 그거요", "아, 그거요."],  # 알아들음
    "hold": ["음, 잠깐만요.", "음 잠깐만요", "잠깐만요."],  # 잠깐 기다려 달라
    "interest": ["아하", "아하.", "오~ 좋네요"],  # 흥미
}
BACKCHANNELS = [t for ts in BACKCHANNEL_KINDS.values() for t in ts]
