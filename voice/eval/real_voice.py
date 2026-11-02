"""실제 사람 목소리로 화자 구분·말 끝 판정을 잰다 (2026-10-29 멘토링 줌 녹화, 받아쓰기 없이 silero·resemblyzer만).

사용:
  ffmpeg -i "<회의 녹화>.mp4" -vn -ac 1 -ar 16000 voice/recordings/mentoring-full.wav
  voice/.venv/bin/python voice/eval/real_voice.py voice/recordings/mentoring-full.wav docs/mentoring/2026-10-29-멘토링-전사.md
  → voice/recordings/real_voice.json, 표는 화면에

정답: 전사의 [시각] 화자 줄부터 다음 [시각] 줄까지를 그 사람 구간으로 본다.
  시각 없는 다른 사람 줄(맞장구 등)이 끼어 있는 구간은 "섞임"으로 빼고, 경계 2초 안의 마디도 뺀다 (전사 시각은 초 단위·손 보정이라).
  전사엔 멘토·홍기헌 두 사람만 시각이 붙어 있다. 엄태은·김지호는 줌 테두리가 거의 안 켜져 따로 나뉘지 않았다.
시험 단위: 서버와 같은 Segmenter(말 끝 500ms)가 자른 마디 = final 하나.
"""

import json
import re
import statistics
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from segmenter import FRAME, SR, Segmenter  # noqa: E402
from speakers import MIN_SECONDS, Registry, embed  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "recordings" / "real_voice.json"
TTS_DIR = Path(__file__).resolve().parent.parent / "recordings" / "tts-compare"
THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]
MARGIN = 2.0  # 전사 경계에서 이만큼 안쪽 마디만
GAPS = (300, 800, 1500)
NAMES = {"멘토": "멘토", "홍기헌": "기헌"}


def sec(s: str) -> int:
    p = [int(x) for x in s.split(":")]
    return p[0] * 3600 + p[1] * 60 + p[2] if len(p) == 3 else p[0] * 60 + p[1]


def blocks(md: str, total: float) -> list[dict]:
    """[{who, t0, t1, mixed}] — 시각 붙은 줄마다 하나. 같은 사람이 이어지면 합친다."""
    stamped = re.compile(r"^\*\*(?:\[(\d+(?::\d+){1,2})\] ([^:*(]+?)|([^:*(\[]+?) \(이어서, (\d+(?::\d+){1,2})\)):\*\*")
    plain = re.compile(r"^\*\*([^\[:*(]+?):\*\*")
    out: list[dict] = []
    for line in md.splitlines():
        m = stamped.match(line)
        if m:
            t, who = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
            out.append({"who": who.strip(), "t0": sec(t), "mixed": False, "chars": len(line[m.end():].strip())})
        elif (m := plain.match(line)) and out and m.group(1).strip() != out[-1]["who"]:
            out[-1]["mixed"] = True  # 시각 없이 다른 사람이 끼어듦
    # 다음 줄과 시각이 같은 짧은 말(예: 37:52 기헌 → 37:52 멘토)은 글자 수로 길이를 어림(초당 7자)해 다음 사람 시작을 민다
    for a, b in zip(out, out[1:]):
        if b["t0"] <= a["t0"]:
            b["t0"] = a["t0"] + max(1, round(a["chars"] / 7))
    for a, b in zip(out, out[1:] + [{"t0": total}]):
        a["t1"] = b["t0"]
    merged: list[dict] = []
    for b in out:
        if b["t1"] <= b["t0"]:
            continue
        if merged and merged[-1]["who"] == b["who"] and merged[-1]["t1"] == b["t0"]:
            merged[-1]["t1"], merged[-1]["mixed"] = b["t1"], merged[-1]["mixed"] or b["mixed"]
        else:
            merged.append(dict(b))
    return merged


def segment(audio: np.ndarray, min_silence_ms: int) -> list[dict]:
    """서버와 같은 순서로 말 시작·끝·gap을 낸다. gap은 다음 speech_start가 오기 전까지 오디오 시계로."""
    seg, segs, gap = Segmenter(min_silence_ms), [], None
    for k in range(0, len(audio) - FRAME, FRAME):
        for ev in seg.feed(audio[k : k + FRAME]):
            if ev[0] == "start":
                if gap:
                    segs[-1]["next_start"] = ev[1]
                gap = None
            else:
                _, t0, t1, a = ev
                segs.append({"t0": t0, "t1": t1, "audio": a, "quiet_from": seg.quiet_from, "gaps": []})
                gap = segs[-1]
        if gap:
            for ms in GAPS:
                if ms not in gap["gaps"] and (seg.clock - gap["quiet_from"]) * 1000 >= ms:
                    gap["gaps"].append(ms)
    return segs


def label(s: dict, bl: list[dict]) -> tuple[str | None, str]:
    """(정답 화자 또는 None, 이유)."""
    hits = [b for b in bl if b["t0"] < s["t1"] and s["t0"] < b["t1"]]
    if len(hits) != 1:
        return None, "경계 걸침"
    b = hits[0]
    if b["who"] not in NAMES:
        return None, "다른 라벨"
    if b["mixed"]:
        return None, "섞인 구간"
    if s["t0"] < b["t0"] + MARGIN or s["t1"] > b["t1"] - MARGIN:
        return None, "경계 2초 안"
    return NAMES[b["who"]], ""


def score_table(enrolled: dict, tests: list[tuple]) -> dict:
    """tests: (정답, 지문[, 시각])"""
    rows = []
    for who, v, *t in tests:
        sims = {k: float(v @ e) for k, e in enrolled.items()}
        best = max(sims, key=sims.get)
        rows.append({"who": who, "best": best, "score": sims[best], "sims": sims, "t": t[0] if t else None})
    table = {}
    for th in THRESHOLDS:
        r = {"맞음": 0, "다른 사람으로": 0, "모름(등록자)": 0, "모름(미등록, 맞음)": 0, "미등록에 이름": 0}
        for x in rows:
            named = x["best"] if x["score"] >= th else None
            if x["who"] in enrolled:
                r["맞음" if named == x["who"] else "다른 사람으로" if named else "모름(등록자)"] += 1
            else:
                r["미등록에 이름" if named else "모름(미등록, 맞음)"] += 1
        table[th] = r
    per_who = {}
    for w in sorted({x["who"] for x in rows if x["who"] in enrolled}):
        xs = [x for x in rows if x["who"] == w]
        per_who[w] = {th: f"{sum(x['best'] == w and x['score'] >= th for x in xs)}/{len(xs)}" for th in THRESHOLDS}
    return {"n": len(rows), "table": table, "per_who": per_who, "rows": rows}


def tts_voices() -> list[tuple[str, np.ndarray]]:
    """등록 안 된 목소리 후보: 미티 목소리 샘플 (say·Supertonic·MMS). 미티 자기 목소리가 팀원으로 붙으면 안 된다."""
    out = []
    for p in sorted(TTS_DIR.glob("*-1.wav")) + sorted(TTS_DIR.glob("*-3.wav")):
        a, sr = sf.read(str(p), dtype="float32", always_2d=True)
        a = a[:, 0]
        if sr != SR:
            a = np.interp(np.arange(0, len(a), sr / SR), np.arange(len(a)), a).astype(np.float32)
        if (v := embed(a)) is not None:
            out.append((f"TTS:{p.stem}", v))
    return out


def main():
    wav, md = sys.argv[1], Path(sys.argv[2]).read_text()
    audio = sf.read(wav, dtype="float32")[0]
    total = len(audio) / SR
    bl = blocks(md, total)
    res: dict = {"blocks": [{k: v for k, v in b.items()} for b in bl]}
    print(f"녹음 {total / 60:.1f}분, 전사 구간 {len(bl)}개 (섞임 {sum(b['mixed'] for b in bl)})")

    # ── 2) 말 끝 판정·gap ─────────────────────────────────
    segs_by = {}
    for ms in (500, 250):
        segs = segment(audio, ms)
        segs_by[ms] = segs
        durs = [s["t1"] - s["t0"] for s in segs]
        g = {m: 0 for m in GAPS}
        mid = {m: 0 for m in GAPS}  # 같은 사람이 이어 말하기 전 잠깐 멈춘 곳에서 나간 gap
        turn = {m: 0 for m in GAPS}  # 화자가 바뀌는 곳
        for s in segs:
            nxt = s.get("next_start")
            a = [b for b in bl if b["t0"] <= s["t1"] < b["t1"]]
            same = nxt is not None and a and a[0]["t0"] <= nxt < a[0]["t1"] and a[0]["t1"] - nxt > MARGIN and nxt - a[0]["t0"] > MARGIN
            for m in s["gaps"]:
                g[m] += 1
                if same:
                    mid[m] += 1
                elif nxt is not None:
                    turn[m] += 1
        crosses = sum(1 for s in segs if any(s["t0"] + 0.3 < b["t0"] < s["t1"] - 0.3 for b in bl))
        r = {
            "마디": len(segs), "분당 speech_start": round(len(segs) / (total / 60), 1),
            "길이 중앙(초)": round(statistics.median(durs), 2), "0.5초 미만": sum(d < 0.5 for d in durs), "1초 미만": sum(d < 1 for d in durs),
            "gap 수": g, "같은 사람 말 중간 gap": mid, "화자 바뀜 gap": turn,
            "전사 경계를 넘는 마디(두 사람이 한 마디로)": crosses,
        }
        res[f"vad_{ms}"] = r
        print(f"\n## 말 끝 판정 {ms}ms: {json.dumps(r, ensure_ascii=False)}")

    # 1초 미만 마디(웃음·기침·맞장구 후보)를 사람이 들어 볼 수 있게 모은다: 마디 사이 0.6초 조용, 목록은 json에
    short = [s for s in segs_by[500] if s["t1"] - s["t0"] < 1.0]
    pack, gap_ = [], np.zeros(int(0.6 * SR), np.float32)
    for s in short:
        pack += [s["audio"], gap_]
    if pack:
        sf.write(str(OUT.with_name("real_voice_short.wav")), np.concatenate(pack), SR)
    res["short_segments"] = [{"t0": round(s["t0"], 2), "t1": round(s["t1"], 2)} for s in short]

    # ── 1) 화자 구분 ─────────────────────────────────────
    segs = segs_by[500]
    labelled = [(s, *label(s, bl)) for s in segs]
    why = {}
    for _, who, w in labelled:
        if who is None:
            why[w] = why.get(w, 0) + 1
    print(f"\n화자 정답이 있는 마디 {sum(1 for _, w, _ in labelled if w)}개 / 뺀 것 {why}")
    res["excluded"] = why
    for enroll_s in (5, 10):
        with tempfile.TemporaryDirectory() as d:
            reg = Registry(Path(d) / "speakers.json")
            used: set[int] = set()
            for name in NAMES.values():
                # 그 사람 구간의 첫 말소리부터 enroll_s초 모아 등록 (시험에서 뺀다)
                acc, got = [], 0.0
                for i, (s, who, _) in enumerate(labelled):
                    if who == name and got < enroll_s:
                        acc.append(s["audio"]), used.add(i)
                        got += (s["t1"] - s["t0"])
                reg.enroll(name, np.concatenate(acc)[: int(enroll_s * SR * 1.5)])
            tests, short = [], 0
            for i, (s, who, _) in enumerate(labelled):
                if who and i not in used:
                    v = embed(s["audio"])
                    if v is None:
                        short += 1
                    else:
                        tests.append((who, v, round(s["t0"], 1)))
            both = score_table(reg.voices, tests)
            # 미등록: 한 사람만 등록하고 다른 사람 마디 + 미티 목소리
            outsiders = tts_voices()
            loo = {}
            for keep in NAMES.values():
                only = {keep: reg.voices[keep]}
                loo[keep] = score_table(only, [t for t in tests if t[0] == keep] + [t for t in tests if t[0] != keep][:200])
            mitti = score_table(reg.voices, outsiders)
            sims_same = [x["sims"][x["who"]] for x in both["rows"]]
            sims_other = [s for x in both["rows"] for k, s in x["sims"].items() if k != x["who"]]
            dist = {"같은 사람 유사도 p10/중앙": [round(float(np.percentile(sims_same, 10)), 3), round(statistics.median(sims_same), 3)],
                    "다른 사람 유사도 중앙/p90": [round(statistics.median(sims_other), 3), round(float(np.percentile(sims_other, 90)), 3)]}
            per_who = {w: sum(1 for t in tests if t[0] == w) for w in NAMES.values()}
            print(f"\n## 등록 {enroll_s}초 — 시험 마디 {both['n']} {per_who} (1초 미만이라 화자 안 붙음 {short}) {dist}")
            for th, r in both["table"].items():
                print(f"- {th}: {r}")
            print("  사람별 맞음:", json.dumps(both["per_who"], ensure_ascii=False))
            wrong = [(x["t"], x["who"], x["best"], round(x["score"], 3)) for x in both["rows"] if x["best"] != x["who"]]
            print("  다른 사람으로 붙은 마디 (시각초, 정답, 붙은 이름, 유사도):", wrong)
            for keep, t in loo.items():
                print(f"  [{keep}만 등록] " + " ".join(f"{th}:{r['미등록에 이름']}/{r['미등록에 이름'] + r['모름(미등록, 맞음)']}" for th, r in t["table"].items()) + "  (다른 사람이 이 이름으로 붙은 수)")
            print("  [미티 목소리 " + str(mitti["n"]) + "개] " + " ".join(f"{th}:{r['미등록에 이름']}" for th, r in mitti["table"].items()) + f"  최고 유사도 {max(x['score'] for x in mitti['rows']):.3f}")
            res[f"enroll_{enroll_s}s"] = {
                "tests": per_who, "too_short": short, "dist": dist, "table": both["table"], "per_who": both["per_who"], "wrong": wrong,
                "leave_one_out": {k: v["table"] for k, v in loo.items()},
                "mitti_voices": {"table": mitti["table"], "max": round(max(x["score"] for x in mitti["rows"]), 3)},
            }
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str))
    print(f"\n→ {OUT}")


if __name__ == "__main__":
    main()
