"""partial(말하는 중 받아쓰기)이 얼마나 흔들리나. S3 "말 끝나기 전에 partial로 미리 판단하고 틀리면 지우기"용.

사용:
  voice/.venv/bin/python voice/eval/partial_stability.py sim 입력.wav     # 서버 partial 규칙을 흉내 내 이벤트를 만든다 → recordings/partial_sim/입력.events.jsonl
  voice/.venv/bin/python voice/eval/partial_stability.py stats a.events.jsonl [b.events.jsonl …]   # 잰다 (replay.py가 남긴 실제 서버 이벤트도 된다)

sim: 서버(server.py)와 같은 조건으로 partial을 낸다 — 말 0.6초 넘음 · 앞 partial 끝남 · final 받아쓰는 중 아님 · 말이 멎는 중 아님 ·
  앞 partial 시작에서 0.8초 지남. GPU는 하나라 받아쓰기는 줄을 선다: 받아쓰기에 실제로 걸린 시간만큼 오디오 시계를 밀어 그 사이에 온
  partial·final을 늦춘다 (실시간으로 흘려 넣는 것과 같다). partial은 힌트 없이, final은 hint(참석자)로.
stats 규칙: "최근 N개 partial의 공통 앞부분"을 안정으로 본다 (N=1은 받는 대로 믿기). 한 번 안정이라 한 글자는 되돌리지 않는다고 보고
  그게 final 앞부분과 다르면 "뒤에 바뀜". 글자는 띄어쓰기·문장부호를 빼고 센다. 낱말 단위(W)는 띄어쓰기로 나눈 낱말이 N개에서 같아야 안정.
"""

import json
import re
import statistics
import sys
import time
from pathlib import Path

import numpy as np

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))

PARTIAL_EVERY, PARTIAL_MIN = 0.8, 0.6  # server.py와 같게
OUT_DIR = VOICE / "recordings" / "partial_sim"


def norm(s: str) -> str:
    return re.sub(r"[\s\W]", "", s)


def words(s: str) -> list[str]:
    return [w for w in (re.sub(r"[^\w]", "", x) for x in s.split()) if w]


def edit(a: str, b: str) -> int:
    d = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, y in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (x != y))
    return d[len(b)]


def lcp(a, b) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


# ── sim ─────────────────────────────────────────────────


def sim(wav: str, names: str) -> Path:
    import soundfile as sf

    from segmenter import FRAME, SR, Segmenter, transcribe
    from server import MIN_SILENCE_MS, hint

    audio = sf.read(wav, dtype="float32")[0]
    audio = np.concatenate([audio, np.zeros(2 * SR, np.float32)])
    transcribe(np.zeros(SR, np.float32))
    seg, events = Segmenter(MIN_SILENCE_MS), []
    gpu_free = 0.0  # 오디오 시계로 GPU가 비는 때
    final_done = 0.0
    partial_done = 0.0
    last_partial = -1e9
    seg_id, finals = 0, {}  # finals: id → final 낸 때

    def run(a, prompt, clock):
        nonlocal gpu_free
        start = max(clock, gpu_free)
        t = time.monotonic()
        text = transcribe(a, prompt)
        gpu_free = start + (time.monotonic() - t)
        return text, gpu_free

    t_wall = time.monotonic()
    for k in range(0, len(audio) - FRAME, FRAME):
        for ev in seg.feed(audio[k : k + FRAME]):
            if ev[0] == "start":
                seg_id += 1
                events.append({"type": "speech_start", "id": seg_id, "t": round(ev[1], 2), "audio": round(seg.clock, 3)})
            else:
                _, t0, t1, a = ev
                text, done = run(a, hint(names), seg.clock)
                final_done = done
                finals[seg_id] = done
                events.append({"type": "final", "id": seg_id, "t0": round(t0, 2), "t1": round(t1, 2), "text": text, "audio": round(done, 3)})
        cur = seg.current_audio()
        c = seg.clock
        if len(cur) > SR * PARTIAL_MIN and c >= partial_done and c >= final_done and not seg.quieting and c - last_partial > PARTIAL_EVERY:
            last_partial = c
            text, partial_done = run(cur, None, c)
            if text and seg_id not in finals:
                events.append({"type": "partial", "id": seg_id, "text": text, "audio": round(partial_done, 3)})
        if k % (SR * 60) < FRAME:
            print(f"  {c / 60:.0f}분 (걸린 시간 {(time.monotonic() - t_wall) / 60:.1f}분)", flush=True)
    events.sort(key=lambda e: e["audio"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / (Path(wav).stem + ".events.jsonl")
    out.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events))
    print(f"→ {out}")
    return out


# ── stats ───────────────────────────────────────────────


def utterances(paths: list[str]) -> list[dict]:
    out = []
    for p in paths:
        by: dict[int, dict] = {}
        for l in Path(p).read_text().splitlines():
            e = json.loads(l)
            if e["type"] == "speech_start":
                by.setdefault(e["id"], {"partials": []})["start"] = e["audio"]
            elif e["type"] == "partial":
                by.setdefault(e["id"], {"partials": []})["partials"].append((e["audio"], e["text"]))
            elif e["type"] == "final":
                u = by.setdefault(e["id"], {"partials": []})
                u["final"], u["final_at"], u["len"] = e["text"], e["audio"], e["t1"] - e["t0"]
        out += [u for u in by.values() if "final" in u and "start" in u and norm(u["final"])]
    return out


def pct(xs, p):
    return round(float(np.percentile(xs, p))) if xs else None


def rule(utts: list[dict], n: int, unit: str) -> dict:
    """최근 n개 partial의 공통 앞부분을 안정으로. 한 번 안정이 된 글자는 그대로(되돌리기 = 틀림)."""
    bad_utts, n_utts, chars_ok, chars_bad, final_chars, dist = 0, 0, 0, 0, 0, 0
    lead, wait = [], []  # 안정된 글자마다: final보다 몇 ms 먼저 / 처음 보인 뒤 몇 ms 만에 안정
    for u in utts:
        f = norm(u["final"])
        final_chars += len(f)
        ps = u["partials"]
        if not ps:
            continue
        n_utts += 1
        seen: dict[int, float] = {}  # 글자 위치 → 처음 그 글자까지 맞게 보인 때
        committed, t_commit = "", []
        for j, (t, _) in enumerate(ps):
            for k in range(1, lcp(norm(ps[j][1]), f) + 1):
                seen.setdefault(k, t)
            if j + 1 < n:
                continue
            recent = [p for _, p in ps[j - n + 1 : j + 1]]
            if unit == "char":
                xs = [norm(p) for p in recent]
                s = xs[0][: min(lcp(xs[0], x) for x in xs)]
            else:
                ws = [words(p) for p in recent]
                m = min(lcp(ws[0], w) for w in ws)
                # 낱말 단위: 가장 최근 partial의 마지막 낱말은 덜 들린 것일 수 있어 안정에 안 넣는다
                m = min(m, len(ws[-1]) - 1)
                s = "".join(ws[0][:m])
            if len(s) > len(committed) and s.startswith(committed):
                t_commit += [t] * (len(s) - len(committed))
                committed = s
        ok = lcp(committed, f)
        chars_ok += ok
        chars_bad += len(committed) - ok
        bad_utts += ok < len(committed)
        # 글자 하나만 달라도 뒤가 다 "틀림"이 되는 앞부분 비교 대신, final 앞부분과 편집 거리 (final이 "좀·이제·네네" 같은 군말을 빼는 일이 많다)
        if committed:
            dist += min(edit(committed, f[:L]) for L in range(max(0, len(committed) - 8), len(committed) + 9))
        for k in range(ok):
            lead.append((u["final_at"] - t_commit[k]) * 1000)
            if k + 1 in seen:
                wait.append((t_commit[k] - seen[k + 1]) * 1000)
    total = chars_ok + chars_bad
    return {
        "뒤에 바뀐 말(%)": round(100 * bad_utts / max(n_utts, 1), 1),
        "안정 글자 중 틀린(%)": round(100 * chars_bad / max(total, 1), 1),
        "안정 글자의 편집 거리(%)": round(100 * dist / max(total, 1), 1),
        "final 글자 중 미리 안정(%)": round(100 * chars_ok / max(final_chars, 1), 1),
        "final보다 먼저(ms) 중앙": pct(lead, 50),
        "처음 보인 뒤 안정까지(ms) 중앙/p90": [pct(wait, 50), pct(wait, 90)],
    }


def stats(paths: list[str]) -> dict:
    utts = utterances(paths)
    first, gaps, changed, rewritten, pairs, per = [], [], 0, [], 0, []
    for u in utts:
        ps = u["partials"]
        per.append(len(ps))
        if ps:
            first.append((ps[0][0] - u["start"]) * 1000)
        for (ta, a), (tb, b) in zip(ps, ps[1:]):
            gaps.append((tb - ta) * 1000)
            pairs += 1
            na, nb = norm(a), norm(b)
            if not nb.startswith(na):
                changed += 1
                rewritten.append(len(na) - lcp(na, nb))
    has = [u for u in utts if u["partials"]]
    r = {
        "말": len(utts),
        "partial 받은 말": f"{len(has)} ({100 * len(has) // max(len(utts), 1)}%)",
        "2초 넘는 말 중 partial 받은": f"{sum(1 for u in has if u['len'] > 2)}/{sum(1 for u in utts if u['len'] > 2)}",
        "말당 partial 중앙": statistics.median(per) if per else 0,
        "말 시작→첫 partial(ms) 중앙/p90": [pct(first, 50), pct(first, 90)],
        "partial 간격(ms) 중앙/p90": [pct(gaps, 50), pct(gaps, 90)],
        "앞 partial이 다음의 앞부분이 아닌 비율(%)": round(100 * changed / max(pairs, 1), 1),
        "그때 고쳐 쓴 글자 수 중앙": statistics.median(rewritten) if rewritten else 0,
        "마지막 partial → final 앞부분이 다름(%)": round(100 * sum(1 for u in has if not norm(u["final"]).startswith(norm(u["partials"][-1][1]))) / max(len(has), 1), 1),
        "규칙": {f"{'글자' if unit == 'char' else '낱말'} N={n}": rule(utts, n, unit) for unit in ("char", "word") for n in (1, 2, 3)},
    }
    return r


if __name__ == "__main__":
    if sys.argv[1] == "sim":
        sim(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "기헌, 태은, 준영, 지호")
    else:
        print(json.dumps(stats(sys.argv[2:]), ensure_ascii=False, indent=1))
