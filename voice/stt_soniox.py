"""Soniox 실시간 받아쓰기 (클라우드, 한국어, 시간당 약 $0.12) — MEETY_STT=soniox. 키 SONIOX_API_KEY(환경변수 또는 .env.local).

말 시작·끝(소리 감지·Smart Turn)·화자·끼어들기는 지금처럼 음성 서버가 정하고, 글자만 Soniox에서 받는다:
  마이크 PCM을 그대로 웹소켓으로 흘리고, 오는 글자 조각(token)을 시각과 함께 모은다.
  partial: 지금 마디 시각 안의 확정 글자(is_final) + 아직 바뀔 글자 → stable = 확정 글자 수.
  final: 마디가 끝나면 {"type":"finalize"}를 보내 그때까지를 바로 확정시키고, 앞 <fin> 다음부터 이번 <fin>까지 온 확정 글자를 그 마디 글로 한다.
  조각 시각으로 마디를 가르지 않는다: finalize를 보낼 때마다 Soniox 조각 시각이 0.3~0.9초(가끔 2.7초) 뒤로 밀려서, 시각으로 가르면
  말 끝 글자가 다음 마디로 넘어갔다(기헌 1:1 녹음 79초부터 "미"/"미티야, 대답해"…, S2 10/31 대본으로 확인: finalize 없이 ±0.2초, 마디마다 finalize면 +0.3~0.9초).
연결이 안 되거나 끊기거나 늦으면(FINAL_WAIT_S) 그 마디는 whisper로 — 회의가 글자 없이 멈추면 안 된다.
API: https://docs.soniox.com/stt/api-reference/websocket-api (키는 Authorization 머리로, 시작 메시지에 넣지 않는다)
"""

import asyncio
import json
import os
import time
from pathlib import Path

URL = os.environ.get("SONIOX_URL", "wss://stt-rt.soniox.com/transcribe-websocket")
MODEL = os.environ.get("SONIOX_MODEL", "stt-rt-v5")
FINAL_WAIT_S = float(os.environ.get("SONIOX_FINAL_WAIT_S", 1.5))
PRICE_PER_HOUR = 0.12  # 달러, 조사 문서(refs-2026-10-31/01) 기준 — 실제 청구는 Soniox 콘솔에서
MARKERS = ("<end>", "<fin>")


def api_key() -> str:
    k = os.environ.get("SONIOX_API_KEY", "").strip()
    if k:
        return k
    env = Path(os.environ.get("MEETY_ENV_FILE", Path(__file__).resolve().parent.parent / ".env.local"))
    if env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("SONIOX_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


class SonioxSTT:
    """웹소켓 연결 하나 = 회의 하나. 시각은 음성 서버 오디오 시계(초)로 바꿔 둔다: 연결한 때의 seg.clock = offset."""

    def __init__(self, terms: list[str], offset: float = 0.0):
        self.terms, self.offset = terms, offset
        self.buckets: dict[int, list[str]] = {}  # n번째 <fin>까지 온 확정 글자 (n = 그 마디가 보낸 finalize 순번)
        self.asked = 0  # 보낸 finalize 수
        self.dropped: set[int] = set()  # 기다리다 포기한 순번 — 늦게 온 글자는 다음 마디에 붙이지 않고 버린다
        self.nonfinal: list[dict] = []
        self.final_s = 0.0  # 여기까지의 소리는 확정됨 (오디오 시계)
        self.fins = 0  # 받은 <fin> 수
        self.ok = False
        self.error: str | None = None
        self.sent_s = 0.0
        self.on_update = None  # 새 글자가 오면 부른다 (partial 보내기)
        self._changed = asyncio.Event()

    async def connect(self, timeout: float = 5.0):
        import websockets

        key = api_key()
        if not key:
            raise RuntimeError("SONIOX_API_KEY가 없어요")
        hdr = {"Authorization": f"Bearer {key}"}
        try:
            self.ws = await websockets.connect(URL, additional_headers=hdr, max_size=None, open_timeout=timeout)
        except TypeError:  # 옛 websockets
            self.ws = await websockets.connect(URL, extra_headers=hdr, max_size=None, open_timeout=timeout)
        start = {"model": MODEL, "audio_format": "pcm_s16le", "sample_rate": 16000, "num_channels": 1, "language_hints": ["ko"],
                 "enable_endpoint_detection": False, "context": {"terms": self.terms}}
        await self.ws.send(json.dumps(start))
        self.ok = True
        self.task = asyncio.create_task(self._rx())

    def _fail(self, why: str):
        if self.ok:
            print(f"soniox: {why} → whisper로", flush=True)
        self.ok, self.error = False, why
        self._changed.set()

    async def send(self, pcm16: bytes):
        if not self.ok:
            return
        try:
            await self.ws.send(pcm16)
            self.sent_s += len(pcm16) / 2 / 16000
        except Exception as e:
            self._fail(f"보내기 실패 {type(e).__name__}")

    async def _rx(self):
        try:
            async for m in self.ws:
                d = json.loads(m)
                if d.get("error_code"):
                    self._fail(f"{d.get('error_type')} {d.get('error_code')}: {d.get('error_message', '')[:120]}")
                    return
                nonfinal = []
                for t in d.get("tokens", []):
                    if t["text"] == "<fin>":
                        self.fins += 1
                        if self.fins in self.dropped:
                            late = "".join(self.buckets.pop(self.fins, []))
                            if late.strip():
                                print(f"soniox: 마디 {self.fins} 글자가 늦게 와서 버림 ({len(late)}자)", flush=True)
                        continue
                    if t["text"] in MARKERS:
                        continue
                    if t.get("is_final"):
                        self.buckets.setdefault(self.fins + 1, []).append(t["text"])
                    else:
                        nonfinal.append({"text": t["text"]})
                self.nonfinal = nonfinal
                if "final_audio_proc_ms" in d:
                    self.final_s = d["final_audio_proc_ms"] / 1000 + self.offset
                self._changed.set()
                if self.on_update:
                    self.on_update()
                if d.get("finished"):
                    break
            if self.ok:
                self._fail("연결이 닫힘")
        except Exception as e:
            self._fail(f"받기 실패 {type(e).__name__}")

    def window(self, t0: float = 0.0, t1: float | None = None) -> tuple[str, int]:
        """(지금 마디의 글자, 그중 앞에서 확정된 글자 수) = 앞 <fin> 뒤로 온 확정 글자 + 아직 바뀔 글자."""
        fin = "".join(self.buckets.get(self.fins + 1, []))
        non = "".join(x["text"] for x in self.nonfinal)
        lead = len(fin) - len(fin.lstrip())
        return (fin + non).strip(), max(0, len(fin.rstrip()) - lead)

    async def final_text(self, t0: float = 0.0, t1: float = 0.0) -> str | None:
        """마디가 끝남: finalize를 보내고 그 <fin>이 올 때까지(FINAL_WAIT_S) 기다려 그 사이 확정 글자를 돌려준다.
        시간이 넘으면 그때까지 받은 것 + 경고(늦게 오는 나머지는 버림, 하나도 없으면 None). 연결이 없으면 None (whisper로)."""
        if not self.ok:
            return None
        self.asked += 1
        k = self.asked
        try:
            await self.ws.send(json.dumps({"type": "finalize"}))
        except Exception as e:
            self._fail(f"finalize 실패 {type(e).__name__}")
            return None
        until = time.monotonic() + FINAL_WAIT_S
        while self.ok and self.fins < k:
            self._changed.clear()
            left = until - time.monotonic()
            if left <= 0:
                self.dropped.add(k)
                got = "".join(self.buckets.get(k, [])).strip()
                print(f"soniox: 마디 {k} <fin>이 {FINAL_WAIT_S}초 안에 안 옴 — 받은 {len(got)}자만 냄", flush=True)
                self.buckets[k] = []  # 이미 낸 글자 — <fin>이 늦게 오면 그 사이 것만 버린다
                return got or None  # 하나도 못 받았으면 None → 이 마디는 whisper로
            try:
                await asyncio.wait_for(self._changed.wait(), left)
            except asyncio.TimeoutError:
                pass
        if not self.ok and self.fins < k:
            return None
        return "".join(self.buckets.pop(k, [])).strip()

    async def close(self):
        if getattr(self, "ws", None) is None:
            return
        was, self.ok = self.ok, False  # 닫는 중: "연결이 닫힘" 경고를 내지 않는다
        try:
            if was:
                await self.ws.send("")  # 빈 글 = 끝
            await asyncio.wait_for(self.task, 3)
        except Exception:
            pass
        try:
            await self.ws.close()
        except Exception:
            pass
        print(f"soniox: {self.sent_s / 60:.1f}분 보냄 ≈ ${self.sent_s / 3600 * PRICE_PER_HOUR:.4f}", flush=True)
