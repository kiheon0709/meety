"""갈피 음성 서버: 브라우저 마이크 → 소리 감지 → 받아쓰기 → 이벤트. 미티 목소리(TTS)도 여기서 만든다.

실행: npm run voice  (http://localhost:8765)
"""

import asyncio
import json
import sys
import traceback
import os
import re
import time
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import tts
from segmenter import FRAME, SR, Segmenter, transcribe, transcribing
import smart_turn
import stt_soniox
from speakers import barge_verdict, embed, registry

ROOT = Path(__file__).parent
REC_DIR = ROOT / "recordings"

PARTIAL_EVERY = 0.8  # 말하는 중 중간 받아쓰기 간격(초)
TTS_THRESHOLD = 0.8  # 미티가 말하는 동안엔 스피커 소리에 덜 반응하게
# 이만큼 조용하면 말 하나가 끝난 것으로 본다. 줄이면 final이 빨리 오지만 한 사람 말이 여러 조각으로 잘린다
MIN_SILENCE_MS = int(os.environ.get("VOICE_MIN_SILENCE_MS", 500))
# 말 끝 판정 모델 Smart Turn v3.2 (smart_turn.py). silero는 200ms 조용하면 멈추고 "끝났나" 확률이 이 이상이면 바로 final,
# 아니면 MIN_SILENCE_MS까지 기다린다(지금보다 늦어지지 않음). 0이면 끔. 측정(S2 10/31): 기헌 1:1 재생에서 말 끝→final 908→632ms(0.8), 0.85면 778ms.
# 1:1 말 중간 짧은 쉼 6개는 모두 0.22 이하. 멘토링 71분(한 사람이 길게 설명)에서는 final의 18%만 빨라지고 짧은 쉼에서 분당 1.3번 더 끊는다(그중 30%가 문장 중간)
SMART_TURN = float(os.environ.get("VOICE_SMART_TURN", 0.8))
# 받아쓰기: soniox(클라우드 실시간, stt_soniox.py) | whisper(이 맥). 기본은 Soniox 키가 있으면 soniox. 연결이 안 되면 그 회의·그 마디는 whisper로
STT = os.environ.get("MEETY_STT") or ("soniox" if stt_soniox.api_key() else "whisper")
GAPS = (300, 800, 1500)  # 말이 끝난 뒤 이만큼(ms) 조용하면 gap을 보낸다. 끼어들기 강도가 이 값을 쓴다
TICK_S = 5  # 받은 오디오 이만큼마다 tick을 보낸다. 소리는 가는데 이벤트가 안 오면 서버가 멎은 것 — 화면이 알아보고 다시 붙는다
# 미티가 말하는 중 소리가 나면, 그게 스피커로 나간 미티 목소리(에코)인지 사람인지 이만큼 들어 보고 정한다
ECHO_LISTEN_S = float(os.environ.get("VOICE_ECHO_LISTEN_S", 0.35))
# 마이크 소리와 미티 목소리(기준)의 정규화 상관이 이 이상이면 에코로 본다
ECHO_NCC = float(os.environ.get("VOICE_ECHO_NCC", 0.6))  # 시험: 에코만 0.99, 사람 0.21~0.37, 사람+에코 0.24~0.43
# 1초 안 되는 짧은 소리(맞장구 "음"·"아하")는 방 울림이 비교 창을 많이 차지해 에코만 들어와도 0.48~0.56이 나온다 → 따로 낮춘다.
# 시험(eval/echo_backchannel.py, 1m·울림 0.4초): 짧은 맞장구 에코만 0.48~0.56, 같은 때 사람이 말하면 0.07~0.16
ECHO_NCC_SHORT = float(os.environ.get("VOICE_ECHO_NCC_SHORT", 0.45))
# 미티가 말하는 중 사람 소리가 이만큼(초) 이어져야 끼어들기로 본다. "네"·"음"·기침(0.2~0.5초)에는 멈추지 않게 (GeekNews 글 3 댓글, S2 10/31).
# 짧게 끝난 소리는 barge_in 없이 지나가고 그 final은 echo 표시(미티 말하는 중)로 간다. 0이면 예전처럼 에코 판정(0.35초) 뒤 바로
BARGE_MIN_S = float(os.environ.get("VOICE_BARGE_MIN_S", 0.6))
ECHO_NCC_LONG = float(os.environ.get("VOICE_ECHO_NCC_LONG", 0.5))  # 그 0.6초 창으로 다시 견줄 때의 에코 임계
# 에코로 정한 마디도 미티가 말하는 동안 0.2초마다 다시 견준다: 미티 목소리 에코가 이어지는 중에 사람이 말을 시작하면 같은 마디로 붙어
# 끼어들기를 못 잡았다(S2 10/31 barge_short.py). 소리가 나는 동안 5번 잇달아(0.8초) 이 아래면 사람이 섞인 것 → barge_in
ECHO_NCC_HUMAN = float(os.environ.get("VOICE_ECHO_NCC_HUMAN", 0.4))
WATCH_STEP, WATCH_LOWS = 0.2, 5


# 단계별 지연 기록 (shuo처럼 한 턴씩): 사람 말 끝 → final → (두뇌) → 목소리 첫 조각 → 화면 재생 시작.
# 음성 서버는 두뇌를 못 보니, final 뒤 처음 온 "지금 말할" TTS 요청을 그 턴의 대답으로 본다. 한 줄씩 data/meeting-logs/latency-날짜.jsonl
LAT_DIR = ROOT.parent / "data" / "meeting-logs"
_lat: dict = {"turn": None}


def lat_final(i: int, text: str, true_end: float, speech_end: float):
    """final을 보낸 때. 앞 턴이 대답 없이 끝났으면 그대로 적는다."""
    if _lat["turn"]:
        lat_write(_lat["turn"])
    _lat["turn"] = {"id": i, "text": text[:40], "end": true_end, "speech_end": speech_end, "final": time.time()}


def lat_tts(kind: str):
    """kind: req(/tts·/tts/stream을 받음) | first(첫 소리 조각을 보냄) | play(화면이 tts on — 재생 시작)."""
    t = _lat["turn"]
    if not t or kind in t or (kind != "req" and "req" not in t):
        return
    t[kind] = time.time()
    if kind == "play":
        lat_write(t)
        _lat["turn"] = None


def lat_write(t: dict):
    ms = lambda a, b: round((t[b] - t[a]) * 1000) if a in t and b in t else None  # noqa: E731
    row = {"at": time.strftime("%H:%M:%S", time.localtime(t["final"])), "id": t["id"], "text": t["text"],
           "말끝판정": ms("end", "speech_end"), "받아쓰기": ms("speech_end", "final"), "두뇌": ms("final", "req"),
           "목소리첫조각": ms("req", "first"), "재생시작": ms("first", "play"), "말끝→첫소리": ms("end", "play")}
    try:
        LAT_DIR.mkdir(parents=True, exist_ok=True)
        with open(LAT_DIR / f"latency-{time.strftime('%Y%m%d')}.jsonl", "a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


def load_ref(text: str) -> np.ndarray:
    """미티가 지금 읽는 문장의 소리 (16kHz). 화면이 /tts로 받은 것과 같은 캐시 파일.
    /tts/stream으로 아직 만드는 중이면 그때까지 받은 조각으로 (만드는 게 재생보다 3배 빨라서 앞부분은 이미 있다)."""
    if text in tts.live:
        sr, chunks = tts.live[text]
        b = b"".join(chunks)
        a = np.frombuffer(b[: len(b) // 2 * 2], dtype="<i2").astype(np.float32) / 32767
    else:
        a, sr = sf.read(str(tts.synth(text)), dtype="float32", always_2d=True)
        a = a.mean(axis=1)
    if sr != SR:
        a = np.interp(np.arange(0, len(a), sr / SR), np.arange(len(a)), a).astype(np.float32)
    return a


def echo_score(mic: np.ndarray, ref: np.ndarray, offset: int) -> float:
    """mic(최근 소리)가 ref(미티 목소리)의 offset 근처 조각과 얼마나 닮았나 (0~1, 정규화 상관 최댓값).

    스피커 → 마이크로 돌아오는 데 걸리는 시간·브라우저 재생 지연을 몰라서 -0.5~+0.8초 사이 어긋남을 다 본다.
    """
    # 마이크 창이 미티 소리 시작보다 앞에서 시작하면(대개 그렇다) 기준 앞쪽이 모자라니 0으로 채운다
    pad = int(0.5 * SR) + len(mic)
    # 뒤도 채운다: 맞장구("음", 0.5초)처럼 짧은 소리는 듣는 창(0.45초)이 기준 끝을 넘어 뒤쪽 어긋남을 못 봤다
    ref = np.concatenate([np.zeros(pad, np.float32), ref, np.zeros(len(mic) + int(0.8 * SR), np.float32)])
    offset += pad
    lo = max(0, offset - int(0.5 * SR))
    hi = min(len(ref), offset + int(0.8 * SR) + len(mic))
    seg = ref[lo:hi]
    if len(seg) < len(mic) or not mic.any():
        return 0.0
    dots = np.correlate(seg, mic, "valid")
    e = np.cumsum(np.concatenate([[0.0], seg.astype(np.float64) ** 2]))
    energy = np.sqrt(np.maximum(e[len(mic) :] - e[: -len(mic)], 1e-12))
    return float(np.max(np.abs(dots) / (energy * np.linalg.norm(mic) + 1e-9)))


def hint(names: str | None) -> str:
    """받아쓰기 힌트. 호출어가 니티·밑위·미티아로 흔들려서 이름을 알려 준다.

    문장 꼴로 준다: "미티야, 기헌, …"처럼 이름만 늘어놓으면 짧은 소리·잡음에서 이름을 그대로 읊고,
    "미티야,"로 끝나면 말 첫머리의 "미티야"를 이미 한 말로 여겨 빼먹는다 (eval_hint.py로 잼).
    """
    names = (names or "").strip(" ,.…")
    return f"회의 참석자는 {names}, 그리고 AI 팀원 미티." if names else "회의에는 AI 팀원 미티도 참석해요."


_WORDCHAR = re.compile(r"[^\s\W]")


def stable_chars(prev: str | None, text: str) -> int:
    """partial.stable: text 앞에서 바로 앞 partial(같은 말)과 같은 글자 수 (text 그대로 센 글자 수 → text[:n]으로 바로 쓴다).

    띄어쓰기·문장부호는 빼고 비교한다 — whisper가 "시연영"→"시연 영상"처럼 띄어쓰기·마침표만 바꾸는 일이 많아서.
    partial 두 개가 연달아 같은 앞부분 = 약 0.8초 유지. 실측(멘토링 71분): 이 앞부분은 final 대비 편집 거리 4.9%, final 글자의 45%가
    평균 4.4초 먼저 여기 들어온다 (voice/eval/partial_stability.py). 첫 partial은 0, 고쳐 쓰면 공통 앞부분까지 줄어든다.
    """
    if not prev:
        return 0
    a, b = _WORDCHAR.findall(prev), [(m.group(), m.end()) for m in _WORDCHAR.finditer(text)]
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n][0]:
        n += 1
    return b[n - 1][1] if n else 0


# 미리 굽기는 받아쓰기에 양보한다 (tts.prefetch)
tts.busy = transcribing

app = FastAPI()
# 화면은 세션마다 포트가 달라서(3100·3103·3106 …) 이 컴퓨터 안이면 다 받는다
LOCAL_ORIGIN = r"http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"
app.add_middleware(CORSMiddleware, allow_origin_regex=LOCAL_ORIGIN, allow_methods=["*"], allow_headers=["*"], expose_headers=["x-sample-rate", "x-text"])


def local_origin(origin: str | None) -> bool:
    """브라우저가 붙인 Origin이 이 컴퓨터 화면인가. 노드·파이썬 시험 도구는 Origin이 없어서 통과."""
    import re

    return origin is None or re.fullmatch(LOCAL_ORIGIN, origin) is not None


def require_confirm(request: Request):
    """목소리 등록·삭제(S9 V7): 남이 "기헌" 이름으로 자기 목소리를 올리거나 지우지 못하게.
    - 이 컴퓨터 화면에서 온 요청만 (Origin 확인)
    - x-voice-confirm 헤더 필수: 다른 사이트가 몰래 보내는 요청(CSRF)은 이 헤더를 못 붙인다(브라우저가 사전 확인에서 막음)
    서버 자체는 npm run meeting에서 127.0.0.1에만 묶인다."""
    if not local_origin(request.headers.get("origin")):
        raise HTTPException(403, "이 컴퓨터의 미티 화면에서만 할 수 있어요")
    if request.headers.get("x-voice-confirm") != "1":
        raise HTTPException(403, "화면에서 확인해야 해요 (x-voice-confirm)")


@app.on_event("startup")
def warm_up():
    # 첫 호출은 모델 로딩으로 2초쯤 걸려서 미리 한 번 돌린다
    transcribe(np.zeros(SR, np.float32))
    # 모델을 쓰는 목소리는 첫 문장이 느려서 한 번 읽혀 둔다
    if SMART_TURN:
        try:
            smart_turn.prob(np.zeros(SR, np.float32))  # 처음이면 HF에서 8MB 받고 데운다
        except Exception as e:
            print(f"Smart Turn을 못 불러서 끕니다 (말 끝 {MIN_SILENCE_MS}ms로): {e}", flush=True)
    if tts.config.ENGINE == "qwen3":
        from tts import qwen3

        if qwen3.ensure_worker():
            print(f"목소리: {qwen3.describe()}", flush=True)
        else:
            print(f"목소리: Supertonic으로 대체 — {qwen3.status['why']}", flush=True)
    else:
        print(f"목소리: {tts.config.ENGINE} (MEETY_TTS)", flush=True)
    print(f"받아쓰기: {'Soniox 실시간 (클라우드)' if STT == 'soniox' else 'whisper (이 맥)'}", flush=True)
    tts.synth("네.")
    if tts.config.ENGINE == "qwen3":
        # 스트리밍 작업자는 한 번에 한 문장이라, 뒤에서 굽는 동안 첫 대답이 몇 초 밀렸다(10/31 측정 5.8초) → 켜는 동안 다 굽는다(캐시라 처음 한 번 40초쯤)
        for t in tts.config.FILLERS + tts.config.BACKCHANNELS:
            tts.synth(t)
    else:
        tts.prefetch(tts.config.FILLERS + tts.config.BACKCHANNELS)  # 받침말·여는 말·맞장구는 미리 (뒤에서, 받아쓰기에 양보)
    embed(np.random.default_rng(0).normal(0, 0.1, SR * 2).astype(np.float32))


class TTSReq(BaseModel):
    text: str
    voice: str | None = None  # 목소리 이름 (say면 Yuna 등). 비우면 tts/config.py 기본
    engine: str | None = None  # 비우면 tts/config.py ENGINE (비교·시험용)


@app.on_event("shutdown")
def stop_worker():
    from tts import qwen3

    qwen3.stop_worker()


@app.post("/tts/stream")
def speak_stream(req: TTSReq):
    """/tts와 같지만 만들어지는 대로 흘려보낸다: 머리 없는 PCM16 모노 (content-type audio/L16;rate=…, x-sample-rate).
    캐시에 있으면 한 번에. 화면은 조각이 오는 대로 이어 붙여 틀면 첫 소리가 첫 조각(0.1~0.2초)에 난다."""
    from fastapi.responses import StreamingResponse

    lat_tts("req")
    sr, chunks = tts.stream(req.text, req.engine)

    def timed():
        first = True
        for b in chunks:
            if first:
                lat_tts("first")
                first = False
            yield b

    return StreamingResponse(timed(), media_type=f"audio/L16;rate={sr};channels=1", headers={"x-sample-rate": str(sr), "cache-control": "no-store"})


@app.websocket("/tts/ws")
async def speak_ws(sock: WebSocket):
    """글 조각으로 받아 말하기 — 두뇌가 문장을 다 쓰기 전에 첫 구부터 합성한다.

    받는 것(텍스트):  {"type":"text","text":"조각"} 여러 번 → {"type":"end"} (다 보냄) · {"type":"cancel"} (지금 것과 남은 것 버림)
    보내는 것:        {"type":"segment","index":n,"text":구,"sr":24000} → 그 구의 PCM16 조각들(바이너리) → {"type":"segment_end","index":n}
                      다 끝나면 {"type":"done"}. 화면은 segment마다 음성 /ws에 {"type":"tts","on":true,"text":구}를 보내야 에코로 걸러진다.
    구 나누기: 첫 구는 쉼표 뒤나 어절 4개가 차면 바로, 그 뒤는 문장 끝마다 (tts.split_ready). 합성은 한 번에 한 구, 받는 건 계속.
    """
    await sock.accept()
    loop = asyncio.get_running_loop()
    buf, first, done, idx = "", True, False, 0
    queue: asyncio.Queue = asyncio.Queue()
    cancel = asyncio.Event()

    async def speak():
        nonlocal idx
        while True:
            phrase = await queue.get()
            if phrase is None:
                await sock.send_json({"type": "done"})
                return
            if cancel.is_set():
                continue
            sr, chunks = await loop.run_in_executor(None, tts.stream, phrase)
            await sock.send_json({"type": "segment", "index": idx, "text": phrase, "sr": sr})
            it = iter(chunks)
            while not cancel.is_set():
                b = await loop.run_in_executor(None, next, it, None)
                if b is None:
                    break
                await sock.send_bytes(b)
            if cancel.is_set() and hasattr(chunks, "close"):
                chunks.close()
            await sock.send_json({"type": "segment_end", "index": idx})
            idx += 1

    task = asyncio.create_task(speak())
    try:
        while not done:
            m = json.loads(await sock.receive_text())
            if m["type"] == "text":
                buf += m.get("text", "")
            elif m["type"] == "end":
                done = True
            elif m["type"] == "cancel":
                cancel.set()
                buf, done = "", True
            ready, buf = tts.split_ready(buf, first, done)
            for ph in ready:
                first = False
                await queue.put(ph)
        await queue.put(None)
        await task
    except WebSocketDisconnect:
        cancel.set()
        task.cancel()


@app.get("/tts/stream.wav")
def speak_stream_wav(text: str):
    """같은 스트리밍을 wav로: 길이를 모르는 wav 머리 + PCM16을 만들어지는 대로. 화면은 <audio src="…/tts/stream.wav?text=…">만 바꾸면
    브라우저가 받는 대로 튼다(크롬 확인, S2 10/31). 원래 /tts처럼 fetch→blob으로 받으면 다 받을 때까지 기다리니 그렇게 쓰지 말 것."""
    import struct

    from fastapi.responses import StreamingResponse

    sr, chunks = tts.stream(text)
    big = 0x7FFFFFF0  # 길이 모름 — 크게 적는다
    head = b"RIFF" + struct.pack("<I", big + 36) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16) + b"data" + struct.pack("<I", big)

    def body():
        yield head
        yield from chunks

    return StreamingResponse(body(), media_type="audio/wav", headers={"cache-control": "no-store"})


@app.post("/tts")
def speak(req: TTSReq):
    # 같은 문장은 한 번만 만든다. 미리 만드는 중이면 그게 끝나길 기다린다
    engine = req.engine or tts.config.ENGINE
    # 예전 화면은 voice="Yuna"를 붙여 보내서, 엔진을 따로 고르지 않았으면 say 아닌 엔진엔 넘기지 않는다
    voice = req.voice if (req.engine or engine == "say") else None
    lat_tts("req")
    try:
        path = tts.synth(req.text, engine, voice)
        lat_tts("first")
        return FileResponse(path, media_type="audio/wav")
    except ValueError as e:
        raise HTTPException(400, str(e))


class PrefetchReq(BaseModel):
    texts: list[str]
    engine: str | None = None


@app.post("/tts/prefetch")
def prefetch(req: PrefetchReq):
    """두뇌가 말할 거리를 준비할 때 문장을 미리 구워 둔다. 기다리지 않고 바로 돌아온다."""
    return tts.prefetch(req.texts, req.engine)


@app.get("/status")
def status():
    """켤 때 정한 목소리·받아쓰기 (npm run meeting이 한 줄로 찍는다)."""
    from tts import qwen3

    eng = tts.config.ENGINE
    if eng == "qwen3":
        voice = qwen3.describe() if qwen3.alive() else f"Supertonic으로 대체 — {qwen3.status['why']}"
    else:
        voice = eng
    return {"voice": voice, "stt": "Soniox 실시간 (클라우드)" if STT == "soniox" else "whisper (이 맥)"}


@app.get("/tts/fillers")
def fillers():
    """미리 구워 둔 받침말·여는 말(FILLERS)과 맞장구(BACKCHANNELS) (tts/config.py). 이 글자 그대로 /tts에 보내면 캐시에서 바로 나온다."""
    texts = tts.config.FILLERS + tts.config.BACKCHANNELS
    return {"texts": tts.config.FILLERS, "backchannels": tts.config.BACKCHANNEL_KINDS, "cached": sum(tts.cache_path(t).exists() for t in texts), "total": len(texts)}


@app.get("/tts/backchannel/{kind}")
def backchannel(kind: str):
    """맞장구 종류(tts/config.py BACKCHANNEL_KINDS)에서 하나를 무작위로. 미리 구운 것 중에서 고르고, 고른 글자는 x-text 머리(URL 인코딩)로 —
    화면은 이 글자를 tts on에 실어 보내야 에코로 걸러진다."""
    import random
    import urllib.parse

    texts = tts.config.BACKCHANNEL_KINDS.get(kind)
    if not texts:
        raise HTTPException(404, f"모르는 종류: {kind} (있는 것: {', '.join(tts.config.BACKCHANNEL_KINDS)})")
    ready = [t for t in texts if tts.cache_path(t).exists()] or texts
    text = random.choice(ready)
    return FileResponse(tts.synth(text), media_type="audio/wav", headers={"x-text": urllib.parse.quote(text)})


@app.get("/samples/{name}.wav")
def sample(name: str):
    """시험용 가짜 회의 소리 (fake_meeting.py가 만든 voice/recordings/{name}.wav). 화면의 ?feed=로 마이크 대신 흘린다."""
    path = REC_DIR / f"{name}.wav"
    if not name.replace("-", "").isalnum() or not path.exists():
        raise HTTPException(404, "없는 녹음")
    return FileResponse(path, media_type="audio/wav")


@app.get("/speakers")
def speakers_list():
    return {"speakers": sorted(registry.voices)}


@app.post("/speakers/enroll")
async def speakers_enroll(name: str, request: Request, replace: bool = False):
    """몸통에 wav(아무 표본율, 5초쯤). 웹소켓 enroll 메시지로도 등록할 수 있다.
    이미 있는 이름을 덮어쓰려면 ?replace=true (화면에서 "다시 등록할까요?" 확인을 받은 경우)."""
    import io

    require_confirm(request)
    if name in registry.voices and not replace:
        raise HTTPException(409, f"{name} 님 목소리는 이미 등록돼 있어요. 다시 등록하려면 화면에서 확인해 주세요")

    a, sr = sf.read(io.BytesIO(await request.body()), dtype="float32", always_2d=True)
    a = a.mean(axis=1)
    if sr != SR:
        a = np.interp(np.arange(0, len(a), sr / SR), np.arange(len(a)), a).astype(np.float32)
    try:
        return {"name": name, "seconds": registry.enroll(name, a)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/speakers/{name}")
def speakers_remove(name: str, request: Request):
    require_confirm(request)
    registry.remove(name)
    return {"speakers": sorted(registry.voices)}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    """클라이언트 → 서버
      텍스트 {"type":"start","prompt":"기헌, 태은…","save":false}  회의 시작 (save = 학습용 녹음 저장 동의)
      텍스트 {"type":"tts","on":true,"text":"문장"}               미티가 말하기 시작/끝 (text: 지금 읽는 문장, 문장마다. 에코 거르기용, 선택)
      텍스트 {"type":"enroll","name":"기헌"} … {"type":"enroll","name":null}   (이미 있는 이름은 "replace":true 있어야 덮어씀)
                                         그 사이 끝난 말들로 화자 등록 (5초쯤). 말이 끝나고 조용해진 뒤(speech_end 뒤) 끝 메시지를 보낸다.
                                         결과는 enrolled {name,seconds} 또는 enroll_error {name,message} (계약 밖 추가분)
      바이너리 16kHz mono int16 PCM
    서버 → 클라이언트 (형식은 src/lib/live/contract.ts VoiceEvent)
      speech_start {id,t} · speech_end {id,t0,t1} · partial {id,text,stable}
      final {id,t0,t1,text}
        + speaker  등록된 사람 중 가장 가까운 이름. 모르거나 1초보다 짧으면 키가 없다
        + "echo": true  미티가 말하던 동안(tts on) 들어온 말. 스피커 소리가 다시 들어온 것일 수 있다 (계약 밖 추가분)
        + barge  이 마디가 barge_in을 낸 말이면 그 목소리: "member"(등록 참석자) | "other"(등록자와 확실히 다름, 유사도 < 0.5) | "unsure"
      gap {after_id,ms}  말이 끝난(speech_end) 뒤 조용함이 300·800·1500ms를 넘을 때마다 한 번씩.
        조용함은 실제로 말이 멎은 때부터 받은 오디오 길이로 잰다(벽시계 아님).
        그 사이 speech_start가 오면 남은 gap은 버린다.
        final을 기다리지 않는다: 받아쓰기가 0.4초쯤 걸려서 300·800 gap은 보통 같은 id의 final보다 먼저 온다.
      tick {t}           받은 오디오 TICK_S초마다(심장박동). 소리를 보내는데 이게 안 오면 서버가 멎은 것 → 화면이 끊고 다시 붙는다
      barge_in {id,t}    tts on인 동안 speech_start가 나면 보낸다. tts on에 text(지금 읽는 문장)가 같이 오면
        0.35초 들어 보고 미티 목소리(스피커 에코)와 닮았으면 안 보낸다 → 그 말은 받아쓰지 않고 final {text:"", echo:true}
    t·t0·t1은 연결 뒤 받은 오디오 기준 초.
    """
    # 다른 사이트가 몰래 이 컴퓨터의 음성 서버에 붙지 못하게 (브라우저는 웹소켓에 Origin을 붙인다)
    if not local_origin(sock.headers.get("origin")):
        await sock.close(code=1008)
        return
    await sock.accept()
    loop = asyncio.get_running_loop()
    seg = Segmenter(MIN_SILENCE_MS, turn=smart_turn.prob if SMART_TURN and smart_turn.ready() else None, turn_th=SMART_TURN or 1.0)
    prompt: str | None = None
    rec: wave.Wave_write | None = None
    log = None
    pending = b""
    seg_id = 0
    last_tick = 0.0
    partial_busy = False
    last_partial_text: dict[int, str] = {}  # 말 id → 바로 앞에 보낸 partial (stable 계산용)
    last_partial = 0.0
    finals_busy = 0
    finals_sent: set[int] = set()
    tts_on = False
    tts_spans: list[list[float]] = []  # 미티가 말한 구간 [시작, 끝] (오디오 시계)
    # 지금 세고 있는 조용함: after_id, 조용해진 때, 다음에 보낼 GAPS 순번
    gap: dict | None = None
    stt: stt_soniox.SonioxSTT | None = None  # MEETY_STT=soniox일 때 회의마다 연결 하나
    enrolling: str | None = None  # 지금 등록 중인 이름
    enroll_audio: list[np.ndarray] = []
    # 에코 거르기: 미티가 지금 읽는 문장의 소리와 시작 시각(오디오 시계)
    ref: np.ndarray | None = None
    ref_from = 0.0
    recent: list[np.ndarray] = []  # 최근 마이크 프레임 (1초쯤)
    barge_wait: dict | None = None  # 미티 말하는 중 시작된 소리: 에코인지 들어 보는 중 {id, t, until}
    barge_ids: set[int] = set()
    seg_ends: dict[int, tuple[float, float]] = {}  # 지연 기록용
    echo_watch = {"at": 0.0, "low": 0, "off_at": None}  # 에코 마디 다시 보기
    barge_hold: dict | None = None  # 사람 소리로 정했지만 BARGE_MIN_S가 안 돼 barge_in을 미루는 중 {id, t, t0}  # barge_in을 보낸 마디 → 그 final에 barge(누구 목소리였나)를 붙인다
    echo_ids: set[int] = set()  # 미티 목소리(에코)로 판정된 말 — 받아쓰지 않는다

    async def send(ev: dict):
        if log:
            log.write(json.dumps(ev, ensure_ascii=False) + "\n")
        await sock.send_text(json.dumps(ev, ensure_ascii=False))

    async def flush_gaps():
        nonlocal gap
        while gap and gap["next"] < len(GAPS):
            ms = GAPS[gap["next"]]
            if (seg.clock - gap["from"]) * 1000 < ms:
                break
            gap["next"] += 1
            await send({"type": "gap", "after_id": gap["after_id"], "ms": ms})

    async def finalize(i: int, t0: float, t1: float, audio: np.ndarray, turn: float | None = None):
        nonlocal finals_busy
        if stt and stt.ok and i not in echo_ids:
            # Soniox: 글자는 클라우드에서(바로 확정), 화자 찾기는 여기서 같이. 못 받으면 whisper로
            text, (who, score) = await asyncio.gather(stt.final_text(t0, t1), loop.run_in_executor(None, registry.identify, audio))
            if text is not None:
                await send_final(i, t0, t1, text, who, score, turn)
                return
        if i in echo_ids:
            # 스피커로 나간 미티 목소리: 받아쓰면 GPU만 쓰고(지어내기도 함) 다른 사람 final이 밀린다
            if stt and stt.ok:
                await stt.final_text(t0, t1)  # Soniox 쪽도 이 마디를 확정해 버린다 — 안 그러면 에코 글자가 다음 마디 앞에 붙는다
            finals_sent.add(i)
            await send({"type": "final", "id": i, "t0": round(t0, 2), "t1": round(t1, 2), "text": "", "echo": True})
            return
        finals_busy += 1
        try:
            # 화자 찾기는 CPU라 받아쓰기(GPU)와 같이 돌린다
            text, (who, score) = await asyncio.gather(
                loop.run_in_executor(None, transcribe, audio, hint(prompt)),
                loop.run_in_executor(None, registry.identify, audio),
            )
        finally:
            finals_busy -= 1
        await send_final(i, t0, t1, text, who, score, turn)

    async def send_final(i, t0, t1, text, who, score, turn):
        finals_sent.add(i)
        if text and i not in echo_ids:
            # 오디오 시계 → 벽시계: 실시간으로 들어오니 지금 시각에서 (지금 오디오 시계 - 그때)를 뺀다
            now = time.time()
            ends = seg_ends.pop(i, None)
            if ends:
                lat_final(i, text, now - (seg.clock - ends[0]), ends[1])
        ev = {"type": "final", "id": i, "t0": round(t0, 2), "t1": round(t1, 2), "text": text}
        if turn is not None:
            ev["turn"] = round(turn, 3)  # Smart Turn "말이 끝났나" 확률 — 미티가 바로 답해도 되는지 두뇌가 본다(4명 회의에선 말 끝 ≠ 미티 차례)
        if who:
            ev["speaker"] = who
        if any(a < t1 and t0 < (b if b is not None else t1 + 1) for a, b in tts_spans):
            ev["echo"] = True
        if i in barge_ids:
            # 미티를 끊은 말: 등록 참석자였나. 두뇌가 이걸 보고 끊김을 인정하거나(member·unsure) 다시 말한다(other)
            ev["barge"] = barge_verdict(who, score)
        await send(ev)

    async def decide_barge(force: bool = False):
        """미티 말하는 중 시작된 소리를 ECHO_LISTEN_S만큼 들었으면 에코인지 정한다. 사람이면 barge_in."""
        nonlocal barge_wait
        if not barge_wait or (seg.clock < barge_wait["until"] and not force):
            return
        w, barge_wait = barge_wait, None
        mic = np.concatenate(recent)[-int(ECHO_LISTEN_S * SR) - FRAME * 3 :] if recent else np.zeros(0, np.float32)
        score = 0.0
        r, r_from = w["ref"], w["ref_from"]
        if r is not None and len(mic):
            offset = int((seg.clock - len(mic) / SR - r_from) * SR)
            score = echo_score(mic, r, offset)
        print(f"echo_check id={w['id']} score={score:.3f} ref={'yes' if r is not None else 'no'} offset={(seg.clock - r_from):.2f}s", flush=True)
        if log:
            log.write(json.dumps({"type": "echo_check", "id": w["id"], "score": round(score, 3)}) + "\n")
        if score >= (ECHO_NCC_SHORT if r is not None and len(r) < SR else ECHO_NCC):
            echo_ids.add(w["id"])
        else:
            await barge(w["id"], w["t"], r, r_from)

    async def barge(i: int, t: float, r: np.ndarray | None = None, r_from: float = 0.0):
        """사람이 미티를 끊음 — 그 소리가 BARGE_MIN_S 넘게 이어질 때만 (짧은 맞장구·기침은 끊김이 아님)."""
        nonlocal barge_hold
        if BARGE_MIN_S and seg.clock - t < BARGE_MIN_S:
            if seg.cur is not None:
                barge_hold = {"id": i, "t": t, "ref": r, "ref_from": r_from}  # 더 들어 본다
            elif log:  # 벌써 끝난 짧은 소리
                log.write(json.dumps({"type": "short_during_tts", "id": i}) + "\n")
            return
        barge_hold = None
        barge_ids.add(i)
        await send({"type": "barge_in", "id": i, "t": t})

    async def watch_echo():
        """에코로 정한 지금 마디에 사람이 섞였나. 미티가 말하는 중이면 끼어들기, 다 말한 뒤 이어지면 사람 말로 받아쓰기."""
        if seg.cur is None or seg_id not in echo_ids:
            echo_watch["low"] = 0
            return
        if not tts_on:
            if echo_watch["off_at"] is not None and seg.clock - echo_watch["off_at"] > 0.6 and not seg.quieting:
                echo_ids.discard(seg_id)  # 미티는 멎었는데 소리가 이어짐(울림은 0.4초 안에 사라진다) = 사람
            return
        if ref is None or seg.clock - echo_watch["at"] < WATCH_STEP:
            return
        echo_watch["at"] = seg.clock
        if seg.quieting:  # 소리가 멎는 중(울림 꼬리·쉼)은 세지 않는다 — 에코만 있을 때 꼬리에서 잘못 잡았다
            echo_watch["low"] = 0
            return
        mic = np.concatenate(recent)[-int(0.4 * SR) :]
        score = echo_score(mic, ref, int((seg.clock - len(mic) / SR - ref_from) * SR))
        echo_watch["low"] = echo_watch["low"] + 1 if score < ECHO_NCC_HUMAN else 0
        # 0.2초마다 0.4초 창, 5번 잇달아(0.8초) — "네"·"음"(0.2~0.4초)은 많아야 4번이라 끊김이 아니다
        if echo_watch["low"] >= WATCH_LOWS:
            print(f"echo_watch id={seg_id} score={score:.3f} → 사람이 섞임", flush=True)
            echo_watch["low"] = 0
            echo_ids.discard(seg_id)
            barge_ids.add(seg_id)
            await send({"type": "barge_in", "id": seg_id, "t": round(seg.clock - WATCH_STEP * WATCH_LOWS, 2)})

    async def check_barge_hold():
        """미뤄 둔 끼어들기: 말이 BARGE_MIN_S까지 이어졌으면 지금 보낸다. 그 전에 조용해지거나 마디가 끝나면 버린다."""
        nonlocal barge_hold
        h = barge_hold
        if not h:
            return
        if h["id"] != seg_id or seg.cur is None:
            barge_hold = None
            if log:
                log.write(json.dumps({"type": "short_during_tts", "id": h["id"]}) + "\n")
            return
        if seg.clock - h["t"] >= BARGE_MIN_S and not seg.quieting:
            barge_hold = None
            if h["ref"] is not None and recent:
                # 한 번 더: 더 긴 창(BARGE_MIN_S)으로 미티 목소리와 견준다. Qwen3 목소리는 첫 0.35초 창에선 에코만 들어와도 0.45~0.55가 나왔다
                mic = np.concatenate(recent)[-int(BARGE_MIN_S * SR) :]
                score = echo_score(mic, h["ref"], int((seg.clock - len(mic) / SR - h["ref_from"]) * SR))
                print(f"echo_check2 id={h['id']} score={score:.3f}", flush=True)
                if log:
                    log.write(json.dumps({"type": "echo_check2", "id": h["id"], "score": round(score, 3)}) + "\n")
                if score >= ECHO_NCC_LONG:
                    echo_ids.add(h["id"])
                    return
            barge_ids.add(h["id"])
            await send({"type": "barge_in", "id": h["id"], "t": h["t"]})

    soniox_last = {"id": None, "text": "", "at": 0.0}

    def soniox_partial():
        """Soniox에서 새 글자가 오면: 지금 열린 마디의 글자를 partial로. 0.25초에 한 번까지.
        stable = Soniox 확정 글자 수와 "앞 partial과 같은 앞부분"(whisper와 같은 규칙) 중 큰 것 — Soniox는 마디 끝에서야 확정을 몰아 주지만
        중간 글자가 거의 안 바뀐다(대본 40마디: 앞 partial을 고쳐 쓴 것 1%, 2연속 규칙의 안정 글자 틀림 0%, final 글자 79%가 1.5초 먼저, S2 10/31)."""
        if seg.cur is None or seg_id in finals_sent or seg_id in echo_ids:
            return
        text, stable = stt.window(seg.t0)
        now = time.monotonic()
        if not text or (soniox_last["id"] == seg_id and (text == soniox_last["text"] or now - soniox_last["at"] < 0.25)):
            return
        prev = soniox_last["text"] if soniox_last["id"] == seg_id else None
        stable = max(stable, stable_chars(prev, text))
        soniox_last.update(id=seg_id, text=text, at=now)
        asyncio.create_task(send({"type": "partial", "id": seg_id, "text": text, "stable": stable}))

    async def partial(i: int, audio: np.ndarray):
        nonlocal partial_busy
        try:
            # 짧은 오디오에 힌트 문장을 주면 whisper가 힌트를 그대로 읊어서, 중간 결과엔 안 준다
            text = await loop.run_in_executor(None, transcribe, audio)
            if text and i not in finals_sent and i not in echo_ids:  # final 뒤에 온 중간 결과·에코는 버린다
                prev = last_partial_text.get(i)
                last_partial_text.clear()  # 지난 말 것은 필요 없다
                last_partial_text[i] = text
                await send({"type": "partial", "id": i, "text": text, "stable": stable_chars(prev, text)})
        finally:
            partial_busy = False

    try:
        while True:
            msg = await sock.receive()
            try:
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("text"):
                    m = json.loads(msg["text"])
                    if m["type"] == "start":
                        prompt = m.get("prompt") or None
                        if STT == "soniox" and stt is None:
                            terms = ["미티", "갈피"] + [n.strip() for n in (prompt or "").split(",") if n.strip()]
                            stt = stt_soniox.SonioxSTT(terms, offset=seg.clock)
                            try:
                                await stt.connect()
                                stt.on_update = soniox_partial
                            except Exception as e:
                                print(f"soniox 연결 못 함({type(e).__name__}: {str(e)[:80]}) → whisper로", flush=True)
                                stt = None
                        if m.get("save"):
                            REC_DIR.mkdir(exist_ok=True)
                            stamp = time.strftime("%Y%m%d-%H%M%S")
                            rec = wave.open(str(REC_DIR / f"{stamp}.wav"), "wb")
                            rec.setnchannels(1)
                            rec.setsampwidth(2)
                            rec.setframerate(SR)
                            log = open(REC_DIR / f"{stamp}.jsonl", "w")
                    elif m["type"] == "tts":
                        seg.set_threshold(TTS_THRESHOLD if m["on"] else 0.5)
                        # text가 오면(문장마다) 그 소리를 에코 기준으로. 안 오면(예전 화면) 바로 barge_in 하던 대로
                        if m["on"] and m.get("text"):
                            try:
                                ref = await loop.run_in_executor(None, load_ref, m["text"])
                                ref_from = seg.clock
                            except Exception:
                                ref = None
                        elif not m["on"]:
                            ref = None
                        if m["on"]:
                            lat_tts("play")
                        if m["on"] and not tts_on:
                            tts_spans.append([seg.clock, None])
                        elif not m["on"] and tts_on:
                            tts_spans[-1][1] = seg.clock
                            echo_watch["off_at"] = seg.clock
                        tts_on = bool(m["on"])
                        if log:
                            log.write(json.dumps({"type": "tts", "on": m["on"], "wall": time.time()}) + "\n")
                    elif m["type"] == "enroll":
                        if m.get("name"):
                            # 이미 등록된 이름은 화면에서 "다시 등록할까요?"를 확인했을 때만 (replace: true) 덮어쓴다 (S9 V7)
                            if m["name"] in registry.voices and not m.get("replace"):
                                await send({"type": "enroll_error", "name": m["name"], "message": "이미 등록된 이름이에요. 다시 등록하려면 화면에서 확인해 주세요"})
                                continue
                            enrolling, enroll_audio = m["name"], []
                        elif enrolling:
                            name, audio = enrolling, np.concatenate(enroll_audio) if enroll_audio else np.zeros(0, np.float32)
                            enrolling = None
                            try:
                                secs = await loop.run_in_executor(None, registry.enroll, name, audio)
                                await send({"type": "enrolled", "name": name, "seconds": secs})
                            except ValueError as e:
                                await send({"type": "enroll_error", "name": name, "message": str(e)})
                    continue

                data = pending + msg["bytes"]
                usable = len(data) - len(data) % (FRAME * 2)
                pending = data[usable:]
                if rec:
                    rec.writeframes(data[:usable])
                if stt and stt.ok:
                    await stt.send(data[:usable])
                pcm = np.frombuffer(data[:usable], np.int16).astype(np.float32) / 32768
                for k in range(0, len(pcm), FRAME):
                    frame = pcm[k : k + FRAME]
                    recent.append(frame)
                    if len(recent) > SR // FRAME:
                        recent.pop(0)
                    for ev in seg.feed(frame):
                        if ev[0] in ("start", "resume"):
                            if ev[0] == "start":
                                seg_id += 1
                                gap = None
                                await send({"type": "speech_start", "id": seg_id, "t": round(ev[1], 2)})
                            # resume: Smart Turn이 "안 끝남"이라 기다리던 짧은 쉼 뒤 다시 말함 — 같은 마디라 speech_start는 없지만
                            # 그 사이 미티가 말을 시작했으면 끼어들기로 본다
                            if not tts_on or (ev[0] == "resume" and seg_id in barge_ids):
                                pass
                            elif ref is not None:
                                # 그때 읽던 문장(ref)을 같이 기억한다: 맞장구("음" 0.5초)처럼 짧으면 다 듣기 전에 tts off가 와 ref가 비고,
                                # 자기 소리를 사람으로 보고 barge_in을 냈다 (S2 10/31, eval/echo_backchannel.py)
                                barge_wait = {"id": seg_id, "t": round(ev[1], 2), "until": seg.clock + ECHO_LISTEN_S, "ref": ref, "ref_from": ref_from}
                            else:
                                await barge(seg_id, round(ev[1], 2))
                        else:
                            if barge_wait and barge_wait["id"] == seg_id:
                                await decide_barge(force=True)
                            _, t0, t1, audio = ev
                            await send({"type": "speech_end", "id": seg_id, "t0": round(t0, 2), "t1": round(t1, 2)})
                            seg_ends[seg_id] = (seg.quiet_from, time.time())  # 실제로 조용해진 때(오디오 시계)·speech_end 보낸 때(벽시계)
                            gap = {"after_id": seg_id, "from": seg.quiet_from, "next": 0}
                            if enrolling:
                                enroll_audio.append(audio)
                            asyncio.create_task(finalize(seg_id, t0, t1, audio, seg.turn_p))
                    # 프레임마다 확인해서 gap이 오디오 시계로 한 프레임(32ms) 안에 맞게
                    await flush_gaps()
                    await decide_barge()
                    await check_barge_hold()
                    await watch_echo()
                    if seg.clock - last_tick >= TICK_S:
                        last_tick = seg.clock
                        await send({"type": "tick", "t": round(seg.clock, 2)})

                now = time.monotonic()
                audio = seg.current_audio()
                # 받아쓰기는 한 번에 하나라, final이 기다리지 않게 final 중이거나 말이 멎는 중엔 중간 결과를 쉰다
                if not (stt and stt.ok) and len(audio) > SR * 0.6 and not partial_busy and not finals_busy and not seg.quieting and now - last_partial > PARTIAL_EVERY:
                    partial_busy = True
                    last_partial = now
                    asyncio.create_task(partial(seg_id, audio))
            except Exception:
                # 프레임 하나·메시지 하나가 터져도 연결은 살린다. 71분 E2E 43분 지점에서 핸들러가 소리 없이 끝난 뒤 27분 침묵 — 원인은 stderr가 없어 못 봤다
                print(f"ws error (continuing) at t={seg.clock:.1f}s:", file=sys.stderr, flush=True)
                traceback.print_exc()
    except WebSocketDisconnect:
        pass
    finally:
        if stt:
            await stt.close()
        if rec:
            rec.close()
        if log:
            log.close()
