"""Meta MMS-TTS 한국어 (VITS). 모델 CC-BY-NC 4.0 (비상업만). 처음 쓸 때 HF에서 300MB쯤 받는다.

글자를 로마자로 바꿔(uroman) 읽어서, 숫자·영어는 못 읽는다. pip install -r voice/requirements-tts.txt
"""

import threading
from pathlib import Path

import soundfile as sf

from . import config

_m = None
_lock = threading.Lock()


def voice() -> str:
    return config.MMS_MODEL


def load():
    global _m
    if _m is None:
        import torch
        import uroman
        from transformers import AutoTokenizer, VitsModel

        torch.manual_seed(0)  # VITS는 매번 조금씩 다르게 읽어서 같은 문장이 같게 나오도록
        _m = (VitsModel.from_pretrained(config.MMS_MODEL).eval(), AutoTokenizer.from_pretrained(config.MMS_MODEL), uroman.Uroman())
    return _m


def synth(text: str, out: Path, voice_name: str | None = None) -> Path:
    import torch

    with _lock:
        model, tok, ur = load()
        inputs = tok(ur.romanize_string(text), return_tensors="pt")
        with torch.no_grad():
            wav = model(**inputs).waveform[0].numpy()
        sf.write(str(out), wav, model.config.sampling_rate)
    return out
