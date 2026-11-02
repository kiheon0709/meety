"""말 시작 뒤 짧은 소리(0.3~2초)로 화자를 가를 수 있나 — barge_in에 화자를 붙일지(2단계 끊기) 정하려고 잰다.

사용: voice/.venv/bin/python voice/eval/barge_speaker.py voice/recordings/mentoring-full.wav docs/mentoring/2026-10-29-멘토링-전사.md
  → voice/recordings/barge_speaker.json, 표는 화면에

real_voice.py와 같은 정답(전사 구간)·같은 등록(사람마다 첫 10초)을 쓴다. 시험: 2.2초 이상인 마디의 앞 L초.
지문 두 가지:
  gate — 지금 서버(speakers.embed): 조용한 곳을 뺀 뒤 1초 미만이면 None
  raw  — 조용한 곳을 빼지 않고 크기만 맞춰 바로 지문 (짧은 소리용으로 우회하면 어떤가)
판단 두 가지:
  이름 — 등록자 둘 다 등록, 임계 0.75로 이름 붙이기 (barge_in.speaker)
  놓아줌 — 한 사람만 등록하고 다른 사람을 "모르는 목소리"로: 최고 유사도 < r 이면 release.
           등록자를 놓아줌(팀원 말 위로 미티가 계속 말함)이 가장 나쁜 실수.
"""

import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import soundfile as sf  # noqa: E402
from real_voice import NAMES, blocks, label, segment  # noqa: E402
from resemblyzer.audio import normalize_volume  # noqa: E402
from segmenter import SR  # noqa: E402
from speakers import Registry, _encoder, embed  # noqa: E402
from fake_meeting import trim  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "recordings" / "barge_speaker.json"
LENS = [0.3, 0.5, 0.75, 1.0, 1.5, 2.0]
NAME_TH = 0.75
RELEASE = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7]


def raw_embed(a: np.ndarray) -> np.ndarray | None:
    if not np.any(a):
        return None
    return _encoder().embed_utterance(normalize_volume(a, -30, increase_only=True))


def main():
    audio = sf.read(sys.argv[1], dtype="float32")[0]
    bl = blocks(Path(sys.argv[2]).read_text(), len(audio) / SR)
    labelled = [(s, *label(s, bl)) for s in segment(audio, 500)]
    reg = Registry(Path(tempfile.mkdtemp()) / "speakers.json")
    used: set[int] = set()
    for name in NAMES.values():  # real_voice.py와 같은 10초 등록
        acc, got = [], 0.0
        for i, (s, who, _) in enumerate(labelled):
            if who == name and got < 10:
                acc.append(s["audio"]), used.add(i)
                got += s["t1"] - s["t0"]
        reg.enroll(name, np.concatenate(acc)[: int(10 * SR * 1.5)])
    tests = [(who, s["audio"]) for i, (s, who, _) in enumerate(labelled) if who and i not in used and s["t1"] - s["t0"] >= 2.2]
    outs = [a for _, a in tts_outsider_audio()]
    print(f"시험 마디 {len(tests)}개 {dict((w, sum(t[0] == w for t in tests)) for w in NAMES.values())}, 미티 목소리 {len(outs)}개")
    res = {"n": len(tests), "lens": {}}
    for L in LENS:
        n = int(L * SR)
        for kind, f in (("gate", embed), ("raw", raw_embed)):
            t = time.perf_counter()
            vs = [(who, f(a[:n])) for who, a in tests]
            ms = (time.perf_counter() - t) * 1000 / len(tests)
            none = sum(v is None for _, v in vs)
            vs = [(w, v) for w, v in vs if v is not None]
            r = {"지문 없음": none, "지문 ms": round(ms, 1)}
            if vs:
                # 이름 붙이기 (둘 다 등록)
                ok = wrong = unk = 0
                for who, v in vs:
                    sims = {k: float(v @ e) for k, e in reg.voices.items()}
                    best = max(sims, key=sims.get)
                    if sims[best] < NAME_TH:
                        unk += 1
                    elif best == who:
                        ok += 1
                    else:
                        wrong += 1
                r["이름(0.75) 맞음/틀림/모름"] = [ok, wrong, unk]
                # 놓아줌: 한 사람만 등록 → 그 사람 마디는 팀원, 다른 사람 마디는 모르는 목소리
                same, other = [], []
                for keep, e in reg.voices.items():
                    for who, v in vs:
                        (same if who == keep else other).append(float(v @ e))
                tts = [float(v @ e) for a in outs for e in reg.voices.values() if (v := f(a[:n])) is not None]
                r["유사도 중앙 팀원/모르는 사람/미티"] = [round(statistics.median(x), 3) if x else None for x in (same, other, tts)]
                r["놓아줌 r: 팀원 잘못 놓음 / 모르는 사람 놓음 / 미티 놓음"] = {
                    rr: [f"{sum(x < rr for x in same)}/{len(same)}", f"{sum(x < rr for x in other)}/{len(other)}", f"{sum(x < rr for x in tts)}/{len(tts)}"]
                    for rr in RELEASE}
            res["lens"][f"{L}_{kind}"] = r
            print(f"{L:4}s {kind:4} {json.dumps(r, ensure_ascii=False)}", flush=True)
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1))


def tts_outsider_audio():
    """real_voice.tts_voices와 같은 파일(미티 목소리 샘플)의 소리 그대로."""
    d = Path(__file__).resolve().parent.parent / "recordings" / "tts-compare"
    out = []
    for p in sorted(d.glob("*-1.wav")) + sorted(d.glob("*-3.wav")):
        a, sr = sf.read(str(p), dtype="float32", always_2d=True)
        a = a[:, 0]
        if sr != SR:
            a = np.interp(np.arange(0, len(a), sr / SR), np.arange(len(a)), a).astype(np.float32)
        out.append((p.stem, trim(a)))  # 말 시작부터 (barge는 VAD start에서 잰다)
    return out


if __name__ == "__main__":
    main()
