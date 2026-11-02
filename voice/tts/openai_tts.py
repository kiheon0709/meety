"""OpenAI 텍스트→음성 (유료, 키 필요 — 비교용, 기헌 결정 대기). gpt-4o-mini-tts: 말투를 글로 지시할 수 있고, PCM 스트리밍.

환경변수: OPENAI_API_KEY, 선택 OPENAI_TTS_MODEL(기본 gpt-4o-mini-tts)·OPENAI_TTS_VOICE(기본 alloy)·OPENAI_TTS_STYLE.
gpt-realtime-mini(말→말 실시간 모델)는 대화 전체를 맡기는 구조라 "글 → 목소리"만 비교하려면 이 엔드포인트가 맞다.
주의: 문장이 회사 밖 서버로 나간다. 키 없이 짠 코드 — 처음 쓸 때 확인할 것.
"""

import os
from pathlib import Path

from . import streaming

KEY_ENV = "OPENAI_API_KEY"
SR = 24000
STYLE = "회의에 같이 앉은 20대 한국인 팀원처럼, 차분하고 자연스러운 구어체로."


def voice() -> str:
    return os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts") + "/" + os.environ.get("OPENAI_TTS_VOICE", "alloy")


def request(text: str, voice_name: str | None = None) -> tuple:
    key = streaming.need(KEY_ENV)
    body = {"model": os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"), "voice": voice_name or os.environ.get("OPENAI_TTS_VOICE", "alloy"),
            "input": text, "response_format": "pcm", "instructions": os.environ.get("OPENAI_TTS_STYLE", STYLE)}
    return "https://api.openai.com/v1/audio/speech", {"authorization": f"Bearer {key}"}, body, SR


def stream(text: str, voice_name: str | None = None):
    return streaming.stream(request(text, voice_name))


def synth(text: str, out: Path, voice_name: str | None = None) -> Path:
    return streaming.write_wav(stream(text, voice_name), out, SR)
