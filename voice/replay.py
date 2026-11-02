"""재생 평가: wav를 실제 속도로 음성 서버 /ws에 흘려 넣고 이벤트를 모두 남긴 뒤 잰다.

사용: voice/.venv/bin/python voice/replay.py 입력.wav [--speed 1.0] [--port 8766] [--tts 12.0:14.5 ...] [--enroll 등록.wav]
  입력.events.jsonl  받은 이벤트 전부. 각 줄에 recv(벽시계 초)·audio(그때까지 보낸 오디오 초)가 붙는다
  입력.metrics.json  입력.turns.json(fake_meeting.py가 만든 정답)이 있으면 잰 값
--tts A:B 는 오디오 A초~B초 동안 미티가 말하는 중이라고 서버에 알린다 (barge_in 시험).
--enroll 등록.wav 는 먼저 등록.turns.json의 사람마다 그 말소리로 화자 등록을 한다 (speaker 정확도 시험).
"""

import argparse
import asyncio
import io
import json
import urllib.parse
import urllib.request
import re
import statistics
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

SR = 16000
GAPS = (300, 800, 1500)
TAIL = 2.5  # 마지막 말 뒤 1500ms gap까지 나오게 덧붙이는 조용함(초)


async def stream(wav: Path, port: int, speed: float, chunk_ms: int, prompt: str | None, tts: list[tuple[float, float]]) -> list[dict]:
    audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    assert sr == SR, f"{wav}: {sr}Hz — 16kHz mono만 받는다"
    pcm = (np.clip(audio[:, 0], -1, 1) * 32767).astype(np.int16)
    pcm = np.concatenate([pcm, np.zeros(int(TAIL * SR), np.int16)])
    step = SR * chunk_ms // 1000
    events: list[dict] = []
    sent = 0  # 보낸 샘플 수
    t_start = time.monotonic()

    async with websockets.connect(f"ws://127.0.0.1:{port}/ws", max_size=None) as ws:

        async def recv():
            async for m in ws:
                ev = json.loads(m)
                ev["recv"] = round(time.monotonic() - t_start, 3)
                ev["audio"] = round(sent / SR, 3)
                events.append(ev)

        rx = asyncio.create_task(recv())
        await ws.send(json.dumps({"type": "start", "prompt": prompt, "save": False}))
        marks = sorted([(a, True) for a, _ in tts] + [(b, False) for _, b in tts])
        for k in range(0, len(pcm), step):
            while marks and marks[0][0] <= k / SR:
                await ws.send(json.dumps({"type": "tts", "on": marks.pop(0)[1]}))
            await ws.send(pcm[k : k + step].tobytes())
            sent = min(k + step, len(pcm))
            wait = t_start + sent / SR / speed - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
        # 남은 받아쓰기가 끝날 때까지 (2초 동안 새 이벤트가 없으면 끝)
        while True:
            n = len(events)
            await asyncio.sleep(2)
            if len(events) == n:
                break
        rx.cancel()
    return events


def enroll(wav: Path, port: int):
    a, sr = sf.read(str(wav), dtype="float32")
    for u in json.loads(Path(f"{wav.with_suffix('')}.turns.json").read_text()):
        buf = io.BytesIO()
        sf.write(buf, a[int(u["t0"] * sr) : int(u["t1"] * sr)], sr, format="WAV")
        name = urllib.parse.quote(u["speaker"])
        req = urllib.request.Request(f"http://127.0.0.1:{port}/speakers/enroll?name={name}&replace=true", data=buf.getvalue(), method="POST", headers={"x-voice-confirm": "1"})
        print("등록", urllib.request.urlopen(req).read().decode())


def norm(s: str) -> str:
    return re.sub(r"[\s\W]", "", s)


def cer(ref: str, hyp: str) -> float:
    r, h = norm(ref), norm(hyp)
    d = list(range(len(h) + 1))
    for i, a in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, b in enumerate(h, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (a != b))
    return d[len(h)] / max(len(r), 1)


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


WAKE = re.compile(r"미티")


def measure(events: list[dict], turns: list[dict], total: float, tts: list[tuple[float, float]]) -> dict:
    by = lambda typ: [e for e in events if e["type"] == typ]
    ends = {e["id"]: e for e in by("speech_end")}
    finals = {e["id"]: e for e in by("final")}

    def turn_before(t: float):
        cand = [u for u in turns if u["t1"] <= t + 0.05]
        return cand[-1] if cand else None

    # 1) speech_end → final 지연, 실제로 말이 멎은 때 → final 도착
    lat = [(finals[i]["recv"] - ends[i]["recv"]) * 1000 for i in finals if i in ends]
    perceived = []
    for f in finals.values():
        u = turn_before(f["audio"])
        if u:
            perceived.append((f["audio"] - u["t1"]) * 1000)

    # 2) gap: 정답 침묵(다음 사람 말까지)과 비교
    nexts = [u["t0"] for u in turns[1:]] + [total + TAIL]
    silence = [(n - u["t1"]) * 1000 for u, n in zip(turns, nexts)]
    # 침묵이 기준±100ms 안이면 나와도 안 나와도 맞은 것으로 본다
    expected = {(k, ms) for k, s in enumerate(silence) for ms in GAPS if s > ms + 100}
    allowed = {(k, ms) for k, s in enumerate(silence) for ms in GAPS if s > ms - 100}
    got, extra, errs = set(), [], {ms: [] for ms in GAPS}
    held = 0
    for g in by("gap"):
        u = turn_before(g["audio"])
        k = turns.index(u) if u else -1
        inside = u is None or g["audio"] > nexts[k] + 0.05  # 침묵이 아니라 다음 말 중간에 나옴
        if inside or (k, g["ms"]) not in allowed or (k, g["ms"]) in got:
            extra.append({"after_id": g["after_id"], "ms": g["ms"], "audio": g["audio"]})
            continue
        got.add((k, g["ms"]))
        err = (g["audio"] - u["t1"]) * 1000 - g["ms"]
        errs[g["ms"]].append(err)
        f = finals.get(g["after_id"])
        if f and abs(f["recv"] - g["recv"]) < 0.02 and err > 50:
            held += 1  # final을 기다리느라 늦게 나간 것
    gap_stats = {
        str(ms): {
            "n": len(e),
            "err_median_ms": round(statistics.median(e)) if e else None,
            "err_max_abs_ms": round(max(abs(x) for x in e)) if e else None,
            "within_100ms": f"{sum(abs(x) <= 100 for x in e)}/{len(e)}",
        }
        for ms, e in errs.items()
    }
    missing = sorted(expected - got)

    # 3) 받아쓰기: 짧은 틈(0.5초 미만)은 말 하나로 붙어서 나오므로, 전체를 이어 붙여 비교한다
    fl = sorted(finals.values(), key=lambda f: f["id"])
    ref_all, hyp_all = " ".join(u["text"] for u in turns), " ".join(f["text"] for f in fl)
    # final마다 겹치는 사람 말 (화자 정확도용)
    per_final = [{"id": f["id"], "text": f["text"], "speaker": f.get("speaker"), "echo": f.get("echo", False),
                  "truth": [u["speaker"] for u in turns if u["t0"] < f["t1"] and f["t0"] < u["t1"]]} for f in fl]

    # 4) barge_in: 미티가 말하는 구간 안에서 사람 말이 시작됐는지
    barge_expected = [u for u in turns for a, b in tts if a <= u["t0"] <= b]

    return {
        "segments": len(ends),
        "turns": len(turns),
        "speech_end_to_final_ms": {"n": len(lat), "median": round(statistics.median(lat)), "p90": round(pct(lat, 0.9)), "max": round(max(lat))} if lat else None,
        "silence_to_final_ms": {"median": round(statistics.median(perceived)), "p90": round(pct(perceived, 0.9))} if perceived else None,
        "gap": gap_stats,
        "gap_expected": len(expected),
        "gap_matched": len(got),
        "gap_missing": [{"turn": k, "ms": ms} for k, ms in missing],
        "gap_extra": extra,
        "gap_held_for_final": held,
        "cer": round(cer(ref_all, hyp_all), 3),
        "wake": {"대본_미티": len(WAKE.findall(ref_all)), "받아쓴_미티": len(WAKE.findall(hyp_all))},
        "barge_in": {"sent": len(by("barge_in")), "expected": len(barge_expected)},
        "echo_finals": sum(1 for f in finals.values() if f.get("echo")),
        # 화자: 한 사람 말과만 겹친 final만 센다 (두 사람 말이 붙은 final은 정답이 하나가 아니라서)
        "speaker": {
            "맞음": sum(1 for f in per_final if len(f["truth"]) == 1 and f["speaker"] == f["truth"][0]),
            "틀림": sum(1 for f in per_final if len(f["truth"]) == 1 and f["speaker"] and f["speaker"] != f["truth"][0]),
            "비움": sum(1 for f in per_final if len(f["truth"]) == 1 and not f["speaker"]),
            "두 사람 겹침(안 셈)": sum(1 for f in per_final if len(f["truth"]) != 1),
        },
        "finals": per_final,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", type=Path)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--chunk-ms", type=int, default=32)
    ap.add_argument("--prompt")
    ap.add_argument("--tts", action="append", default=[], help="A:B (초)")
    ap.add_argument("--enroll", type=Path, help="화자 등록용 wav (옆에 turns.json)")
    ap.add_argument("--tag", default="", help="결과 파일 이름 뒤에 붙임")
    ap.add_argument("--score-only", action="store_true", help="서버 없이 남겨 둔 .events.jsonl만 다시 잰다")
    a = ap.parse_args()
    tts = [tuple(map(float, s.split(":"))) for s in a.tts]
    stem = a.wav.with_suffix("")
    suffix = f".{a.tag}" if a.tag else ""
    out = Path(f"{stem}{suffix}.events.jsonl")
    if a.score_only:
        events = [json.loads(l) for l in out.read_text().splitlines()]
    else:
        if a.enroll:
            enroll(a.enroll, a.port)
        events = asyncio.run(stream(a.wav, a.port, a.speed, a.chunk_ms, a.prompt, tts))
        out.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events))
        print(f"{out}: 이벤트 {len(events)}개")
    turns_path = Path(f"{stem}.turns.json")
    if turns_path.exists():
        m = measure(events, json.loads(turns_path.read_text()), sf.info(str(a.wav)).duration, tts)
        Path(f"{stem}{suffix}.metrics.json").write_text(json.dumps(m, ensure_ascii=False, indent=1))
        print(json.dumps({k: v for k, v in m.items() if k != "finals"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
