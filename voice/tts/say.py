"""맥 기본 목소리 (say). 설치·내려받기 없음. 한국어 중엔 Yuna가 가장 자연스럽다."""

import subprocess
from pathlib import Path

from . import config


def voice() -> str:
    return config.SAY_VOICE


def synth(text: str, out: Path, voice_name: str | None = None) -> Path:
    subprocess.run(["say", "-v", voice_name or voice(), "--file-format=WAVE", "--data-format=LEI16@22050", "-o", str(out), text], check=True)
    return out
