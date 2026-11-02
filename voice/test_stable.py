"""partial.stable — 바로 앞 partial과 같은 앞 글자 수 (server.stable_chars)."""

import unittest

from server import stable_chars


class Stable(unittest.TestCase):
    def test_first_partial_is_zero(self):
        self.assertEqual(stable_chars(None, "오늘 안건"), 0)
        self.assertEqual(stable_chars("", "오늘 안건"), 0)

    def test_grows_when_prefix_same(self):
        a = "오늘 안건 3개"
        b = "오늘 안건 3개, 시연 영상 구성"
        n = stable_chars(a, b)
        self.assertEqual(b[:n], "오늘 안건 3개")
        c = "오늘 안건 3개, 시연 영상 구성, 디스코드"
        self.assertGreater(stable_chars(b, c), n)
        self.assertEqual(c[: stable_chars(b, c)], "오늘 안건 3개, 시연 영상 구성")

    def test_shrinks_to_common_prefix_when_rewritten(self):
        prev = "영상은 회의안은"
        text = "영상은 회의하는 장면 먼저"
        self.assertEqual(text[: stable_chars(prev, text)], "영상은 회의")

    def test_ignores_spacing_and_punctuation(self):
        # "시연영" → "시연 영상": 띄어쓰기만 바뀐 글자는 안정
        text = "오늘 안건 3개, 시연 영상"
        self.assertEqual(text[: stable_chars("오늘 안건 3개 시연영", text)], "오늘 안건 3개, 시연 영")

    def test_nothing_common(self):
        self.assertEqual(stable_chars("영세", "영상은"), 1)
        self.assertEqual(stable_chars("네네", "그래서"), 0)

    def test_prefix_never_longer_than_text(self):
        self.assertEqual(stable_chars("오늘 안건 3개, 시연", "오늘 안건"), len("오늘 안건"))


if __name__ == "__main__":
    unittest.main()
