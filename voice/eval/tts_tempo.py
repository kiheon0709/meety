"""11/2 미티 목소리(후보 6: Sohee 1.2배, 온도 0.5·top_k 20·씨앗 7)를 앱 기본값으로 넣은 뒤 재기.

  worker PORT TAG [open] — 작업자에 바로 (open: tts_open.py 대사 4개, 포스터 숫자와 같은 방법)
                   : 세 문장 × ROUNDS번, 첫 조각까지(ms)·다 받음·같은 문장이 매번 같은 소리인지·받아쓰기 CER·튀는 곳
  video            — 받아 둔 app-*.wav로 mp4만 다시
  app PORT         — 음성 서버 /tts/stream(실제 앱 경로)으로 세 문장: 첫 조각까지, 받은 그대로 wav → 받아쓰기 → 후보 6과 같은 꼴의 mp4
사용: voice/.venv/bin/python voice/eval/tts_tempo.py worker 8791 after
→ voice/recordings/tts-tempo/ (git 제외)
"""

import json
import statistics
import sys
import time
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np

VOICE = Path(__file__).resolve().parent.parent
OUT = VOICE / "recordings" / "tts-tempo"
sys.path.insert(0, str(VOICE))
sys.path.insert(0, str(VOICE / "eval"))
from tts_1101 import LINES  # noqa: E402

ROUNDS = 6
SR = 24000


def post(url, body):
    """(첫 조각까지 초, 다 받은 초, PCM16 bytes)."""
    r = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    t, first, buf = time.monotonic(), None, b""
    with urllib.request.urlopen(r, timeout=60) as resp:
        while b := resp.read1(4096):
            first = first or time.monotonic() - t
            buf += b
    return first, time.monotonic() - t, buf


def save(path, pcm):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm[: len(pcm) // 2 * 2])


def check(path, line):
    from replay import cer
    from segmenter import transcribe
    from tts_compare import to16k

    a = np.frombuffer(path.read_bytes()[44:], "<i2").astype(np.float32) / 32768
    heard = transcribe(np.concatenate([to16k(path), np.zeros(8000, np.float32)]))
    return {"heard": heard, "cer": round(cer(line, heard), 3), "sec": round(len(a) / SR, 2), "max_jump": round(float(np.abs(np.diff(a)).max()), 3)}


def worker(port, tag, lines=LINES):
    OUT.mkdir(parents=True, exist_ok=True)
    url = f"http://127.0.0.1:{port}/stream"
    post(url, {"text": "네."})  # 데우기
    rows = []
    for k in range(ROUNDS):
        for i, line in enumerate(lines, 1):
            first, total, pcm = post(url, {"text": line})
            p = OUT / f"{tag}-{i}-r{k}.wav"
            save(p, pcm)
            rows.append({"line": i, "round": k, "first_ms": round(first * 1000), "total_s": round(total, 2), "bytes": len(pcm)})
            print(tag, rows[-1], flush=True)
    n = range(1, len(lines) + 1)
    same = {i: len({(OUT / f"{tag}-{i}-r{k}.wav").read_bytes() for k in range(ROUNDS)}) == 1 for i in n}
    heard = {i: check(OUT / f"{tag}-{i}-r0.wav", lines[i - 1]) for i in n}
    firsts = [r["first_ms"] for r in rows]
    res = {"first_ms_median": statistics.median(firsts), "first_ms_range": [min(firsts), max(firsts)], "n": len(firsts), "same_every_round": same, "heard": heard, "rows": rows}
    (OUT / f"{tag}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k != "rows"}, ensure_ascii=False, indent=1))


def app(port):
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, line in enumerate(LINES, 1):
        first, total, pcm = post(f"http://127.0.0.1:{port}/tts/stream", {"text": line})
        p = OUT / f"app-{i}.wav"
        save(p, pcm)
        rows.append({"line": i, "first_ms": round(first * 1000), "total_s": round(total, 2), **check(p, line)})
        print(rows[-1], flush=True)
    res = {"rows": rows, **video()}
    (OUT / "app.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k != "rows"}, ensure_ascii=False, indent=1))


def video():
    """받아 둔 app-{1,2,3}.wav로 후보 6 mp4와 같은 꼴(카드 한 장 + 세 문장, 사이 0.6초)을 만들고 받아써서 화면 글과 견준다."""
    import subprocess

    from replay import cer
    from segmenter import transcribe
    from tts_1101 import card
    from tts_compare import to16k

    png = OUT / "card.png"
    card(png, "미티 목소리 (앱 기본값)", "Sohee 1.2배 · 온도 0.5 · 씨앗 고정 — 음성 서버 /tts/stream으로 받은 그대로\n" + "\n".join(f"{i}. {t}" for i, t in enumerate(LINES, 1)))
    gap = np.zeros(int(0.6 * SR), "<i2").tobytes()
    allp = OUT / "app-all.wav"
    save(allp, gap + gap.join((OUT / f"app-{i}.wav").read_bytes()[44:] for i in (1, 2, 3)) + gap)
    mp4 = OUT / "미티-목소리-앱기본.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-i", str(png), "-i", str(allp), "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k", "-shortest", str(mp4)], check=True)
    heard = transcribe(to16k(allp))
    return {"mp4": str(mp4.relative_to(VOICE.parent)), "mp4_heard": heard, "mp4_cer": round(cer("".join(LINES), heard), 3)}


if __name__ == "__main__":
    if sys.argv[1] == "worker":
        if sys.argv[4:] == ["open"]:  # 포스터 "첫 음성까지" 숫자와 같은 대사 4개 (tts_open.py, 10/31 밤)
            from tts_open import LINES as OPEN

            worker(int(sys.argv[2]), sys.argv[3], OPEN)
        else:
            worker(int(sys.argv[2]), sys.argv[3])
    elif sys.argv[1] == "video":
        print(video())
    else:
        app(int(sys.argv[2]))
