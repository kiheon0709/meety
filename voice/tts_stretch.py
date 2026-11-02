"""말 빠르기만 바꾸기(높낮이 그대로) — 조각으로 흘려받으면서 (WSOLA, ffmpeg atempo와 같은 갈래: 1024샘플 Hann 창, 반씩 겹침).

11/1 기헌이 고른 목소리(후보 6)가 Sohee 1.2배다. 샘플은 ffmpeg atempo로 만들었지만 앱에서는 못 쓴다:
ffmpeg는 파이프 입력을 0.17초씩 붙잡아서(anull로도 같음) 첫 조각의 대부분이 다음 조각이 올 때까지 안 나온다 → 문장 첫머리가 끊긴다.
여기서는 문장 하나 동안 상태(남은 입력·겹치는 꼬리)를 들고 있어서, 조각을 어떻게 나눠 넣어도 한 번에 넣은 것과 샘플 하나까지 같다
(이음새가 따로 없다, test_tts_stretch.py). 조각마다 끝 근처 1536샘플(64ms)만 다음 조각을 기다린다.
찾는 폭 tol: 256이면 "두 안을"이 "두 환을"로 받아써졌고 512면 atempo와 같았다(c6 세 문장, whisper).
"""

import numpy as np


class Stretch:
    def __init__(self, tempo: float, n: int = 1024, tol: int = 512):
        self.tempo, self.n, self.hs, self.tol = tempo, n, n // 2, tol
        self.win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float32)  # 반씩 겹치면 합이 1
        self.inp = np.zeros(0, np.float32)
        self.off = 0  # inp[0]의 절대 위치
        self.out = np.zeros(0, np.float32)  # 아직 안 내보낸 출력(겹쳐 더하는 중)
        self.done = 0  # 내보낸 출력 샘플 수
        self.j = 0  # 다음 창 번호
        self.prev: int | None = None  # 앞 창을 가져온 입력 위치
        self.total = 0

    def _get(self, start: int, length: int) -> np.ndarray:
        s = self.inp[start - self.off : start - self.off + length]
        return s if len(s) == length else np.pad(s, (0, length - len(s)))

    def feed(self, x: np.ndarray, final: bool = False) -> np.ndarray:
        """입력 조각을 넣고 확정된 출력을 돌려준다. final이면 남은 것을 다 내보낸다(문장 끝)."""
        self.inp = np.concatenate([self.inp, np.asarray(x, np.float32)])
        self.total += len(x)
        got = []
        while True:
            a = round(self.j * self.hs * self.tempo)  # 이 창이 원래 가져올 입력 위치
            if a + self.tol + self.n > self.total and not (final and self.j * self.hs < round(self.total / self.tempo)):
                break
            if self.prev is None:
                start = a
            else:
                # 앞 창에 자연스럽게 이어지는 소리(prev+hs)와 가장 닮은 곳을 a±tol에서 고른다
                lo = max(self.off, a - self.tol)
                seg = self._get(lo, self.n + a + self.tol - lo)
                start = lo + int(np.argmax(np.correlate(seg, self._get(self.prev + self.hs, self.n), "valid")))
            pos = self.j * self.hs - self.done
            if len(self.out) < pos + self.n:
                self.out = np.pad(self.out, (0, pos + self.n - len(self.out)))
            self.out[pos : pos + self.n] += self._get(start, self.n) * self.win
            self.prev, self.j = start, self.j + 1
            ready = self.j * self.hs - self.done  # 다음 창이 여기서 시작하니 그 앞은 확정
            got.append(self.out[:ready])
            self.out, self.done = self.out[ready:], self.done + ready
            drop = min(self.prev + self.hs, round(self.j * self.hs * self.tempo) - self.tol) - self.off
            if drop > 0:
                self.inp, self.off = self.inp[drop:], self.off + drop
        y = np.concatenate(got) if got else np.zeros(0, np.float32)
        if final:  # 길이를 입력/빠르기에 맞춘다 (마지막 창이 반 창만큼 넘칠 수 있다)
            want = round(self.total / self.tempo) - self.done
            y = y[: len(y) + want] if want < 0 else np.concatenate([y, np.pad(self.out, (0, max(0, want - len(self.out))))[:want]])
            self.done, self.out = round(self.total / self.tempo), np.zeros(0, np.float32)
        return y
