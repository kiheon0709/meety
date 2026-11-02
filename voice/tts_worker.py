"""Qwen3-TTS 스트리밍 목소리 작업자 — mlx-audio가 든 따로 venv(voice/cache/venvs/mlx)에서 돈다. 음성 서버(server.py)가 켤 때 띄운다.

실행: voice/cache/venvs/mlx/bin/python voice/tts_worker.py [포트=8790]
  POST /stream {text, speaker?, instruct?} → 만들어지는 대로 PCM16 24kHz 모노 조각 (Transfer-Encoding: chunked), TEMPO배 빠르게. 앞 무음은 건너뛴다(30ms만 남김)
  GET  /health → {"ok": true, "model": …, "voice": 캐시 열쇠에 쓰는 목소리 이름(빠르기·온도·씨앗 포함)}
모델: mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit, 한국어 여성 Sohee + 말투 지시 (S2 10/31 비교: 첫 소리 122~154ms, RTF 0.33, Apache-2.0).
음성 서버 venv(mlx-whisper)와 라이브러리가 섞이지 않게 프로세스를 나눴다. 서로 127.0.0.1로만 말한다.
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from tts_stretch import Stretch

MODEL = os.environ.get("MEETY_QWEN_MODEL", "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit")
SPEAKER = os.environ.get("MEETY_QWEN_SPEAKER", "sohee")
STYLE = os.environ.get("MEETY_QWEN_STYLE", "회의에 같이 앉은 20대 한국인 팀원처럼 차분하고 자연스러운 대화체로")
INTERVAL = float(os.environ.get("MEETY_QWEN_INTERVAL", 0.32))  # 조각 간격(초). 줄이면 첫 소리가 빨라지고 조각당 부담이 는다
# 11/1 기헌이 고른 목소리(후보 6): Sohee 지금 말투 + 1.2배(높낮이 그대로) + 무작위성 낮춤.
# 모델 기본(온도 0.9·top_k 50)은 같은 말투 지시라도 문장마다 빠르기가 23% 벌어졌다 → 0.5·20, 문장마다 같은 씨앗 (docs/research/voice-tts-compare.md 11/1 고정판)
TEMPO = float(os.environ.get("MEETY_QWEN_TEMPO", 1.2))
TEMPERATURE = float(os.environ.get("MEETY_QWEN_TEMPERATURE", 0.5))
TOP_K = int(os.environ.get("MEETY_QWEN_TOP_K", 20))
SEED = int(os.environ.get("MEETY_QWEN_SEED", 7))
# 캐시 열쇠(tts.cache_path)에 들어간다 — 위 값이 하나라도 바뀌면 받침말·맞장구·미리 구운 말을 새로 굽는다 (qwen3.voice가 /health에서 읽음)
VOICE_TAG = f"qwen3-1.7b/{SPEAKER}/{STYLE[:20]}/x{TEMPO:g}/t{TEMPERATURE:g}k{TOP_K}s{SEED}"
SR = 24000
TAIL = 0.15  # 문장 끝 무음은 이만큼만
# 말이 나온 뒤 이만큼 내리 조용하면 문장이 끝난 것으로 보고 그만 만든다. 씨앗을 고정하니 "음" 한 글자가 끝을 못 맺고
# 50초 동안 무음을 만들어(11/1, 온도 0.5·씨앗 7) 작업자를 잡고 뒤 문장들이 시간 초과로 Supertonic이 됐다. 문장 안 쉼은 1초 안쪽
STOP_SILENCE = 1.5
_model = None
_lock = threading.Lock()  # GPU 하나: 한 번에 한 문장
# 지금 말할 문장(live)이 먼저: 미리 굽기(prefetch)는 live가 기다리는 동안 시작하지 않고, 만드는 중이라도 조각 경계에서 그만둔다
# (S6 실측 10/31: 미리 굽기 60줄이 작업자를 잡으면 새 문장이 3.7초 기다리고 문장 사이가 2초로 벌어졌다)
_live_waiting = 0
_live_guard = threading.Lock()


class Preempted(Exception):
    pass


def model():
    global _model
    if _model is None:
        from mlx_audio.tts.utils import load_model

        _model = load_model(MODEL)
    return _model


def pcm16(a: np.ndarray) -> bytes:
    return (np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()


def stream(text: str, speaker: str | None = None, instruct: str | None = None, temperature: float | None = None, prefetch: bool = False):
    """PCM16 조각을 만들어지는 대로, TEMPO배 빠르게. 문장 하나 동안 늘이기(Stretch)를 열어 두고 조각을 이어 넣어서 이음새가 없다."""
    st = Stretch(TEMPO) if TEMPO != 1 else None
    for a in _pieces(text, speaker, instruct, temperature, prefetch):
        a = st.feed(a) if st else a
        if len(a):
            yield pcm16(a)
    if st:
        yield pcm16(st.feed(np.zeros(0, np.float32), final=True))


def _pieces(text, speaker, instruct, temperature, prefetch):
    """모델 조각(float). 앞 무음(가장 큰 소리의 1% 아래, 하지만 아직 모르니 절대 크기 0.01)은 30ms만 남기고 건너뛴다."""
    global _live_waiting
    if prefetch:
        while _live_waiting:
            time.sleep(0.02)
    else:
        with _live_guard:
            _live_waiting += 1
    try:
        _lock.acquire()
    finally:
        if not prefetch:
            with _live_guard:
                _live_waiting -= 1
    try:
        started, held = False, []
        keep = int(0.03 * SR)
        import mlx.core as mx

        mx.random.seed(SEED)  # 같은 문장은 늘 같은 소리 (미리 굽다 양보해서 다시 만들어도)
        kw = {"temperature": TEMPERATURE if temperature is None else temperature, "top_k": TOP_K}
        for r in model().generate_custom_voice(text=text, speaker=speaker or SPEAKER, language="korean",
                                               instruct=STYLE if instruct is None else (instruct or None), stream=True, streaming_interval=INTERVAL, **kw):
            if prefetch and _live_waiting:
                raise Preempted(text)
            a = np.array(r.audio, dtype=np.float32).ravel()
            loud = np.where(np.abs(a) > 0.01)[0]
            if not started:
                if not len(loud):
                    continue
                a, loud = a[max(0, loud[0] - keep) :], loud - max(0, loud[0] - keep)
                started = True
            # 뒤 무음은 붙잡아 둔다: 다음 조각에 소리가 오면 같이 보내고, 문장이 거기서 끝나면 TAIL만 보낸다
            # (S6 10/31: "잠깐만요."가 2.1초로 와서 미티 말이 늦게 끝남 — 짧은 문장 끝에 무음이 길게 붙는 경우)
            if not len(loud):
                held.append(a)
                if sum(map(len, held)) >= STOP_SILENCE * SR:
                    break
                continue
            if held:
                yield np.concatenate(held)
                held = []
            end = loud[-1] + 1
            yield a[:end]
            if end < len(a):
                held = [a[end:]]
        if held:
            tail = np.concatenate(held)[: int(TAIL * SR)]
            tail *= np.linspace(1, 0, len(tail))
            yield tail
    finally:
        _lock.release()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"ok": True, "model": MODEL, "speaker": SPEAKER, "sr": SR, "venv": sys.prefix, "voice": VOICE_TAG, "tempo": TEMPO}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        self.send_response(200)
        self.send_header("content-type", f"audio/L16;rate={SR};channels=1")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        try:
            for b in stream(req["text"], req.get("speaker"), req.get("instruct"), req.get("temperature"), req.get("priority") == "prefetch"):
                self.wfile.write(f"{len(b):x}\r\n".encode() + b + b"\r\n")
                self.wfile.flush()
        except BrokenPipeError:
            return
        except Preempted:
            self.close_connection = True  # 끝 조각(0) 없이 닫는다 → 받는 쪽이 "덜 받음"으로 알고 캐시에 쓰지 않는다
            return
        self.wfile.write(b"0\r\n\r\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    for _ in stream("네."):  # 데우기 (처음이면 HF에서 모델을 받는다)
        pass
    print(f"tts_worker ready {MODEL} {VOICE_TAG} :{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
