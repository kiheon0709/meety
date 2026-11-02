"""Segmenter 회귀 시험 — 모델 없이 가짜 VAD로 돈다.

실행: voice/.venv/bin/python -m unittest  (voice/ 에서)

71분 E2E(tests/e2e/results/A-live-20261030-1348.json)에서 43분 지점 id 314가 speech_start 뒤 "end"가 영영 안 와
27분간 speech_start·final이 0개였다. 그런 VAD여도 MAX_SPEECH_S마다 끊고 다시 잡는지 본다.
긴 말은 SOFT_CUT_S가 넘으면 첫 짧은 쉼에서 먼저 끊는다 (문장 중간에서 잘리면 받아쓰기가 나빠져서, S2 측정).
"""

import unittest
from unittest import mock

import numpy as np

import segmenter
from segmenter import FRAME, SR, Segmenter


class FakeVAD:
    """end_at(초)에 end를 내는 VAD. None이면 start 뒤 영영 end를 안 낸다 (갇힌 모습).
    pauses: [(시작초, 끝초)] 말하는 중 짧게 조용한 때. silero처럼 그동안 temp_end(조용해지기 시작한 샘플)가 선다."""

    def __init__(self, end_at=None, pauses=()):
        self.end_at = end_at
        self.pauses = pauses
        self.current_sample = 0  # silero처럼 받은 샘플 수 (reset_states가 0으로 돌린다)
        self.armed = True  # 다음 프레임에 start를 낸다 (처음, 그리고 reset 뒤)
        self.speaking = False
        self.resets = 0
        self.temp_end = 0
        self.threshold = 0.5

    def __call__(self, frame):
        t = self.current_sample  # 샘플 단위 (silero처럼)
        self.current_sample += FRAME
        if not any(a * SR <= t < b * SR for a, b in self.pauses):
            self.temp_end = 0
        elif self.speaking and not self.temp_end:
            self.temp_end = self.current_sample
        if self.armed:
            self.armed = False
            self.speaking = True
            return {"start": t}
        if self.end_at is not None and t >= self.end_at * SR:
            self.speaking = False
            self.end_at = None
            return {"end": t}
        return None

    def reset_states(self):
        self.resets += 1
        self.speaking = False
        self.armed = True
        self.temp_end = 0
        self.current_sample = 0  # silero VADIterator.reset_states와 같게 — 시계도 0으로


def run(seg, seconds):
    frame = np.zeros(FRAME, np.float32)
    return [e for _ in range(int(seconds * SR / FRAME)) for e in seg.feed(frame)]


class StuckSpeech(unittest.TestCase):
    def test_forced_end_then_restart(self):
        vad = FakeVAD()
        seg = Segmenter(vad=vad)
        evs = run(seg, segmenter.MAX_SPEECH_S + 1)
        self.assertEqual([e[0] for e in evs], ["start", "end", "start"])
        _, t0, t1, audio = evs[1]
        self.assertAlmostEqual(t1 - t0, segmenter.MAX_SPEECH_S, delta=FRAME / SR)
        self.assertAlmostEqual(len(audio) / SR, segmenter.MAX_SPEECH_S, delta=2 * FRAME / SR)  # 시작 프레임 포함
        self.assertEqual(vad.resets, 1)  # VAD 상태를 새로 시작했다
        self.assertIsNotNone(seg.cur)  # 다시 말하는 중으로 잡았다
        self.assertEqual(evs[2][1], seg.t0)
        # 다시 잡은 start의 시각은 끊은 자리여야 한다 (silero가 reset 뒤 시계를 0으로 돌리는 걸 되돌렸는지). 실제 모델 재생에서 t≈0으로 나와 프레임마다 끊기던 버그
        self.assertAlmostEqual(evs[2][1], segmenter.MAX_SPEECH_S, delta=2 * FRAME / SR)

    def test_keeps_cutting_every_max_speech(self):
        seg = Segmenter(vad=FakeVAD())
        evs = run(seg, segmenter.MAX_SPEECH_S * 3 + 1)
        self.assertEqual([e[0] for e in evs if e[0] == "end"], ["end"] * 3)

    def test_soft_cut_at_first_pause_after_soft(self):
        # 8초 쉼은 SOFT_CUT_S 전이라 그냥 넘기고, 17초 쉼에서 끊는다 (쉼이 0.15초 넘게 이어진 뒤)
        vad = FakeVAD(pauses=[(8, 8.5), (17, 17.5)])
        seg = Segmenter(vad=vad)
        evs = run(seg, 20)
        ends = [e for e in evs if e[0] == "end"]
        self.assertEqual(len(ends), 1)
        self.assertGreaterEqual(ends[0][2], 17 + segmenter.SOFT_PAUSE_S)
        self.assertLess(ends[0][2], 17.25)
        self.assertEqual(vad.resets, 1)

    def test_short_blip_does_not_cut(self):
        # 0.1초 숨 고르기는 쉼으로 안 친다 → 쉼이 없으니 MAX_SPEECH_S에서 강제로
        seg = Segmenter(vad=FakeVAD(pauses=[(16, 16.1), (22, 22.1)]))
        evs = run(seg, segmenter.MAX_SPEECH_S + 1)
        ends = [e for e in evs if e[0] == "end"]
        self.assertEqual(len(ends), 1)
        self.assertAlmostEqual(ends[0][2], segmenter.MAX_SPEECH_S, delta=FRAME / SR)

    def test_normal_speech_untouched(self):
        vad = FakeVAD(end_at=2.0)
        seg = Segmenter(vad=vad)
        evs = run(seg, 5)
        self.assertEqual([e[0] for e in evs], ["start", "end"])
        self.assertAlmostEqual(evs[1][2], 2.0, delta=FRAME / SR)
        self.assertEqual(vad.resets, 0)


HINT = "회의 참석자는 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티."  # server.hint("기헌, 준영, 태은, 지호")


def heard(text, prompt=HINT):
    """가짜 whisper가 text를 냈을 때 transcribe가 돌려주는 글."""
    with mock.patch.object(segmenter.mlx_whisper, "transcribe", return_value={"text": text}):
        return segmenter.transcribe(np.zeros(SR, np.float32), prompt)


class HintEcho(unittest.TestCase):
    """받아쓰기가 힌트 문장을 그대로 뱉은 것(71분 E2E #276, 2185.6초)은 버리고, 사람이 소개하는 말은 살린다."""

    def test_e2e_276_twice(self):
        self.assertEqual(heard("이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티. 이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티."), "")

    def test_e2e_276_once(self):
        self.assertEqual(heard("이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티."), "")

    def test_hint_verbatim(self):
        self.assertEqual(heard(HINT), "")
        self.assertEqual(heard("회의에는 AI 팀원 미티도 참석해요.", "회의에는 AI 팀원 미티도 참석해요."), "")

    def test_human_introduction_kept(self):
        for t in ("저희 팀은 기헌, 태은, 지호, 그리고 AI 팀원 미티예요.", "오늘은 기헌, 태은 그리고 AI 팀원 미티가 같이 합니다."):
            self.assertEqual(heard(t), t)

    def test_normal_speech_kept(self):
        for t in ("미티야, 리허설 언제로 정했었지?", "기헌이랑 태은이가 그리고 미티도 같이 보면 좋겠어요."):
            self.assertEqual(heard(t), t)

    def test_no_prompt_untouched(self):
        # 중간 결과(partial)는 힌트 없이 받아쓴다 → 힌트를 뱉을 일이 없고 거르지도 않는다
        t = "이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티."
        self.assertEqual(heard(t, None), t)


if __name__ == "__main__":
    unittest.main()


class ScriptVAD:
    """정해 둔 프레임에 start/end를 낸다 {프레임 번호: "start" | "end"}."""

    def __init__(self, script):
        self.script, self.n, self.current_sample, self.temp_end, self.threshold = script, 0, 0, 0, 0.5

    def __call__(self, frame):
        self.n += 1
        self.current_sample += FRAME
        k = self.script.get(self.n)
        return {k: self.current_sample} if k else None

    def reset_states(self):
        pass


def feed(seg, frames):
    z = np.zeros(FRAME, np.float32)
    return [(i + 1, e) for i in range(frames) for e in seg.feed(z)]


class SmartTurn(unittest.TestCase):
    """Smart Turn: 짧은 쉼(200ms)에서 확률이 높으면 바로 끝, 낮으면 지금 기준(500ms)까지 기다림, 그 사이 다시 말하면 같은 마디."""

    def test_high_prob_ends_at_short_silence(self):
        seg = Segmenter(500, vad=ScriptVAD({1: "start", 40: "end"}), turn=lambda a: 0.95)
        evs = feed(seg, 80)
        ends = [(i, e) for i, e in evs if e[0] == "end"]
        self.assertEqual(len(ends), 1)
        self.assertEqual(ends[0][0], 40)  # VAD가 멈춘 그 프레임
        self.assertAlmostEqual(seg.turn_p, 0.95)

    def test_low_prob_waits_until_hold(self):
        seg = Segmenter(500, vad=ScriptVAD({1: "start", 40: "end"}), turn=lambda a: 0.1)
        evs = feed(seg, 80)
        ends = [i for i, e in evs if e[0] == "end"]
        self.assertEqual(len(ends), 1)
        # end 때(프레임 40) 조용해진 지 pad(0.1초)였다 → 0.5초가 되려면 0.4초(12.5프레임) 더
        self.assertEqual(ends[0], 40 + int(np.ceil(0.4 * SR / FRAME)))
        self.assertAlmostEqual(seg.turn_p, 0.1)
        self.assertTrue(seg.quiet_from < ends[0] * FRAME / SR - 0.4)

    def test_resume_during_wait_keeps_one_segment(self):
        seg = Segmenter(500, vad=ScriptVAD({1: "start", 40: "end", 45: "start", 90: "end"}), turn=lambda a: 0.1)
        evs = [e for _, e in feed(seg, 150)]
        self.assertEqual([e[0] for e in evs], ["start", "resume", "end"])
        self.assertEqual(len(evs[-1][3]) // FRAME, evs[-1][3].shape[0] // FRAME)  # 한 마디에 두 말소리가 다 들어 있다
        self.assertGreater(len(evs[-1][3]), 90 * FRAME - 10 * FRAME)

    def test_model_error_falls_back(self):
        def boom(a):
            raise RuntimeError("모델 없음")

        seg = Segmenter(500, vad=ScriptVAD({1: "start", 40: "end"}), turn=boom)
        ends = [i for i, e in feed(seg, 80) if e[0] == "end"]
        self.assertEqual(len(ends), 1)
        self.assertIsNone(seg.turn_p)

    def test_off_is_unchanged(self):
        seg = Segmenter(500, vad=ScriptVAD({1: "start", 40: "end"}))
        ends = [i for i, e in feed(seg, 80) if e[0] == "end"]
        self.assertEqual(ends, [40])
        self.assertIsNone(seg.turn_p)
