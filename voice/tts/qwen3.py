"""Qwen3-TTS 1.7B (Apache-2.0) 스트리밍 — 따로 프로세스인 voice/tts_worker.py(mlx-audio)에 HTTP로 문장을 주고 PCM16 24kHz 조각을 받는다.

서버(server.py)가 켤 때 작업자를 띄운다(ensure_worker). 작업자가 없거나 죽으면 tts.synth가 Supertonic으로 되돌린다.
목소리: 한국어 여성 프리셋 Sohee + 말투 지시 (바꾸기: MEETY_QWEN_SPEAKER·MEETY_QWEN_STYLE, 작업자 쪽 환경변수).
"""

import json
import os
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

from . import streaming

PORT = int(os.environ.get("MEETY_QWEN_PORT", 8790))
URL = f"http://127.0.0.1:{PORT}"
SR = 24000
VOICE = Path(__file__).resolve().parent.parent
WORKER = VOICE / "tts_worker.py"
SHARED = Path(os.environ.get("MEETY_MLX_VENV", Path.home() / ".cache" / "meety" / "venvs" / "mlx"))
_proc: subprocess.Popen | None = None
PREFETCH = threading.local()  # tts.prefetch가 켜 둔다 → 요청에 priority=prefetch
status = {"ok": False, "why": "아직 안 띄움"}  # 켤 때 어떤 목소리로 떴나 (server가 찍는다)
_health: dict = {}  # 작업자가 /health로 알려 준 것 (voice: 캐시 열쇠)


def find_python() -> Path | None:
    """작업자 파이썬: MEETY_MLX_PY → 공유 자리(~/.cache/meety/venvs/mlx, 워크트리마다 다시 깔지 않게) → 이 워크트리 voice/cache/venvs/mlx."""
    for p in (os.environ.get("MEETY_MLX_PY"), SHARED / "bin" / "python", VOICE / "cache" / "venvs" / "mlx" / "bin" / "python"):
        if p and Path(p).exists():
            return Path(p)
    return None


def setup() -> Path | None:
    """공유 venv가 없으면 voice/setup_mlx.sh로 만든다(고정 버전 requirements-mlx.txt, uv면 1분 안쪽)."""
    try:
        subprocess.run(["bash", str(VOICE / "setup_mlx.sh")], check=True, timeout=900, stdout=subprocess.DEVNULL)
    except Exception as e:
        status.update(why=f"작업자 venv 만들기 실패({type(e).__name__})")
        return None
    return find_python()


def voice() -> str:
    """캐시 열쇠에 들어가는 목소리 이름(빠르기·온도·씨앗 포함). 떠 있는 작업자가 알려 준 값을 쓴다 —
    옛 작업자(1.2배 전, voice를 안 알려 줌)가 떠 있으면 옛 이름이라 옛 소리가 새 열쇠로 섞이지 않는다.
    작업자에 못 닿으면(시험 스크립트 등) 지금 작업자가 알려 줄 이름 — 옛 캐시를 집어 오지 않는다."""
    if not _health:
        alive()
    if _health:
        return _health.get("voice") or "qwen3-1.7b/" + os.environ.get("MEETY_QWEN_SPEAKER", "sohee") + "/" + os.environ.get("MEETY_QWEN_STYLE", "")[:20]
    from tts_worker import VOICE_TAG

    return VOICE_TAG


def describe() -> str:
    """켤 때·/status에 찍는 한 줄."""
    t = _health.get("tempo")
    return f"Qwen3-TTS 1.7B Sohee {t:g}배 (스트리밍)" if t else "Qwen3-TTS 1.7B Sohee (스트리밍, 옛 작업자 — 1.2배 아님: 작업자를 끄고 다시 켜세요)"


def alive(timeout: float = 0.5) -> bool:
    try:
        with urllib.request.urlopen(URL + "/health", timeout=timeout) as r:
            h = json.loads(r.read())
        _health.clear()
        _health.update(h)
        return h.get("ok", False)
    except Exception:
        return False


def ensure_worker(wait_s: float = 180) -> bool:
    """작업자가 없으면 띄우고 준비될 때까지 기다린다(처음엔 모델 2GB 받기·데우기). 못 띄우면 False (Supertonic으로)."""
    global _proc
    if alive():
        status.update(ok=True, why="이미 떠 있음")
        return True
    py = find_python() or setup()
    if not py:
        status.setdefault("why", "작업자 venv 없음")
        return False
    _proc = subprocess.Popen([str(py), str(WORKER), str(PORT)])
    t = time.monotonic()
    while time.monotonic() - t < wait_s:
        if _proc.poll() is not None:
            status.update(ok=False, why=f"작업자가 바로 꺼짐(종료 코드 {_proc.returncode}) — voice 로그 확인")
            return False
        if alive():
            status.update(ok=True, why=str(py))
            return True
        time.sleep(1)
    status.update(ok=False, why=f"작업자가 {wait_s:.0f}초 안에 준비 안 됨(처음이면 모델 2GB 받는 중일 수 있음)")
    return False


def stop_worker():
    if _proc and _proc.poll() is None:
        _proc.terminate()


def request(text: str, voice_name: str | None = None) -> tuple:
    body = {"text": text}
    if voice_name:
        body["speaker"] = voice_name
    if getattr(PREFETCH, "on", False):
        body["priority"] = "prefetch"  # 작업자가 지금 말할 문장 뒤로 미룬다
    return URL + "/stream", {}, body, SR


def stream(text: str, voice_name: str | None = None):
    return streaming.stream(request(text, voice_name), chunk=2048)


def synth(text: str, out: Path, voice_name: str | None = None) -> Path:
    return streaming.write_wav(stream(text, voice_name), out, SR)
