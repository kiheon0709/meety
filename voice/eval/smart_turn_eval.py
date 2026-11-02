"""Smart Turn v3.2를 붙이면 말 끝 → final이 얼마나 빨라지고, 한 사람 말이 중간에 잘리는 일이 얼마나 느나 (지금: 말 끝 500ms 조용하면 끊음).

사용: voice/.venv/bin/python voice/eval/smart_turn_eval.py [A|real]
  A    : 시나리오 A·B·wake·speakers-test (대본 46마디, 말 경계 정답이 정확). 마디 안 쉼(쉼표 등)에서 끊기면 "중간에 잘림"
  real : 멘토링 녹화 71분. 정답 경계가 없어 끊긴 조각을 받아써 끝 꼴(이음 꼴 "~고/~는데…"면 문장 중간)로 어림
방식: silero 말 끝 기준을 200ms로 두고, 쉼이 200ms가 될 때마다 Smart Turn 확률(쉼 0.2초 포함 최근 8초)을 낸다.
  확률 ≥ θ면 그때(쉼 0.2초) final, 아니면 쉼이 F초가 될 때까지 기다렸다 final(F=0.5면 지금보다 늦어지는 일은 없다).
"""

import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
sys.path.insert(0, str(VOICE / "eval"))
import smart_turn  # noqa: E402
from pauses import end_class  # noqa: E402
from segmenter import FRAME, SR, Segmenter  # noqa: E402

OUT = VOICE / "recordings" / "smart_turn_eval.json"
THETAS = [0.5, 0.7, 0.85]
FALLBACK = [0.5, 0.8, 1.2]
QUIET_LAG = 0.1 + 2 * FRAME / SR  # segmenter.quiet_from = end - pad - 2프레임


def chunks(audio: np.ndarray) -> list[dict]:
    """silero 200ms로 자른 조각. 조각 끝마다 Smart Turn 확률 (조용해진 때 + 0.2초까지의 소리)."""
    seg, out, infer = Segmenter(200), [], []
    for k in range(0, len(audio) - FRAME, FRAME):
        for ev in seg.feed(audio[k : k + FRAME]):
            if ev[0] == "end":
                q = seg.quiet_from
                t = time.monotonic()
                p = smart_turn.prob(audio[: int((q + 0.2) * SR)])
                infer.append((time.monotonic() - t) * 1000)
                out.append({"t0": ev[1], "t1": ev[2], "q": q, "p": round(p, 3), "audio": ev[3]})
    for a, b in zip(out, out[1:]):
        a["pause"] = b["t0"] - a["q"]
    if out:
        out[-1]["pause"] = 99.0
    print(f"  조각 {len(out)}개, Smart Turn 한 번 {np.median(infer):.0f}ms (p90 {np.percentile(infer, 90):.0f})", flush=True)
    return out


def decide(cs: list[dict], theta: float | None, fb: float) -> list[tuple[int, float]]:
    """(끊은 조각 번호, 조용해진 뒤 몇 초에 final을 냈나). theta None = 지금 방식(쉼 fb에서만)."""
    out = []
    for i, c in enumerate(cs):
        if theta is not None and c["p"] >= theta:
            out.append((i, 0.2))
        elif c["pause"] >= fb:
            out.append((i, fb))
    return out


def run_scripted():
    from replay import cer  # noqa: F401  (경로 확인용)

    names = ["A-meeting", "B-presentation", "wake", "speakers-test"]
    rows = []
    for n in names:
        a = sf.read(str(VOICE / "recordings" / f"{n}.wav"), dtype="float32")[0]
        a = np.concatenate([a, np.zeros(2 * SR, np.float32)])
        turns = json.loads((VOICE / "recordings" / f"{n}.turns.json").read_text())
        for c in chunks(a):
            # 이 조각 끝이 어느 마디의 끝인가: 끝이 마디 끝 0.35초 안이면 마디 끝, 마디 한가운데면 중간
            u = next((u for u in turns if u["t0"] - 0.2 <= c["q"] <= u["t1"] + 0.35), None)
            c["kind"] = "끝" if u and c["q"] >= u["t1"] - 0.35 else ("중간" if u else "?")
            c["late_from_true"] = (c["q"] - u["t1"]) if u and c["kind"] == "끝" else None
            rows.append(c)
    report(rows, lambda c: c["kind"] == "중간", "마디 중간에서 끊음", total_min=sum(sf.info(str(VOICE / "recordings" / f"{n}.wav")).duration for n in names) / 60)
    return rows


def run_real():
    from segmenter import transcribe
    from server import hint

    a = sf.read(str(VOICE / "recordings" / "mentoring-full.wav"), dtype="float32")[0]
    a = np.concatenate([a, np.zeros(2 * SR, np.float32)])
    cs = chunks(a)
    transcribe(np.zeros(SR, np.float32))
    t = time.monotonic()
    for i, c in enumerate(cs):
        c["text"] = transcribe(c["audio"], hint("기헌, 태은, 지호"))
        c["end"] = end_class(c["text"])
        if i % 200 == 0:
            print(f"  받아쓰기 {i}/{len(cs)} ({(time.monotonic() - t) / 60:.1f}분)", flush=True)
    report(cs, lambda c: c["end"] == "이음", "문장 중간(이음 꼴)에서 끊음", total_min=len(a) / SR / 60)
    return cs


def report(cs, is_mid, mid_label, total_min):
    print(f"\n| 방식 | final 수 (분당) | 조용해진 뒤 final까지 중앙 | 0.2초에 낸 비율 | {mid_label} |")
    print("|---|---|---|---|---|")
    res = {}
    for theta in [None] + THETAS:
        for fb in FALLBACK if theta is not None else [0.5]:
            d = decide(cs, theta, fb)
            mids = sum(is_mid(cs[i]) for i, _ in d)
            lat = [w for _, w in d]
            name = "지금 (500ms)" if theta is None else f"Smart Turn θ={theta}, 아니면 {int(fb * 1000)}ms"
            res[name] = {"n": len(d), "mid": mids, "lat": float(np.median(lat)), "fast": float(np.mean([w == 0.2 for w in lat]))}
            print(f"| {name} | {len(d)} ({len(d) / total_min:.1f}) | {np.median(lat) * 1000:.0f}ms | {np.mean([w == 0.2 for w in lat]):.0%} | {mids} ({mids / max(len(d), 1):.1%}) |")
    ps = [c["p"] for c in cs]
    mid_p = [c["p"] for c in cs if is_mid(c)]
    print(f"\n확률 분포: 전체 중앙 {np.median(ps):.2f}, 중간 조각 중앙 {np.median(mid_p) if mid_p else float('nan'):.2f}")
    return res


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "A"
    rows = run_scripted() if which == "A" else run_real()
    data = json.loads(OUT.read_text()) if OUT.exists() else {}
    data[which] = [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in c.items() if k != "audio"} for c in rows]
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
