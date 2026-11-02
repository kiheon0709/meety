"""Soniox 실시간 받아쓰기 연결 — 가짜 Soniox 웹소켓 서버로(키·네트워크 없이)."""

import asyncio
import json
import os
import unittest
from unittest import mock

import websockets

import stt_soniox


async def fake_soniox(ws, log, die_after=None):
    """시작 메시지를 받고, 소리를 받는 동안 바뀔 글자, finalize가 오면 확정 글자 + <fin>."""
    start = json.loads(await ws.recv())
    log.append(("start", start, dict(ws.request.headers)))
    got, sent_final = 0, False
    async for m in ws:
        if isinstance(m, bytes):
            got += len(m)
            if die_after and got >= die_after:
                await ws.close()
                return
            ms = got // 32
            nf = {"text": "야", "start_ms": 400, "end_ms": 500, "is_final": False} if sent_final else {"text": "미티", "start_ms": 100, "end_ms": 400, "is_final": False}
            await ws.send(json.dumps({"tokens": [nf], "final_audio_proc_ms": 450 if sent_final else 0}))
            if ms >= 600 and not sent_final:  # 확정 조각은 한 번만 온다
                sent_final = True
                await ws.send(json.dumps({"tokens": [{"text": "미티", "start_ms": 100, "end_ms": 400, "is_final": True},
                                                     {"text": "야", "start_ms": 400, "end_ms": 500, "is_final": False}], "final_audio_proc_ms": 450}))
        elif m == "":
            await ws.send(json.dumps({"tokens": [], "finished": True}))
            return
        elif json.loads(m).get("type") == "finalize":
            await ws.send(json.dumps({"tokens": [{"text": "야", "start_ms": 400, "end_ms": 500, "is_final": True}, {"text": " 안녕", "start_ms": 600, "end_ms": 900, "is_final": True},
                                                 {"text": "<fin>", "is_final": True}], "final_audio_proc_ms": 1000}))


class Soniox(unittest.IsolatedAsyncioTestCase):
    async def start(self, **kw):
        self.log = []
        self.srv = await websockets.serve(lambda ws: fake_soniox(ws, self.log, **kw), "127.0.0.1", 0)
        port = self.srv.sockets[0].getsockname()[1]
        self.p1 = mock.patch.object(stt_soniox, "URL", f"ws://127.0.0.1:{port}")
        self.p2 = mock.patch.dict(os.environ, {"SONIOX_API_KEY": "test-key"})
        self.p1.start(), self.p2.start()

    async def asyncTearDown(self):
        if hasattr(self, "srv"):
            self.p1.stop(), self.p2.stop()
            self.srv.close()

    async def test_partial_final_and_key_in_header(self):
        await self.start()
        s = stt_soniox.SonioxSTT(["미티", "기헌"], offset=10.0)
        await s.connect()
        for _ in range(25):  # 0.8초
            await s.send(b"\x00\x00" * 512)
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.1)
        text, stable = s.window(10.0)
        self.assertEqual((text, stable), ("미티야", 2))  # "미티" 확정, "야"는 아직
        self.assertEqual(await s.final_text(10.0, 11.0), "미티야 안녕")
        self.assertEqual(s.window(10.0)[0], "")  # 쓴 글자는 다음 마디에 안 섞인다
        _, start, headers = self.log[0]
        self.assertNotIn("api_key", start)  # 키는 시작 메시지에 넣지 않는다
        self.assertEqual(headers.get("Authorization") or headers.get("authorization"), "Bearer test-key")
        self.assertEqual((start["audio_format"], start["sample_rate"], start["language_hints"]), ("pcm_s16le", 16000, ["ko"]))
        self.assertIn("기헌", start["context"]["terms"])
        await s.close()

    async def test_connection_drop_falls_back(self):
        await self.start(die_after=2048)
        s = stt_soniox.SonioxSTT([], 0)
        await s.connect()
        for _ in range(5):
            await s.send(b"\x00\x00" * 512)
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.2)
        self.assertFalse(s.ok)
        self.assertIsNone(await s.final_text(0, 1))  # → 서버가 whisper로

    async def test_no_key(self):
        with mock.patch.dict(os.environ, {"SONIOX_API_KEY": "", "MEETY_ENV_FILE": "/nonexistent"}):
            with self.assertRaises(RuntimeError):
                await stt_soniox.SonioxSTT([], 0).connect()

    async def test_final_timeout(self):
        await self.start()
        s = stt_soniox.SonioxSTT([], 0)
        await s.connect()
        with mock.patch.object(stt_soniox, "FINAL_WAIT_S", 0.2):
            s.ws.send = mock.AsyncMock()  # finalize가 서버에 안 가는 것처럼
            self.assertIsNone(await s.final_text(0, 5))


if __name__ == "__main__":
    unittest.main()


async def fake_seq(ws, delay_first=0.0):
    """마디마다 finalize → 그 마디 글자 + <fin>. 조각 시각은 일부러 엉망(finalize 뒤 밀리는 Soniox처럼). 첫 <fin>은 delay_first초 늦게."""
    await ws.recv()
    n = 0
    async for m in ws:
        if isinstance(m, bytes):
            continue
        if m == "":
            await ws.send(json.dumps({"tokens": [], "finished": True}))
            return
        if json.loads(m).get("type") == "finalize":
            n += 1
            if n == 1 and delay_first:
                await asyncio.sleep(delay_first)
            words = {1: ["미티", "야"], 2: ["대답", "해야지"], 3: ["좋아요"]}[n]
            await ws.send(json.dumps({"tokens": [{"text": w, "start_ms": 999999, "end_ms": 999999, "is_final": True} for w in words] + [{"text": "<fin>", "is_final": True}]}))


class SonioxSegments(unittest.IsolatedAsyncioTestCase):
    """마디 글자는 조각 시각이 아니라 finalize 순번(<fin> 사이)으로 가른다."""

    async def serve(self, **kw):
        self.srv = await websockets.serve(lambda ws: fake_seq(ws, **kw), "127.0.0.1", 0)
        self.patches = [mock.patch.object(stt_soniox, "URL", f"ws://127.0.0.1:{self.srv.sockets[0].getsockname()[1]}"),
                        mock.patch.dict(os.environ, {"SONIOX_API_KEY": "test-key"})]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        for p in self.patches:
            p.stop()
        self.srv.close()

    async def test_each_final_gets_its_own_words_despite_shifted_times(self):
        await self.serve()
        s = stt_soniox.SonioxSTT([], 0)
        await s.connect()
        self.assertEqual(await s.final_text(1.0, 2.0), "미티야")
        self.assertEqual(await s.final_text(5.0, 6.0), "대답해야지")
        await s.close()

    async def test_late_fin_words_are_dropped_not_glued_to_next(self):
        await self.serve(delay_first=0.4)
        s = stt_soniox.SonioxSTT([], 0)
        await s.connect()
        with mock.patch.object(stt_soniox, "FINAL_WAIT_S", 0.1):
            self.assertIsNone(await s.final_text(1.0, 2.0))  # 기다리다 포기 — 받은 게 없으니 whisper로
        await asyncio.sleep(0.5)  # 첫 마디 글자가 늦게 옴
        self.assertEqual(await s.final_text(5.0, 6.0), "대답해야지")  # 앞 마디 "미티야"가 붙지 않는다
        await s.close()
