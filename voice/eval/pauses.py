"""말 사이 쉼(사람이 생각하느라 잠깐 멈춤) vs 끝난 말 — 맞장구를 언제 끼워도 되나. 멘토링 녹화 71분.

사용: voice/.venv/bin/python voice/eval/pauses.py   (먼저 partial_stability.py sim으로 recordings/partial_sim/mentoring-full.events.jsonl)
  → voice/recordings/pauses.json, 표는 화면에
마디·final은 서버와 같은 규칙(말 끝 500ms)으로 흉내 낸 이벤트. 마디 i의 쉼 = 다음 speech_start - 조용해진 때(segmenter.quiet_from = t1 - 0.164).
gap 300/800/1500 이벤트는 쉼이 그만큼 넘을 때 나간다.
맞장구 규칙: gap g에서 (조건이 맞으면) 길이 D=0.6초 맞장구를 튼다. 그 사이(+0.2초)에 누가 말을 다시 시작하면 "말을 끊음".
신호: final 끝 글자(이음 꼴 "~고/~는데/~서/~면…" = 안 끝남, "~요/~다/~죠/~까" = 끝남), 마지막 0.4초 높낮이(오르면 물음·안 끝남).
같은 사람이 이어 말했나는 전사 블록(real_voice.blocks)으로 본다.
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
sys.path.insert(0, str(VOICE / "eval"))
from real_voice import blocks  # noqa: E402

EVENTS = VOICE / "recordings" / "partial_sim" / "mentoring-full.events.jsonl"
WAV = VOICE / "recordings" / "mentoring-full.wav"
MD = VOICE.parent / "docs" / "mentoring" / "2026-10-29-멘토링-전사.md"
OUT = VOICE / "recordings" / "pauses.json"
D = 0.6  # 맞장구 길이(초): 다듬은 BACKCHANNELS가 0.5~0.8초
SAFE = 0.2  # 맞장구 끝난 뒤 이만큼 안에 말이 시작돼도 겹친 것으로
QUIET_LAG = 0.164  # segmenter.quiet_from = t1 - pad(0.1) - 2프레임

CONT = re.compile(r"(고|는데|은데|던데|인데|서|니까|으니까|면|으면|지만|는지|거나|면서|다가|도록|려고|게|구|해서|하고|그리고|그래서|근데|그런데|이제|좀|그|막|약간|뭔가|이렇게|저|어|음)$")
FIN = re.compile(r"(요|다|죠|까|네|니다|래|자|지|야|어|아|군|걸)$")


def end_class(text: str) -> str:
    t = re.sub(r"[^\w\s?]", "", text).strip()
    if not t:
        return "빈"
    if t.endswith("?"):
        return "물음"
    w = t.split()[-1]
    if CONT.search(w):
        return "이음"
    if FIN.search(w):
        return "끝맺음"
    return "기타"


def end_pitch(a: np.ndarray, sr: int = 16000) -> float | None:
    """마지막 0.4초 높낮이 중앙 - 그 앞 0.4~1.2초 중앙 (반음). 오르면 +."""
    import librosa

    a = a[-int(1.2 * sr) :]
    f0, _, _ = librosa.pyin(a, fmin=70, fmax=400, sr=sr, frame_length=1024, hop_length=256)
    t = np.arange(len(f0)) * 256 / sr
    tail, head = f0[t >= t[-1] - 0.4], f0[t < t[-1] - 0.4]
    tail, head = tail[~np.isnan(tail)], head[~np.isnan(head)]
    if len(tail) < 3 or len(head) < 3:
        return None
    return round(float(12 * np.log2(np.median(tail) / np.median(head))), 1)


def main():
    ev = [json.loads(l) for l in EVENTS.read_text().splitlines()]
    starts = sorted(e["t"] for e in ev if e["type"] == "speech_start")
    finals = sorted((e for e in ev if e["type"] == "final"), key=lambda e: e["t1"])
    audio = sf.read(str(WAV), dtype="float32")[0]
    total = len(audio) / 16000
    bl = blocks(MD.read_text(), total)
    rows = []
    for f in finals:
        q = f["t1"] - QUIET_LAG
        nxt = next((s for s in starts if s > f["t1"] - 0.05), None)
        if nxt is None:
            continue
        pause = nxt - q
        b = next((b for b in bl if b["t0"] <= f["t1"] < b["t1"]), None)
        if b is None or f["t1"] - b["t0"] < 1:
            same = None
        elif b["t0"] <= nxt < b["t1"] - 0.5:
            same = True  # 같은 전사 블록 안에서 다시 말함 = 같은 사람이 이어 감
        elif nxt >= b["t1"]:
            same = False
        else:
            same = None
        a = audio[int(f["t0"] * 16000) : int(f["t1"] * 16000)]
        rows.append({"t1": round(f["t1"], 2), "len": round(f["t1"] - f["t0"], 2), "pause": round(pause, 3), "same": same,
                     "end": end_class(f["text"]), "pitch": end_pitch(a) if len(a) > 0.8 * 16000 else None, "tail": f["text"][-12:]})
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    report(rows)


def report(rows):
    n = len(rows)
    print(f"마디 {n}개 (같은 사람 이어 감 {sum(r['same'] is True for r in rows)}, 사람 바뀜 {sum(r['same'] is False for r in rows)}, 모름 {sum(r['same'] is None for r in rows)})")
    # 쉼 길이 분포: 같은 사람 이어 감 vs 바뀜
    for lab, sel in (("이어 감", True), ("바뀜", False)):
        ps = sorted(r["pause"] for r in rows if r["same"] is sel)
        if ps:
            print(f"  쉼 길이 {lab}: 중앙 {np.median(ps):.2f}초, 0.8초 넘음 {np.mean(np.array(ps) > 0.8):.0%}, 1.5초 넘음 {np.mean(np.array(ps) > 1.5):.0%}")
    print("\n끝 꼴별: 개수 · 같은 사람이 이어 간 비율(알려진 것 중) · 쉼 중앙")
    for c in ("이음", "끝맺음", "물음", "기타", "빈"):
        rs = [r for r in rows if r["end"] == c]
        known = [r for r in rs if r["same"] is not None]
        if rs:
            print(f"  {c}: {len(rs)} · {np.mean([r['same'] for r in known]) if known else float('nan'):.0%} · {np.median([r['pause'] for r in rs]):.2f}초")
    print("\n끝 높낮이별 (마지막 0.4초, 반음):")
    for lab, lo, hi in (("내림 ≤-2", -99, -2), ("평평", -2, 2), ("올림 ≥2", 2, 99)):
        rs = [r for r in rows if r["pitch"] is not None and lo <= r["pitch"] < hi]
        known = [r for r in rs if r["same"] is not None]
        if rs:
            print(f"  {lab}: {len(rs)} · 이어 감 {np.mean([r['same'] for r in known]) if known else float('nan'):.0%}")
    print(f"\n맞장구 규칙 (길이 {D}초, 끝난 뒤 {SAFE}초 안에 누가 말하면 끊음):")
    print("| 언제 | 조건 | 틀 때 (71분에) | 분당 | 사람 말을 끊음 | 같은 사람이 이어 가던 쉼에서 튼 비율 |")
    print("|---|---|---|---|---|---|")
    conds = {
        "모든 말": lambda r: True,
        "3초 넘는 말": lambda r: r["len"] >= 3,
        "끝이 이음 꼴": lambda r: r["end"] == "이음",
        "3초 넘고 끝이 끝맺음": lambda r: r["len"] >= 3 and r["end"] == "끝맺음",
        "3초 넘고 이음 아님·안 올림": lambda r: r["len"] >= 3 and r["end"] in ("끝맺음", "기타") and (r["pitch"] is None or r["pitch"] < 2),
    }
    out = {}
    for g in (0.3, 0.8, 1.5):
        for name, c in conds.items():
            fire = [r for r in rows if c(r) and r["pause"] >= g]
            cut = [r for r in fire if r["pause"] < g + D + SAFE]
            known = [r for r in fire if r["same"] is not None]
            cont = np.mean([r["same"] for r in known]) if known else float("nan")
            out[f"{int(g * 1000)}/{name}"] = {"fire": len(fire), "cut": len(cut)}
            print(f"| gap {int(g * 1000)} | {name} | {len(fire)} | {len(fire) / 70.7:.1f} | **{len(cut) / max(len(fire), 1):.1%}** ({len(cut)}) | {cont:.0%} |")
    return out


if __name__ == "__main__":
    main()
