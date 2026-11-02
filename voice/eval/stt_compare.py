"""받아쓰기 둘(whisper·Soniox)을 같은 재생 이벤트로 비교: 말 끝→final, 글자 오류율, 안정 글자가 말 끝 몇 초 전에 생기나.

사용: voice/.venv/bin/python voice/eval/stt_compare.py 이름 …   (voice/recordings/stable/{이름}.{whisper|soniox}.events.jsonl, {이름}.turns.json)
replay.py로 같은 wav를 MEETY_STT=whisper·soniox 서버에 1배속으로 흘린 기록을 쓴다. 정답은 turns.json(대본·시각).
"""

import json
import statistics
import sys
from pathlib import Path

import numpy as np

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
sys.path.insert(0, str(VOICE / "eval"))
from partial_stability import norm  # noqa: E402
from replay import cer  # noqa: E402

D = VOICE / "recordings" / "stable"


def measure(name: str, stt: str) -> dict:
    ev = [json.loads(l) for l in (D / f"{name}.{stt}.events.jsonl").read_text().splitlines()]
    turns = json.loads((D / f"{name}.turns.json").read_text())
    finals = {e["id"]: e for e in ev if e["type"] == "final" and e.get("text")}
    ends = {e["id"]: e for e in ev if e["type"] == "speech_end"}
    partials = [e for e in ev if e["type"] == "partial"]
    lat, asr, lead_any, lead_half = [], [], [], []
    for u in turns:
        ids = sorted(i for i, f in finals.items() if f["t0"] < u["t1"] and f["t1"] > u["t0"] + 0.1)
        if not ids:
            continue
        f = finals[ids[-1]]
        lat.append((f["audio"] - u["t1"]) * 1000)
        if ids[-1] in ends:
            asr.append((f["recv"] - ends[ids[-1]]["recv"]) * 1000)
        # 안정 글자: 그 말의 partial 중 stable>0이 처음 온 때, 그리고 final 글자의 절반 넘게 안정된 때 (말 끝 기준 초, 음수 = 말 끝 전)
        n = len(norm(" ".join(finals[i]["text"] for i in ids)))
        ps = [p for p in partials if p["id"] in ids]
        a = next((p["audio"] for p in ps if p.get("stable", 0) > 0), None)
        h = next((p["audio"] for p in ps if len(norm(p["text"][: p.get("stable", 0)])) >= n / 2), None)
        lead_any.append(None if a is None else a - u["t1"])
        lead_half.append(None if h is None else h - u["t1"])
    ref = " ".join(u["text"] for u in turns)
    # 정답 말(turns)과 겹친 final만 — 녹음에 정답이 없는 소리(미티 목소리 등)가 섞여 있어도 그 글자는 세지 않는다
    hyp = " ".join(finals[i]["text"] for i in sorted(finals) if any(finals[i]["t0"] < u["t1"] and finals[i]["t1"] > u["t0"] + 0.1 for u in turns))
    pct = lambda xs, q: round(float(np.percentile(xs, q))) if xs else None  # noqa: E731
    got_any = [x for x in lead_any if x is not None]
    got_half = [x for x in lead_half if x is not None]
    return {
        "말": len(lat), "말 끝→final 중앙/p90 ms": [pct(lat, 50), pct(lat, 90)], "speech_end→final 중앙 ms": pct(asr, 50),
        "CER": round(cer(ref, hyp), 4), "partial 수": len(partials),
        "안정 글자 처음: 말 끝 전인 비율": f"{sum(x < 0 for x in got_any)}/{len(lead_any)}",
        "안정 글자 처음 (말 끝 기준 초) 중앙": round(statistics.median(got_any), 2) if got_any else None,
        "글자 절반 안정 (말 끝 기준 초) 중앙": round(statistics.median(got_half), 2) if got_half else None,
        "절반 안정이 말 끝 전인 비율": f"{sum(x < 0 for x in got_half)}/{len(lead_half)}",
    }


if __name__ == "__main__":
    out = {}
    for n in sys.argv[1:]:
        for stt in ("whisper", "soniox"):
            out[f"{n}/{stt}"] = m = measure(n, stt)
            print(n, stt, json.dumps(m, ensure_ascii=False))
    (D / "stt_compare.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
