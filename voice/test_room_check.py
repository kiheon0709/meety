"""방 점검 판정 (eval/room_check.verdict). 모델 없이 숫자만으로."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "eval"))
from room_check import verdict  # noqa: E402


def res(cer=0.05, starts=0, late=50, rows=None):
    rows = rows or [{"이름": "기헌", "CER": cer, "두 문장 닮음": 0.85, "다른 사람과 최대": 0.5, "등록 목소리와": None}]
    return {"rows": rows, "CER 전체": cer, "잡음": {"start": starts, "분당": starts / 9.5 * 60}, "말 끝 늦음 중앙(ms)": late}


class Verdict(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(verdict(res()), ["이 방 괜찮음"])

    def test_far(self):
        v = verdict(res(cer=0.2))
        self.assertEqual(len(v), 1)
        self.assertTrue(v[0].startswith("거리 줄이기"))

    def test_one_far_person(self):
        rows = [{"이름": "기헌", "CER": 0.02, "두 문장 닮음": 0.9, "다른 사람과 최대": 0.5, "등록 목소리와": None},
                {"이름": "지호", "CER": 0.3, "두 문장 닮음": 0.9, "다른 사람과 최대": 0.5, "등록 목소리와": None}]
        v = verdict(res(cer=0.1, rows=rows))
        self.assertIn("지호", v[0])

    def test_noise_one_start_in_quiet(self):
        self.assertTrue(verdict(res(starts=1))[0].startswith("소음 줄이기"))

    def test_noise_late_end(self):
        self.assertTrue(verdict(res(late=800))[0].startswith("소음 줄이기"))

    def test_speaker_weak(self):
        rows = [{"이름": "태은", "CER": 0.02, "두 문장 닮음": 0.6, "다른 사람과 최대": 0.5, "등록 목소리와": None}]
        self.assertTrue(verdict(res(rows=rows))[0].startswith("화자 구분 약함"))

    def test_registered_voice_mismatch(self):
        rows = [{"이름": "태은", "CER": 0.02, "두 문장 닮음": 0.9, "다른 사람과 최대": 0.5, "등록 목소리와": 0.6}]
        self.assertIn("태은", verdict(res(rows=rows))[0])


if __name__ == "__main__":
    unittest.main()
