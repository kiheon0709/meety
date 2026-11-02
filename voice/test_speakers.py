"""화자 찾기·끊은 목소리 판정 시험 — 모델 없이 가짜 지문으로 돈다.

실행: voice/.venv/bin/python -m unittest  (voice/ 에서)
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import speakers
from speakers import Registry, barge_verdict


def unit(*xs):
    v = np.array(xs, np.float32)
    return v / np.linalg.norm(v)


class Identify(unittest.TestCase):
    def setUp(self):
        self.reg = Registry(Path(tempfile.mkdtemp()) / "s.json")

    def heard(self, vec):
        with mock.patch.object(speakers, "embed", return_value=vec):
            return self.reg.identify(np.zeros(16000, np.float32))

    def test_no_one_enrolled(self):
        self.assertEqual(self.heard(unit(1, 0)), (None, None))

    def test_too_short_to_tell(self):
        self.reg.voices = {"기헌": unit(1, 0)}
        self.assertEqual(self.heard(None), (None, None))  # 지문 못 만듦 = 모름 (0.0이 아니다)

    def test_member_and_stranger(self):
        self.reg.voices = {"기헌": unit(1, 0), "태은": unit(0, 1)}
        self.assertEqual(self.heard(unit(1, 0.1))[0], "기헌")
        name, score = self.heard(unit(-1, -0.2))
        self.assertIsNone(name)
        self.assertLess(score, 0)


class BargeVerdict(unittest.TestCase):
    """미티를 끊은 목소리: member(등록 참석자) → 끊김 인정, other(확실히 다른 목소리) → 두뇌가 다시 말할 수 있음, unsure → 끊김으로 본다."""

    def test_member(self):
        self.assertEqual(barge_verdict("기헌", 0.82), "member")

    def test_other_only_when_clearly_far(self):
        self.assertEqual(barge_verdict(None, 0.2), "other")
        self.assertEqual(barge_verdict(None, speakers.OTHER_MAX - 0.01), "other")

    def test_unsure(self):
        self.assertEqual(barge_verdict(None, None), "unsure")  # 등록자 없음·너무 짧음
        self.assertEqual(barge_verdict(None, 0.6), "unsure")  # 임계(0.75) 아래지만 멀지도 않음 → 팀원을 남으로 잘못 볼 위험


if __name__ == "__main__":
    unittest.main()
