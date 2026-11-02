"""클라우드 목소리 엔진: 키가 없거나 실패하면 Supertonic으로 되돌아가나, 키가 있으면 요청을 바르게 만드나 (네트워크 없이)."""

import os
import unittest
from pathlib import Path
from unittest import mock

import tts
from tts import elevenlabs, openai_tts, streaming, typecast


class Fallback(unittest.TestCase):
    def test_no_key_falls_back(self):
        calls = []

        def fake(text, engine, voice):
            calls.append(engine)
            if engine == "elevenlabs":
                raise streaming.NoKey("없음")
            return Path("/tmp/x.wav")

        with mock.patch.object(tts, "_synth", fake):
            self.assertEqual(tts.synth("네.", "elevenlabs"), Path("/tmp/x.wav"))
        self.assertEqual(calls, ["elevenlabs", tts.FALLBACK])

    def test_local_engine_no_fallback(self):
        with mock.patch.object(tts, "_synth", side_effect=RuntimeError("터짐")):
            with self.assertRaises(RuntimeError):
                tts.synth("네.", "say")

    def test_need_raises_without_key(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            for m in (elevenlabs, typecast, openai_tts):
                with self.assertRaises(streaming.NoKey):
                    m.request("네.")


class Requests(unittest.TestCase):
    def test_elevenlabs(self):
        with mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": "k", "ELEVENLABS_VOICE_ID": "v1"}, clear=True):
            url, h, body, sr = elevenlabs.request("안녕하세요.")
        self.assertIn("/v1/text-to-speech/v1/stream", url)
        self.assertIn("pcm_24000", url)
        self.assertEqual((h["xi-api-key"], body["model_id"], body["language_code"], sr), ("k", "eleven_flash_v2_5", "ko", 24000))

    def test_openai(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "k"}, clear=True):
            url, h, body, sr = openai_tts.request("안녕하세요.")
        self.assertEqual((body["model"], body["response_format"], h["authorization"]), ("gpt-4o-mini-tts", "pcm", "Bearer k"))

    def test_write_wav_odd_chunks(self):
        out = Path("/tmp/meety-test-stream.wav")
        streaming.write_wav(iter([b"\x01", b"\x00\x02", b"\x00"]), out, 24000)  # 바이트 반쪽에서 끊긴 조각
        import wave

        with wave.open(str(out)) as w:
            self.assertEqual((w.getnframes(), w.getframerate()), (2, 24000))
        out.unlink()


class Backchannels(unittest.TestCase):
    def test_kinds_have_3_to_4(self):
        for k, ts in tts.config.BACKCHANNEL_KINDS.items():
            self.assertTrue(3 <= len(ts) <= 4, k)
        self.assertEqual(len(tts.config.BACKCHANNELS), sum(len(v) for v in tts.config.BACKCHANNEL_KINDS.values()))


if __name__ == "__main__":
    unittest.main()


class Stream(unittest.TestCase):
    """tts.stream: 스트리밍 엔진은 조각을 오는 대로 넘기고, 다 받으면 캐시에 쓰고, 첫 조각 전에 실패하면 FALLBACK 파일."""

    def setUp(self):
        import tempfile

        self.d = Path(tempfile.mkdtemp())
        self.cache = mock.patch.object(tts, "CACHE", self.d)
        self.cache.start()

    def tearDown(self):
        self.cache.stop()

    def fake(self, chunks=None, fail=False):
        class A:
            SR = 24000

            @staticmethod
            def voice():
                return "fake"

            @staticmethod
            def stream(text, voice_name=None):
                if fail:
                    raise streaming.NoKey("없음")
                yield from chunks

        return A

    def test_streams_then_caches(self):
        import numpy as np

        loud = (np.sin(np.arange(4800) / 5) * 8000).astype("<i2").tobytes()
        A = self.fake([loud[:4000], loud[4000:]])
        with mock.patch.object(tts, "_adapter", return_value=A):
            sr, it = tts.stream("문장 하나 열두 글자 넘게 길게.", "qwen3")
            self.assertEqual(sr, 24000)
            got = []
            for b in it:
                got.append(b)
                self.assertIn("문장 하나 열두 글자 넘게 길게.", tts.live)  # 만드는 동안 에코 기준으로 쓸 수 있다
            self.assertEqual(b"".join(got), loud)
            self.assertNotIn("문장 하나 열두 글자 넘게 길게.", tts.live)
            self.assertTrue(tts.cache_path("문장 하나 열두 글자 넘게 길게.", "qwen3").exists())

    def test_fallback_before_first_chunk(self):
        A = self.fake(fail=True)
        with mock.patch.object(tts, "_adapter", return_value=A), mock.patch.object(tts, "synth", return_value=Path("/x.wav")) as syn, \
                mock.patch.object(tts, "_wav_pcm", return_value=(44100, b"\x00\x00")):
            sr, it = tts.stream("네.", "qwen3")
            self.assertEqual((sr, list(it)), (44100, [b"\x00\x00"]))
            syn.assert_called_with("네.", tts.FALLBACK)


class QwenVoiceKey(unittest.TestCase):
    """캐시 열쇠의 목소리 이름: 떠 있는 작업자가 알려 준 것 → 옛 작업자면 옛 이름 → 못 닿으면 지금 작업자 이름 (옛 1배 소리가 안 섞이게)."""

    def tearDown(self):
        from tts import qwen3

        qwen3._health.clear()

    def key(self, health):
        from tts import qwen3

        def alive(timeout=0.5):
            qwen3._health.clear()
            qwen3._health.update(health)
            return bool(health)

        qwen3._health.clear()
        with mock.patch.object(qwen3, "alive", alive):
            return qwen3.voice()

    def test_worker_reports(self):
        self.assertEqual(self.key({"ok": True, "voice": "qwen3-1.7b/sohee/x/x1.2/t0.5k20s7"}), "qwen3-1.7b/sohee/x/x1.2/t0.5k20s7")

    def test_old_worker_keeps_old_key(self):
        self.assertTrue(self.key({"ok": True}).startswith("qwen3-1.7b/sohee/"))
        self.assertNotIn("/x1.2/", self.key({"ok": True}))

    def test_unreachable_uses_current_tag(self):
        from tts_worker import VOICE_TAG

        self.assertEqual(self.key({}), VOICE_TAG)
        self.assertIn("/x1.2/", VOICE_TAG)


class Split(unittest.TestCase):
    """글 조각 → 구: 첫 구는 쉼표나 어절 4개면 바로, 뒤는 문장 끝마다."""

    def test_first_phrase_early(self):
        self.assertEqual(tts.split_ready("기록엔 없지만", True), ([], "기록엔 없지만"))
        self.assertEqual(tts.split_ready("기록엔 없지만 제 생각엔 화면부터 ", True), (["기록엔 없지만 제 생각엔"], "화면부터 "))
        self.assertEqual(tts.split_ready("음, 제 생각엔", True), (["음,"], "제 생각엔"))

    def test_later_by_sentence(self):
        self.assertEqual(tts.split_ready("화면부터 정하는 게 먼저예요, 그다음 ", False), ([], "화면부터 정하는 게 먼저예요, 그다음 "))
        self.assertEqual(tts.split_ready("먼저예요. 그다음 ", False), (["먼저예요."], "그다음 "))

    def test_flush_on_end(self):
        self.assertEqual(tts.split_ready("남은 말", False, done=True), (["남은 말"], ""))
