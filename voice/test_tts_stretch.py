"""tts_stretch: 조각으로 나눠 넣어도 한 번에 넣은 것과 같은지(이음새 없음), 길이가 1/빠르기인지."""

import unittest

import numpy as np

from tts_stretch import Stretch


def run(x, sizes, tempo=1.2):
    st, out, i = Stretch(tempo), [], 0
    for n in sizes:
        out.append(st.feed(x[i : i + n]))
        i += n
    out.append(st.feed(x[i:], final=True))
    return np.concatenate(out)


class StretchTest(unittest.TestCase):
    def test_chunks_equal_whole(self):
        rng = np.random.default_rng(0)
        t = np.arange(24000 * 3) / 24000
        x = (0.3 * np.sin(2 * np.pi * 180 * t * (1 + 0.1 * np.sin(t))) + 0.02 * rng.normal(size=len(t))).astype(np.float32)
        whole = run(x, [])
        for sizes in ([7680] * 9, [100, 7000, 3, 9000, 24000], list(rng.integers(1, 5000, 30))):
            np.testing.assert_array_equal(run(x, sizes), whole)
        self.assertEqual(len(whole), round(len(x) / 1.2))

    def test_continuous_and_level(self):
        t = np.arange(24000 * 2) / 24000
        x = (0.5 * np.sin(2 * np.pi * 200 * t)).astype(np.float32)
        mid = run(x, [7680] * 6)[2400:-2400]
        self.assertAlmostEqual(float(np.sqrt(np.mean(mid**2))), 0.5 / np.sqrt(2), delta=0.03)  # 크기 그대로
        self.assertLess(float(np.abs(np.diff(mid)).max()), 0.05)  # 튀는 곳 없음 (200Hz 사인 한 샘플 차이 최대 0.026)


if __name__ == "__main__":
    unittest.main()
