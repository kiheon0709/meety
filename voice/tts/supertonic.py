"""Supertonic (Supertone, 기기 안에서 도는 ONNX TTS). 코드 MIT, 모델 OpenRAIL-M. 처음 쓸 때 HF에서 400MB쯤 받는다.

pip install -r voice/requirements-tts.txt
"""

import threading
from pathlib import Path

from . import config

_tts = None
_styles: dict = {}
_lock = threading.Lock()


def voice() -> str:
    return f"{config.SUPERTONIC_MODEL}/{config.SUPERTONIC_VOICE}/{config.SUPERTONIC_STEPS}"


def load():
    global _tts
    if _tts is None:
        from supertonic import TTS

        _tts = TTS(model=config.SUPERTONIC_MODEL)
    return _tts


def synth(text: str, out: Path, voice_name: str | None = None) -> Path:
    with _lock:
        tts = load()
        name = voice_name or config.SUPERTONIC_VOICE
        style = _styles.get(name) or _styles.setdefault(name, tts.get_voice_style(name))
        wav, _ = tts.synthesize(text, voice_style=style, lang="ko", total_steps=config.SUPERTONIC_STEPS)
        tts.save_audio(wav, str(out))
    return out
