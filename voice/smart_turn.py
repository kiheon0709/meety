"""말 끝 판정 모델 Pipecat Smart Turn v3.2 (BSD-2, 8MB int8 ONNX, 한국어 포함 23개 언어). 소리만 보고 "이 사람 말이 끝났나" 확률을 낸다.

https://huggingface.co/pipecat-ai/smart-turn-v3 — 처음 쓸 때 HF에서 smart-turn-v3.2-cpu.onnx(8MB)를 받는다. 코드는 우리가 썼다(모델 카드의 입력 꼴대로).
입력: 말 끝 무렵 최근 8초(16kHz). 8초보다 짧으면 **앞에** 0을 채운다(뒤에 채우면 늘 "끝남" 0.98로 나왔다). Whisper 특징(80×800).
"""

import threading

import numpy as np

REPO, FILE = "pipecat-ai/smart-turn-v3", "smart-turn-v3.2-cpu.onnx"
SR = 16000
N = 8 * SR

_sess = None
_fe = None
_lock = threading.Lock()


def _load():
    global _sess, _fe
    if _sess is None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from transformers import WhisperFeatureExtractor

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2  # 받아쓰기·TTS와 CPU를 나눠 쓴다
        _sess = ort.InferenceSession(hf_hub_download(REPO, FILE), opts, providers=["CPUExecutionProvider"])
        _fe = WhisperFeatureExtractor(chunk_length=8)
    return _sess, _fe


def ready() -> bool:
    """모델을 불러 둘 수 있나 (서버 warm_up에서 한 번 불러 본 뒤)."""
    try:
        _load()
        return True
    except Exception:
        return False


def prob(audio: np.ndarray) -> float:
    """audio(16kHz, 말 끝 뒤 조용한 0.2초쯤 포함)의 마지막 말이 끝났을 확률 0~1."""
    with _lock:
        sess, fe = _load()
        a = audio[-N:].astype(np.float32)
        if len(a) < N:
            a = np.concatenate([np.zeros(N - len(a), np.float32), a])
        f = fe(a, sampling_rate=SR, return_tensors="np", padding="max_length", max_length=N, truncation=True, do_normalize=True).input_features
        return float(sess.run(None, {"input_features": f.astype(np.float32)})[0].ravel()[0])
