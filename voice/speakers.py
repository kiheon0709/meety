"""화자 등록·찾기. 회의 전 각자 5초쯤 말하면 목소리 지문(256차원)을 이 컴퓨터에 저장하고, final마다 가장 가까운 사람을 붙인다.

모델: resemblyzer (GE2E, 영어 위주로 학습). 계정 없이 pip로 받는다. 지문은 voice/cache/speakers.json (git 제외).
"""

import json
import os
import threading
from pathlib import Path

import numpy as np

from segmenter import SR

PATH = Path(os.environ.get("VOICE_SPEAKERS", Path(__file__).parent / "cache" / "speakers.json"))
THRESHOLD = float(os.environ.get("VOICE_SPEAKER_THRESHOLD", 0.75))  # 코사인 유사도가 이보다 낮으면 모르는 사람
MIN_SECONDS = 1.0  # 이보다 짧은 말은 지문이 흔들려서 화자를 안 붙인다
# 미티를 끊은 목소리가 등록된 누구와도 이보다 덜 닮았으면 "확실히 다른 사람"(제3자·배경 소리). 임계(THRESHOLD)와 사이는 "모름" —
# 팀원을 남으로 잘못 보고 미티가 다시 말하는 게 가장 나쁜 실수라 비대칭으로 둔다
OTHER_MAX = float(os.environ.get("VOICE_BARGE_OTHER_MAX", 0.5))

_enc = None
_lock = threading.Lock()


def _encoder():
    global _enc
    if _enc is None:
        from resemblyzer import VoiceEncoder

        _enc = VoiceEncoder("cpu", verbose=False)
    return _enc


def embed(audio: np.ndarray) -> np.ndarray | None:
    from resemblyzer import preprocess_wav

    wav = preprocess_wav(audio, source_sr=SR)  # 조용한 곳을 빼고 크기를 맞춘다
    if len(wav) < SR * MIN_SECONDS:
        return None
    with _lock:
        return _encoder().embed_utterance(wav)


class Registry:
    def __init__(self, path: Path = PATH):
        self.path = path
        self.voices: dict[str, np.ndarray] = {}
        if path.exists():
            self.voices = {k: np.array(v, np.float32) for k, v in json.loads(path.read_text()).items()}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({k: v.tolist() for k, v in self.voices.items()}, ensure_ascii=False))

    def enroll(self, name: str, audio: np.ndarray) -> float:
        """등록하고 실제로 쓴 말소리 길이(초)를 돌려준다. 너무 짧으면 ValueError."""
        v = embed(audio)
        if v is None:
            raise ValueError(f"말소리가 {MIN_SECONDS}초보다 짧아요")
        self.voices[name] = v
        self.save()
        return round(len(audio) / SR, 1)

    def remove(self, name: str):
        self.voices.pop(name, None)
        self.save()

    def identify(self, audio: np.ndarray) -> tuple[str | None, float | None]:
        """(가장 가까운 사람 또는 None, 유사도). embed_utterance는 길이 1로 맞춰 나와서 내적이 코사인 유사도다.
        등록자가 없거나 말이 짧아 지문을 못 만들면 유사도 None (모름)."""
        if not self.voices:
            return None, None
        v = embed(audio)
        if v is None:
            return None, None
        name, score = max(((k, float(v @ e)) for k, e in self.voices.items()), key=lambda x: x[1])
        return (name if score >= THRESHOLD else None), round(score, 3)


def barge_verdict(name: str | None, score: float | None) -> str:
    """미티를 끊은 말의 목소리: member(등록 참석자) | other(확실히 다른 목소리) | unsure(모름).
    끊는 순간(0.35초)엔 지문을 못 만든다(조용한 곳 뺀 1초 = 말 시작 뒤 약 1.5초 필요) → 그 마디 final에 붙여 보낸다."""
    if name:
        return "member"
    if score is not None and score < OTHER_MAX:
        return "other"
    return "unsure"


registry = Registry()
