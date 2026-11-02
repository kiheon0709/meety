"""미티 목소리(TTS). 엔진마다 어댑터가 있고, 어느 엔진이든 synth(text) -> wav 경로.

어댑터(say.py, supertonic.py …)는 synth(text, out)으로 out에 wav를 쓴다. 캐시·중복 방지는 여기서 한다.
"""

import hashlib
import importlib
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config

ENGINES = ("say", "supertonic", "mms", "elevenlabs", "typecast", "openai_tts", "qwen3")
# 조각으로 흘려받는 엔진(어댑터에 stream()이 있다). 키·작업자가 없거나 실패하면 FALLBACK으로
STREAMING = ("elevenlabs", "typecast", "openai_tts", "qwen3")
FALLBACK = "supertonic"
CACHE = Path(__file__).parent.parent / "cache" / "tts"

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
# 미리 만들기는 하나씩 (받아쓰기와 같은 기계를 나눠 쓰니까)
_prefetcher = ThreadPoolExecutor(max_workers=1)


def _adapter(engine: str):
    if engine not in ENGINES:
        raise ValueError(f"모르는 엔진: {engine} (있는 것: {', '.join(ENGINES)})")
    return importlib.import_module(f".{engine}", __name__)


SHORT = 6  # 글자(띄어쓰기·문장부호 빼고)가 이 이하인 말은 맞장구·받침말 — 앞뒤 무음을 다듬고 크기를 문장과 맞춘다 (tidy)


def short(text: str) -> bool:
    return len(re.sub(r"[\s\W]", "", text)) <= SHORT


def cache_path(text: str, engine: str | None = None, voice: str | None = None) -> Path:
    engine = engine or config.ENGINE
    a = _adapter(engine)
    tag = ":tidy2" if short(text) else ":trim1"  # 다듬는 방식이 바뀌면 숫자를 올려 다시 굽게 한다
    key = hashlib.sha1(f"{engine}:{voice or a.voice()}:{text}{tag}".encode()).hexdigest()[:16]
    return CACHE / engine / f"{key}.wav"


TARGET_DBFS = -24.5  # 다듬은 짧은 말의 말소리 크기. Supertonic-3 F1 8단계 문장의 말소리 크기(-24.3~-24.8dBFS)와 맞춘다


def tidy(path: Path, level: bool = True):
    """앞뒤 무음을 잘라(앞 30ms, 뒤는 짧은 말 120ms·문장 200ms 남김 — 끝이 잘려 들리지 않게) 10ms 페이드.
    Supertonic은 문장마다 앞 0.4~0.6초·뒤 0.6~0.8초 무음을 붙여서, 그대로 두면 첫 소리가 0.5초 늦고 문장 사이가 1.3초 빈다 (S2 10/31).
    level이면(짧은 말) 말소리 크기를 TARGET_DBFS로 맞춘다."""
    import numpy as np
    import soundfile as sf

    a, sr = sf.read(str(path), dtype="float32", always_2d=True)
    a = a.mean(axis=1)
    w = max(1, sr // 100)
    f = np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1) + 1e-12)
    on = np.where(f > f.max() * 10 ** (-40 / 20))[0]
    if len(on):
        a = a[max(0, on[0] * w - int(0.03 * sr)) : min(len(a), (on[-1] + 1) * w + int((0.12 if level else 0.2) * sr))]
    if level:
        loud = f[f > f.max() * 10 ** (-35 / 20)]
        a = a * (10 ** (TARGET_DBFS / 20) / float(np.sqrt(np.mean(loud**2))))
        a *= min(1.0, 0.89 / (float(np.abs(a).max()) + 1e-9))  # 피크 -1dB 넘지 않게
    n = int(0.01 * sr)
    a[:n] *= np.linspace(0, 1, n)
    a[-n:] *= np.linspace(1, 0, n)
    sf.write(str(path), a, sr, subtype="PCM_16")


# 지금 흘려보내며 만드는 문장 → 그때까지 받은 PCM16 조각. 에코 기준 소리(server.load_ref)가 다 만들어지길 기다리지 않고 쓴다
live: dict[str, tuple[int, list[bytes]]] = {}


def _wav_pcm(path: Path) -> tuple[int, bytes]:
    import numpy as np
    import soundfile as sf

    a, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return sr, (np.clip(a.mean(axis=1), -1, 1) * 32767).astype("<i2").tobytes()


def stream(text: str, engine: str | None = None):
    """(샘플레이트, PCM16 조각들). 캐시에 있으면 파일에서 한 번에, 없고 스트리밍 엔진이면 만들어지는 대로 흘리고 다 되면 캐시에 쓴다.
    스트리밍 엔진이 첫 조각 전에 실패하면 FALLBACK으로 만든 파일을 준다."""
    engine = engine or config.ENGINE
    path = cache_path(text, engine)
    if path.exists() or engine not in STREAMING:
        sr, pcm = _wav_pcm(synth(text, engine))
        return sr, iter([pcm])
    a = _adapter(engine)
    try:
        it = a.stream(text)
        first = next(it)
    except Exception as e:
        print(f"tts: {engine} 스트리밍 실패({e}) → {FALLBACK}", flush=True)
        sr, pcm = _wav_pcm(synth(text, FALLBACK))
        return sr, iter([pcm])

    def gen():
        chunks = [first]
        live[text] = (a.SR, chunks)
        try:
            yield first
            for b in it:
                chunks.append(b)
                yield b
            # 다 받았으면 캐시에 (다음부터는 파일에서, 에코 기준 소리도)
            with _locks_guard:
                lock = _locks.setdefault(str(path), threading.Lock())
            with lock:
                if not path.exists():
                    from .streaming import write_wav

                    path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = path.with_suffix(".part.wav")
                    write_wav(iter(chunks), tmp, a.SR)
                    tidy(tmp, level=short(text))
                    tmp.rename(path)
        finally:
            live.pop(text, None)

    return a.SR, gen()


def synth(text: str, engine: str | None = None, voice: str | None = None) -> Path:
    """text를 읽은 wav 경로. 같은 문장은 한 번만 만들고, 만드는 중이면 끝날 때까지 기다린다.
    클라우드 엔진(STREAMING)이 키가 없거나 실패하면 FALLBACK(Supertonic)으로 읽는다 — 회의는 소리 없이 멈추면 안 된다."""
    engine = engine or config.ENGINE
    if engine in STREAMING:
        try:
            return _synth(text, engine, voice)
        except Exception as e:  # 키 없음(streaming.NoKey)·네트워크·응답 꼴
            from . import qwen3

            if getattr(qwen3.PREFETCH, "on", False):
                raise  # 미리 굽기가 양보하느라 끊긴 것 — 대체 목소리로 굽지 않는다
            print(f"tts: {engine} 실패({e}) → {FALLBACK}", flush=True)
            return _synth(text, FALLBACK, None)
    return _synth(text, engine, voice)


def _synth(text: str, engine: str, voice: str | None) -> Path:
    path = cache_path(text, engine, voice)
    with _locks_guard:
        lock = _locks.setdefault(str(path), threading.Lock())
    with lock:
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part.wav")
            _adapter(engine).synth(text, tmp, voice)
            tidy(tmp, level=short(text))
            tmp.rename(path)
    return path


# 받아쓰기가 돌고 있으면 True (server.py가 segmenter.transcribing으로 바꿔 끼운다)
busy = lambda: False  # noqa: E731


def _polite(text: str, engine: str | None):
    """미리 굽기는 급하지 않다: 받아쓰기가 도는 동안엔 기다렸다가(최대 20초) 한 문장씩.
    회의 시작 때 두뇌가 결정별 대사 60여 개를 보내는데, 한꺼번에 구우면 받아쓰기가 7~20초씩 밀렸다 (S7 단계 3)."""
    for _ in range(200):
        if not busy() and not live:  # 받아쓰기·지금 흘려보내는 대답에 양보 (스트리밍 작업자는 한 번에 한 문장)
            break
        time.sleep(0.1)
    if not cache_path(text, engine).exists():
        from . import qwen3

        qwen3.PREFETCH.on = True  # 스트리밍 작업자에겐 "미리 굽기"로 알린다(지금 말할 문장에 양보)
        try:
            synth(text, engine)
        except Exception:
            pass  # 양보하느라 중간에 끊겼으면 다음에 말할 때 만든다
        finally:
            qwen3.PREFETCH.on = False
    time.sleep(0.05)  # 문장 사이 틈: 그 사이 받아쓰기가 끼어들 수 있게


def prefetch(texts: list[str], engine: str | None = None) -> dict:
    """문장들을 뒤에서 미리 만든다. 이미 있는 건 건너뛴다. 받아쓰기에 양보한다."""
    todo = [t for t in texts if not cache_path(t, engine).exists()]
    for t in todo:
        _prefetcher.submit(_polite, t, engine)
    return {"queued": len(todo), "cached": len(texts) - len(todo)}


FIRST_WORDS = 4  # 첫 구는 어절 이만큼이면 문장이 안 끝나도 바로 합성 (두뇌가 다 쓰기 전에 첫 소리)
_END = re.compile(r"[.?!…。]+[\"')\]]*\s")
_COMMA = re.compile(r"[,，、]\s")


def split_ready(buf: str, first: bool, done: bool = False) -> tuple[list[str], str]:
    """글 조각을 받아 쌓인 buf에서 지금 합성할 구들을 떼어 낸다 → (구들, 남은 글).
    문장 끝(. ? ! …) 뒤에서 자른다. 첫 구만은 쉼표 뒤나 어절 FIRST_WORDS개가 차면 바로 — 첫 소리를 당기려고.
    뒤 구는 문장 단위로 (구를 잘게 자르면 억양이 끊긴다). done이면 남은 걸 다 내보낸다."""
    out = []
    while True:
        m = _END.search(buf)
        if first and not m:
            c = _COMMA.search(buf)
            words = buf.split()
            if c:
                m = c
            elif len(words) > FIRST_WORDS and buf[-1:].isspace() or len(words) > FIRST_WORDS + 1:
                cut = len(" ".join(words[:FIRST_WORDS])) + (len(buf) - len(buf.lstrip()))
                out.append(buf[:cut].strip())
                buf, first = buf[cut:].lstrip(), False
                continue
        if not m:
            break
        out.append(buf[: m.end()].strip())
        buf, first = buf[m.end() :], False
    if done and buf.strip():
        out.append(buf.strip())
        buf = ""
    return [x for x in out if x], buf
