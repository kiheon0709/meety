"""소리 감지(silero VAD) + 받아쓰기(mlx-whisper). 서버와 재생 평가가 같이 쓴다."""

import os
import re
import threading

import mlx_whisper
import numpy as np
import torch
from silero_vad import VADIterator, load_silero_vad

SR = 16000
FRAME = 512  # 32ms, silero가 받는 크기
MODEL = "mlx-community/whisper-large-v3-turbo"
# 말 하나가 이보다 길면 강제로 끝낸다. 71분 E2E(A-live-20261030-1348)에서 43분 지점 id 314가 start 뒤 "end"가 영영 안 와
# 27분간 speech_start·final이 0개였다(VAD가 말하는 중 상태에 갇힘). 갇혀도 이 길이마다 final이 나가고 VAD를 새로 시작해 다음 말을 다시 잡는다
MAX_SPEECH_S = float(os.environ.get("VOICE_MAX_SPEECH_S", 30))
# 그 전에, 말이 이보다 길어지면 처음 오는 짧은 쉼(SOFT_PAUSE_S 넘게 조용)에서 끊는다. 딱 20초에 자르면 문장 중간이 잘려
# 마침표가 붙고 앞뒤 낱말이 흔들렸다(S2 측정, 멘토링 15분 CER 0.0530→0.0585)
SOFT_CUT_S = float(os.environ.get("VOICE_SOFT_CUT_S", 15))
SOFT_PAUSE_S = 0.15

# GPU는 하나라 받아쓰기는 한 번에 하나씩
_whisper_lock = threading.Lock()
# 지금 받아쓰는 중인 개수. 미리 굽기(tts.prefetch)가 이게 0일 때만 돌게 한다
_active = 0
_active_guard = threading.Lock()


def transcribing() -> bool:
    return _active > 0

# 무음·잡음에서 whisper가 지어내는 문장. "자막"·"구독" 같은 낱말만으로 거르면 회의 중 진짜 말("영상 자막은…")까지 사라져서 문구로 거른다
_HALLUCINATIONS = re.compile(
    r"(시청해\s*주셔서|구독(과|와)?\s*좋아요|좋아요\s*눌러|구독\s*부탁|(MBC|KBS|SBS)\s*뉴스|자막\s*(제공|싱크|by)|한글\s*자막|다음\s*영상에서|이\s*시각\s*세계|^\W*$)"
)

_FOREIGN = re.compile(r"[\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F]")

# 받아쓰기 힌트(server.hint: "회의 참석자는 …, 그리고 AI 팀원 미티.")를 whisper가 그대로 뱉은 것.
# 71분 E2E #276(2185.6초): "이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티." 두 번 — "미티"가 들어 두뇌 호출어에 걸릴 수 있다.
# 두뇌도 같은 꼴을 버린다(src/lib/live/rules.ts isHintEcho). 사람이 소개하는 말("…그리고 AI 팀원 미티예요")은 살린다
_HINT_TAIL = re.compile(r"그리고\s*AI\s*팀원\s*미티")
_HINT_HEAD = re.compile(r"회의\s*참석자는.*AI\s*팀원\s*미티|회의에는\s*AI\s*팀원\s*미티도\s*참석")
_HINT_END = re.compile(r"AI\s*팀원\s*미티\W*$")
_WORD = re.compile(r"[가-힣A-Za-z0-9]+")


def hint_echo(text: str, prompt: str) -> bool:
    if len(_HINT_TAIL.findall(text)) >= 2 or _HINT_HEAD.search(text):
        return True
    # 한 번이면: "…AI 팀원 미티."로 끝나고(조사·"예요" 없이) 힌트에 없는 낱말이 둘 이하("이 시즌은")
    other = [w for w in _WORD.findall(text) if w not in set(_WORD.findall(prompt))]
    return bool(_HINT_END.search(text)) and len(other) <= 2


def transcribe(audio: np.ndarray, prompt: str | None = None) -> str:
    if len(audio) < SR * 0.3:
        return ""
    global _active
    with _active_guard:
        _active += 1
    try:
        return _transcribe(audio, prompt)
    finally:
        with _active_guard:
            _active -= 1


def _transcribe(audio: np.ndarray, prompt: str | None) -> str:
    with _whisper_lock:
        r = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=MODEL,
            language="ko",
            initial_prompt=prompt,
            condition_on_previous_text=False,
            # 짧은 잡음·스피커 에코에서 지어내기 시작하면 온도를 올려 가며 6번까지 다시 풀고(최대 224토큰씩) 6초 넘게 걸렸다.
            # 받아쓰기는 한 번에 하나라 그동안 다른 사람 말의 final이 다 밀린다 → 한 번만, 길이에 맞는 만큼만 (S7 E2E)
            temperature=0.0,
            sample_len=int(16 + len(audio) / SR * 20),
        )
    text = r["text"].strip()
    # 한국어 회의에 키릴·아랍·태국 문자가 섞이면 지어낸 것 (에코·잡음에서 "Ini самый Gorfi…")
    if prompt and hint_echo(text, prompt):
        return ""
    return "" if _HALLUCINATIONS.search(text) or _FOREIGN.search(text) else text


class Segmenter:
    """32ms 프레임을 받아 말 시작·끝을 알려주고, 끝난 말의 오디오를 돌려준다.

    feed()가 돌려주는 이벤트:
      ("start", t)            말이 시작됨 (barge-in 신호)
      ("end", t0, t1, audio)  말이 끝남 (min_silence_ms 동안 조용)
    t는 스트림 시작부터의 초. 받은 프레임 수로 세므로 벽시계와 상관없다.
    "end" 직후 quiet_from은 실제로 조용해지기 시작한 때(t1에서 앞뒤 여유를 뺀 값). gap은 여기서부터 잰다.

    turn(Smart Turn 확률 함수)을 주면: silero는 turn_silence_ms(200ms) 조용하면 멈추고, 그때 최근 8초로 "말이 끝났나" 확률을 낸다.
    turn_th 이상이면 바로 "end", 아니면 조용함이 min_silence_ms(지금 기준 500ms)가 될 때까지 기다렸다 "end" — 지금보다 늦어지는 일은 없다.
    기다리는 동안 다시 말하면 같은 마디로 이어 가고 ("resume", t)를 낸다 (미티가 말하는 중이면 서버가 끼어들기로 본다).
    마지막 "end"의 확률은 turn_p (못 쟀으면 None).
    """

    def __init__(self, min_silence_ms: int = 500, threshold: float = 0.5, vad=None, turn=None, turn_th: float = 0.85, turn_silence_ms: int = 200):
        self.pad = 0.1
        self.turn, self.turn_th, self.hold_s = turn, turn_th, min_silence_ms / 1000
        if vad is None:  # 시험은 모델 없이 가짜 VAD를 넣는다 (test_segmenter.py)
            self.model = load_silero_vad()
            silence = turn_silence_ms if turn else min_silence_ms
            vad = VADIterator(self.model, threshold=threshold, sampling_rate=SR, min_silence_duration_ms=silence, speech_pad_ms=int(self.pad * 1000))
        self.vad = vad
        self.pending: dict | None = None  # Smart Turn이 "안 끝남"이라 해서 기다리는 중 {end, p}
        self.turn_p: float | None = None
        self.hist: list[np.ndarray] = []  # 최근 8초 (Smart Turn 입력)
        self.pre: list[np.ndarray] = []  # 말 시작 직전 0.3초
        self.cur: list[np.ndarray] | None = None
        self.t0 = 0.0
        self.quiet_from = 0.0
        self.frames = 0

    @property
    def clock(self) -> float:
        """지금까지 받은 오디오 길이(초)."""
        return self.frames * FRAME / SR

    @property
    def quieting(self) -> bool:
        """말하는 중에 조용해지기 시작함 (곧 "end"가 날 수 있음)."""
        return self.cur is not None and (bool(self.vad.temp_end) or self.pending is not None)

    def set_threshold(self, threshold: float):
        self.vad.threshold = threshold

    def current_audio(self) -> np.ndarray:
        return np.concatenate(self.cur) if self.cur else np.zeros(0, np.float32)

    def feed(self, frame: np.ndarray) -> list[tuple]:
        out = []
        self.frames += 1
        # 초로 받으면 0.1초 단위로 반올림돼서, 샘플로 받아 직접 나눈다
        e = self.vad(torch.from_numpy(frame))
        e = e and {k: v / SR for k, v in e.items()}
        if self.cur is not None:
            self.cur.append(frame)
        else:
            self.pre = (self.pre + [frame])[-10:]
        if self.turn:
            self.hist = (self.hist + [frame])[-(8 * SR // FRAME) :]
        if e and "start" in e and self.cur is None:
            self.cur = self.pre + [frame]
            self.pre = []
            self.t0 = e["start"]
            out.append(("start", self.t0))
        elif e and "start" in e and self.pending:
            self.pending = None  # 짧은 쉼 뒤 다시 말함 → 같은 마디
            out.append(("resume", e["start"]))
        if e and "end" in e and self.cur is not None and not self.pending:
            p = None
            if self.turn:
                try:
                    p = self.turn(np.concatenate(self.hist))
                except Exception:
                    p = None  # 모델이 안 되면 지금 기준(500ms)대로
            if self.turn and (p is None or p < self.turn_th):
                self.pending = {"end": e["end"], "p": p}
            else:
                out.append(self._end(e["end"], p))
        if self.pending and self.clock - (self.pending["end"] - self.pad) >= self.hold_s:
            out.append(self._end(self.pending["end"], self.pending["p"]))
        dur = self.clock - self.t0 if self.cur is not None else 0.0
        paused = bool(self.vad.temp_end) and self.vad.current_sample - self.vad.temp_end >= SOFT_PAUSE_S * SR
        if dur >= MAX_SPEECH_S or (dur >= SOFT_CUT_S and paused):
            # 너무 긴 말: 쉼에서(없으면 MAX_SPEECH_S에서) 끊어 final을 내보내고 VAD 상태를 새로 시작한다. 계속 말하는 중이면 다시 "start"가 난다
            audio = np.concatenate(self.cur)
            self.cur = None
            self.pre = []
            self.vad.reset_states()
            # silero는 reset하면 자기 시계(current_sample)도 0으로 돌려서 다음 start가 t≈0으로 나온다 → 프레임마다 또 끊기는 폭주. 시계를 되돌려 준다
            self.vad.current_sample = self.frames * FRAME
            self.quiet_from = self.clock
            self.pending, self.turn_p = None, None
            out.append(("end", self.t0, self.clock, audio))
        return out

    def _end(self, t1: float, p: float | None) -> tuple:
        audio = np.concatenate(self.cur)
        self.cur, self.pending, self.turn_p = None, None, p
        # 처음 조용했던 프레임의 시작에서, silero가 조용함을 알아채는 늦음(재생 평가로 잰 중앙값 66ms)을 뺀다
        self.quiet_from = t1 - self.pad - 2 * FRAME / SR
        return ("end", self.t0, t1, audio)
