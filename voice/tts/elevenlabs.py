"""ElevenLabs Flash v2.5 (유료, 키 필요 — 기헌 결정 대기). 한국어, 업체 발표 첫 소리 75ms·독립 측정 중앙 197ms, $50/1M자.

환경변수: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID (목소리 라이브러리에서 고른 id), 선택 ELEVENLABS_MODEL(기본 eleven_flash_v2_5).
두뇌가 문장 단위로 주니 문장마다 HTTP 스트리밍(/stream, pcm_24000)으로 받는다. 글자를 토큰마다 흘려 넣는 WebSocket(stream-input)은
두뇌가 토큰 스트리밍을 할 때 붙인다. 주의: 문장이 회사 밖 서버로 나간다. 키를 넣고 처음 쓸 때 실제 응답 꼴을 한 번 확인할 것(키 없이 짠 코드).
"""

import os
from pathlib import Path

from . import streaming

KEY_ENV, VOICE_ENV = "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"
SR = 24000


def voice() -> str:
    return os.environ.get(VOICE_ENV, "") + "/" + os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")


def request(text: str, voice_name: str | None = None) -> tuple:
    key = streaming.need(KEY_ENV)
    vid = voice_name or streaming.need(VOICE_ENV)
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}/stream?output_format=pcm_{SR}"
    body = {"text": text, "model_id": os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5"), "language_code": "ko"}
    return url, {"xi-api-key": key}, body, SR


def stream(text: str, voice_name: str | None = None):
    return streaming.stream(request(text, voice_name))


def synth(text: str, out: Path, voice_name: str | None = None) -> Path:
    return streaming.write_wav(stream(text, voice_name), out, SR)
