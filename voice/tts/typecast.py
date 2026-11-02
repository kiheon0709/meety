"""Typecast ssfm-v30 (유료, 키 필요 — 기헌 결정 대기). 한국어 특화, 업체 발표 첫 소리 170~210ms, $70~90/1M자, 감정 프리셋.

환경변수: TYPECAST_API_KEY, TYPECAST_VOICE_ID, 선택 TYPECAST_URL·TYPECAST_MODEL.
API 꼴은 문서(https://typecast.ai/kr/developers/api/)를 보고 짰지만 키가 없어 한 번도 불러 보지 못했다 — 키를 넣고 처음 쓸 때
응답이 PCM16 스트림인지(wav 머리가 붙으면 앞 44바이트를 버려야 함) 꼭 확인. 주의: 문장이 회사 밖 서버로 나간다.
"""

import os
from pathlib import Path

from . import streaming

KEY_ENV, VOICE_ENV = "TYPECAST_API_KEY", "TYPECAST_VOICE_ID"
SR = 24000


def voice() -> str:
    return os.environ.get(VOICE_ENV, "") + "/" + os.environ.get("TYPECAST_MODEL", "ssfm-v30")


def request(text: str, voice_name: str | None = None) -> tuple:
    key = streaming.need(KEY_ENV)
    vid = voice_name or streaming.need(VOICE_ENV)
    url = os.environ.get("TYPECAST_URL", "https://api.typecast.ai/v1/text-to-speech/stream")
    body = {"voice_id": vid, "text": text, "model": os.environ.get("TYPECAST_MODEL", "ssfm-v30"), "language": "kor",
            "output": {"audio_format": "pcm", "sample_rate": SR}}
    return url, {"X-API-KEY": key}, body, SR


def stream(text: str, voice_name: str | None = None):
    return streaming.stream(request(text, voice_name))


def synth(text: str, out: Path, voice_name: str | None = None) -> Path:
    return streaming.write_wav(stream(text, voice_name), out, SR)
