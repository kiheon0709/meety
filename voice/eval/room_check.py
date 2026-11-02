"""촬영·회의 전 방 점검 (1분). 그 자리에서 녹음해 받아쓰기 틀림·화자 점수·잡음 start·말 끝 늦음을 한 표로 보고 한 줄로 판정한다.

사용 (음성 서버는 꺼 두세요 — GPU를 같이 쓰면 느려져요):
  voice/.venv/bin/python voice/eval/room_check.py 기헌 태은 준영 지호          # 노트북 마이크로 60초 녹음하며 화면 안내대로 읽기
  voice/.venv/bin/python voice/eval/room_check.py --device 1 기헌 태은       # 마이크가 여럿이면 번호 (ffmpeg -f avfoundation -list_devices true -i "")
  voice/.venv/bin/python voice/eval/room_check.py --wav 녹음.wav             # 이미 있는 녹음: 녹음.turns.json 필요 (이 도구나 fake_meeting.py가 만든 것)
녹음은 voice/recordings/room-check-날짜-시각.wav(+.turns.json, 결과 .check.json). 소리 파일이라 git에 안 올라가요.

판정 기준 (S2 2026-10-30 23:30 측정, voice/eval/room_mix.py): 받아쓰기 틀림 16% 이상 → 노트북에서 2m쯤 떨어진 것과 같음 → 거리 줄이기.
조용히 있는 10초에 소리 감지(start)가 나면 → 분당 0.5번 넘는 잡음 → 소음 줄이기. 말 끝 늦음 중앙 300ms 넘어도 소음.
화자: 같은 사람 두 문장의 목소리 지문이 0.75(서버 화자 임계) 아래거나, 다른 사람과 0.75 넘게 닮으면 등록·구분이 흔들림.
"""

import argparse
import json
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))

QUIET_S = 10  # 처음 이만큼 모두 조용히 → 잡음 재기
TURN_S = 11  # 한 사람이 두 문장 읽는 시간
CER_MAX = 0.16
NOISE_PER_MIN = 0.5
LATE_MS = 300
# 두 문장씩. 이름·숫자·"미티"가 들어 있어 회의 말과 비슷하다. 숫자는 whisper가 쓰는 대로 아라비아 숫자로(안 그러면 맞게 들어도 틀림으로 센다)
SENTENCES = [
    ("미티야, 오늘 안건 3개만 빠르게 보자.", "리허설은 일요일 저녁 8시에 하기로 했어요."),
    ("시연 영상은 회의 장면을 먼저 보여 주고 싶어요.", "디스코드 연동은 알림만 보내는 걸로 줄였죠."),
    ("서버 쪽은 오늘 밤까지 제가 정리해 둘게요.", "발표 자료는 다음 주 월요일에 다시 볼게요."),
    ("회의록 정리 화면에서 할 일이 잘 보여야 해요.", "그럼 담당은 제가 맡고 금요일까지 끝낼게요."),
    ("포스터 첫 줄은 짧게 한 문장으로 가죠.", "미티가 말하기 전에 이유 카드가 먼저 떠요."),
    ("녹음 파일은 모두 동의했을 때만 저장해요.", "다음 회의는 수요일 오후 3시 어때요?"),
]


# ── 녹음 ────────────────────────────────────────────────


def record(names: list[str], device: str) -> Path:
    from segmenter import SR

    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    wav = VOICE / "recordings" / f"room-check-{stamp}.wav"
    total = QUIET_S + TURN_S * len(names) + 2
    turns = [{"speaker": n, "t0": QUIET_S + i * TURN_S, "t1": QUIET_S + (i + 1) * TURN_S, "text": " ".join(SENTENCES[i % len(SENTENCES)]), "window": True}
             for i, n in enumerate(names)]
    print(f"\n{total}초 녹음해요. 실제 회의처럼 자기 자리에 앉아, 차례가 오면 노트북 쪽을 보고 평소 목소리로 읽어 주세요.\n")
    for u in turns:
        print(f"  {u['speaker']}: {u['text']}")
    input("\n준비되면 Enter ")
    p = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "avfoundation", "-i", f":{device}", "-t", str(total), "-ac", "1", "-ar", str(SR), str(wav)])
    t0 = time.monotonic()

    def until(t: float):
        while time.monotonic() - t0 < t:
            time.sleep(0.05)

    print(f"\n● 녹음 중 — {QUIET_S}초 동안 모두 조용히 (방 소음 재는 중)")
    for u in turns:
        until(u["t0"] - 1)
        print(f"\n▶ {u['speaker']} 님 차례 ({TURN_S}초): {u['text']}")
    until(total)
    p.wait()
    print("\n■ 녹음 끝. 재는 중… (1분쯤)\n")
    if p.returncode or not wav.exists():
        sys.exit("녹음을 못 했어요. 터미널에 마이크 권한이 있는지(시스템 설정 → 개인정보 보호 → 마이크), --device 번호가 맞는지 보세요.")
    wav.with_suffix(".turns.json").write_text(json.dumps({"quiet": [0, QUIET_S], "turns": turns}, ensure_ascii=False, indent=1))
    return wav


# ── 재기 ────────────────────────────────────────────────


def frame_rms(a: np.ndarray, sr: int) -> np.ndarray:
    w = sr // 50
    return np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1) + 1e-12)


def speech_end(a: np.ndarray, sr: int, t0: float, t1: float, floor: float) -> float:
    """창(t0~t1) 안에서 말이 끝난 때를 소리 크기로 어림한다 (녹음한 창은 실제 말 끝을 모른다).
    바닥 소음보다 6dB, 그 창에서 가장 큰 말소리보다 20dB 안쪽인 틀이 0.1초 넘게 이어진 마지막 곳 — 그릇 소리 같은 짧은 소리는 넘긴다."""
    f = frame_rms(a[int(t0 * sr) : int(t1 * sr)], sr)
    if not len(f):
        return t1
    loud = f > max(floor * 10 ** (6 / 20), float(np.percentile(f, 95)) * 10 ** (-20 / 20))
    run, last = 0, None
    for i, x in enumerate(loud):
        run = run + 1 if x else 0
        if run >= 5:
            last = i
    return t0 + (last + 1) / 50 if last is not None else t1


def measure(wav: Path) -> dict:
    import soundfile as sf

    from replay import cer
    from segmenter import SR, FRAME, Segmenter, transcribe
    from server import MIN_SILENCE_MS, TTS_THRESHOLD, hint
    from speakers import THRESHOLD, Registry, embed

    a = sf.read(str(wav), dtype="float32", always_2d=True)[0][:, 0]
    meta = json.loads(wav.with_suffix(".turns.json").read_text())
    turns = meta["turns"] if isinstance(meta, dict) else meta
    quiet = meta.get("quiet") if isinstance(meta, dict) else None
    a = np.concatenate([a, np.zeros(2 * SR, np.float32)])
    names = [u["speaker"] for u in turns]
    floor = float(np.median(frame_rms(a[: int(quiet[1] * SR)], SR))) if quiet else float(np.percentile(frame_rms(a, SR), 10))

    def run(th):
        seg, starts, segs = Segmenter(MIN_SILENCE_MS, threshold=th), [], []
        for k in range(0, len(a) - FRAME, FRAME):
            for ev in seg.feed(a[k : k + FRAME]):
                if ev[0] == "start":
                    starts.append(ev[1])
                else:
                    segs.append({"t0": ev[1], "t1": ev[2], "quiet_from": seg.quiet_from, "audio": ev[3]})
        return starts, segs

    starts, segs = run(0.5)
    starts_tts, _ = run(TTS_THRESHOLD)
    transcribe(np.zeros(SR, np.float32))
    for s in segs:
        s["text"] = transcribe(s["audio"], hint(", ".join(names)))
    reg = Registry()  # 앱에서 이미 등록한 목소리가 있으면 그것과도 비교
    rows, voices = [], {}
    for u in turns:
        mine = [s for s in segs if min(s["t1"], u["t1"]) - max(s["t0"], u["t0"]) >= 0.2]
        text = " ".join(s["text"] for s in mine)
        end = speech_end(a, SR, u["t0"], u["t1"], floor) if u.get("window") else u["t1"]
        audio = np.concatenate([s["audio"] for s in mine]) if mine else np.zeros(0, np.float32)
        half = len(audio) // 2
        v1, v2, v = embed(audio[:half]), embed(audio[half:]), embed(audio)
        voices[u["speaker"]] = v
        rows.append({
            "이름": u["speaker"], "CER": round(cer(u["text"], text), 3), "받아쓴 글": text,
            "말 끝 늦음(ms)": round((mine[-1]["quiet_from"] - end) * 1000) if mine else None,
            "두 문장 닮음": None if v1 is None or v2 is None else round(float(v1 @ v2), 3),
            "등록 목소리와": None if v is None or u["speaker"] not in reg.voices else round(float(v @ reg.voices[u["speaker"]]), 3),
        })
    for r in rows:
        v = voices[r["이름"]]
        others = [float(v @ w) for n, w in voices.items() if n != r["이름"] and w is not None] if v is not None else []
        r["다른 사람과 최대"] = round(max(others), 3) if others else None
    total_ref = " ".join(u["text"] for u in turns)
    total_hyp = " ".join(s["text"] for s in segs if any(min(s["t1"], u["t1"]) - max(s["t0"], u["t0"]) >= 0.2 for u in turns))
    if quiet:
        q = quiet[1] - quiet[0] - 0.5  # 끝 0.5초는 첫 사람이 일찍 시작할 수 있어 뺀다
        noise = {"조용한 초": round(q, 1), "start": sum(1 for t in starts if quiet[0] <= t < quiet[0] + q),
                 "start(미티 말하는 중 0.8)": sum(1 for t in starts_tts if quiet[0] <= t < quiet[0] + q)}
        noise["분당"] = round(noise["start"] / q * 60, 2)
    else:
        noise = None
    lates = [r["말 끝 늦음(ms)"] for r in rows if r["말 끝 늦음(ms)"] is not None]
    res = {"rows": rows, "CER 전체": round(cer(total_ref, total_hyp), 3), "잡음": noise,
           "말 끝 늦음 중앙(ms)": round(statistics.median(lates)) if lates else None,
           "소음 바닥(dBFS)": round(20 * np.log10(floor), 1)}
    res["판정"] = verdict(res, THRESHOLD)
    return res


def verdict(res: dict, threshold: float = 0.75) -> list[str]:
    out = []
    far = [r["이름"] for r in res["rows"] if r["CER"] >= CER_MAX]
    if res["CER 전체"] >= CER_MAX or far:
        out.append(f"거리 줄이기 — 받아쓰기 틀림 {res['CER 전체']:.0%}" + (f", 특히 {', '.join(far)}: 노트북에서 1m 안으로·노트북을 그쪽으로" if far else ""))
    n = res["잡음"]
    late = res["말 끝 늦음 중앙(ms)"]
    if (n and n["분당"] >= NOISE_PER_MIN) or (late is not None and late > LATE_MS):
        why = []
        if n and n["분당"] >= NOISE_PER_MIN:
            why.append(f"조용할 때 소리 감지 {n['start']}번")
        if late is not None and late > LATE_MS:
            why.append(f"말 끝 늦음 {late}ms")
        out.append("소음 줄이기 — " + ", ".join(why) + ": 에어컨·환풍기·음악 끄기, 문 닫기")
    weak = [r["이름"] for r in res["rows"] if (r["두 문장 닮음"] or 0) < threshold or (r["다른 사람과 최대"] or 0) >= threshold
            or (r["등록 목소리와"] is not None and r["등록 목소리와"] < threshold)]
    if weak:
        out.append(f"화자 구분 약함 — {', '.join(weak)}: 이 자리에서 목소리 다시 등록, 조금 더 가까이")
    return out or ["이 방 괜찮음"]


def show(res: dict):
    print("| 이름 | 받아쓰기 틀림 | 말 끝 늦음 | 두 문장 닮음 | 다른 사람과 | 등록 목소리와 |")
    print("|---|---|---|---|---|---|")
    for r in res["rows"]:
        print(f"| {r['이름']} | {r['CER']:.0%} | {r['말 끝 늦음(ms)']}ms | {r['두 문장 닮음']} | {r['다른 사람과 최대']} | {r['등록 목소리와'] or '-'} |")
    n = res["잡음"]
    print(f"\n받아쓰기 틀림 전체 {res['CER 전체']:.0%} (기준 {CER_MAX:.0%} 미만) · 말 끝 늦음 중앙 {res['말 끝 늦음 중앙(ms)']}ms (기준 {LATE_MS}ms 이하) · 소음 바닥 {res['소음 바닥(dBFS)']}dBFS")
    if n:
        print(f"조용한 {n['조용한 초']}초 동안 소리 감지 {n['start']}번 (분당 {n['분당']}, 기준 {NOISE_PER_MIN} 미만) · 미티 말하는 중 기준(0.8)으로는 {n['start(미티 말하는 중 0.8)']}번")
    print("\n판정: " + " / ".join(res["판정"]))
    for r in res["rows"]:
        print(f"  {r['이름']}: {r['받아쓴 글']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--wav")
    ap.add_argument("--device", default="0")
    a = ap.parse_args()
    if not a.wav and not a.names:
        ap.error("이름을 주거나 --wav 녹음.wav")
    wav = Path(a.wav) if a.wav else record(a.names, a.device)
    res = measure(wav)
    wav.with_suffix(".check.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    show(res)


if __name__ == "__main__":
    main()
