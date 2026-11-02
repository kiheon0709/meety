"""한 방·노트북 마이크 하나 회의 흉내: 거리·울림·겹침·카페 소음(SNR 20/10dB)별로 받아쓰기 CER·화자 구분·말 끝 판정·final.barge를 잰다.

사용: voice/.venv/bin/python voice/eval/room_mix.py [fake|real]   (안 주면 둘 다) → voice/recordings/room_mix.json, 표는 화면에
  fake: voice/scenarios 대본 5개(기헌·태은·준영·지호 + 등록 안 된 민수)를 fake_meeting처럼 맥 목소리로 읽어 한 채널에 놓는다.
        정답 글·시각·화자가 정확하다. 단, 같은 Yuna 목소리의 높낮이만 바꾼 4명이라 화자 구분은 실제보다 어렵다
  real: 멘토링 줌 녹화(voice/recordings/mentoring-full.wav) 앞 15:50에 울림·소음을 입힌다. 줌이라 각자 자기 마이크로 녹음된 것을
        2m 떨어진 노트북 한 대로 들은 것처럼 바꾼다. 받아쓰기 정답은 전사, 화자 정답은 시각이 붙은 멘토·기헌만 (real_voice.py와 같다)
서버를 띄우지 않고 서버 final과 같은 길(Segmenter → transcribe(마디, hint) · registry.identify · barge_verdict)을 직접 부른다.

방: 회의실 60m³·울림 RT60 0.4초(합성 — 지수로 줄어드는 잡음 꼬리). 임계 거리 0.7m에서 직접음과 울림 크기가 같다.
    노트북에서 기헌 0.5m, 태은 1m, 준영 1.5m, 지호 2.5m, 민수 2m.
카페 소음: 녹음 파일을 내려받지 않고 합성한다 — Supertonic 목소리 7개(tts-compare/roles/_all-*)를 6겹 섞어 멀리서 울리게 한
    웅성거림 + 분홍 잡음 + 가끔 그릇 부딪는 소리. 실제 카페보다 단조롭다
"""

import hashlib
import json
import random
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, sosfilt

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
from fake_meeting import trim  # noqa: E402
from max_speech import END, reference  # noqa: E402
from real_voice import blocks, label  # noqa: E402
from replay import cer  # noqa: E402
from segmenter import FRAME, SR, Segmenter, transcribe  # noqa: E402
from server import hint  # noqa: E402
from speakers import THRESHOLD, Registry, embed  # noqa: E402

REC = VOICE / "recordings"
ROOM = REC / "room"
OUT = REC / "room_mix.json"
MENTORING = REC / "mentoring-full.wav"
MD = VOICE.parent / "docs" / "mentoring" / "2026-10-29-멘토링-전사.md"

SCRIPTS = ["A-meeting", "B-presentation", "day2", "speakers-test", "wake"]
MEMBERS = ["기헌", "태은", "준영", "지호"]
PITCH = {"기헌": 1.0, "태은": 0.82, "준영": 1.15, "지호": 0.9, "민수": 1.07}  # fake_meeting 배정과 같게
DIST = {"기헌": 0.5, "태은": 1.0, "준영": 1.5, "지호": 2.5, "민수": 2.0}
BACKCHANNELS = ["네", "맞아요", "음 그렇죠", "아 네네"]
RT60, RC = 0.4, 0.7
SPEECH_DBFS = -26  # 말소리 평균 크기를 여기 맞춘 뒤 소음을 SNR만큼 아래로

# (거리·울림, 겹침, SNR dB 또는 None)
CONDS = {
    "깨끗함": (False, False, None),
    "거리·울림": (True, False, None),
    "거리·울림+겹침": (True, True, None),
    "거리·울림+카페20": (True, False, 20),
    "거리·울림+카페10": (True, False, 10),
    "거리·울림+겹침+카페10": (True, True, 10),
}
VADS = [(0.5, 500), (0.5, 300), (0.5, 800), (0.35, 500), (0.65, 500)]  # (silero 임계, 말 끝 조용 ms). 첫째가 지금 서버 기본값
BARGE_VAD = 0.8  # 미티가 말하는 동안 서버가 쓰는 임계 (server.TTS_THRESHOLD)
SPK_TH = [0.65, 0.7, 0.75, 0.8]
OTHER_TH = [0.5, 0.55, 0.6]
LEN_BUCKETS = [(0, 1), (1, 2), (2, 4), (4, 99)]


# ── 소리 만들기 ─────────────────────────────────────────


def say(text: str, pitch: float) -> np.ndarray:
    key = hashlib.md5(f"{text}|{pitch}".encode()).hexdigest()[:12]
    p = ROOM / "say" / f"{key}.wav"
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["say", "-v", "Yuna", "-o", f"{d}/a.aiff", text], check=True)
            af = f"asetrate=22050*{pitch},aresample={SR},atempo={1 / pitch:.4f}"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{d}/a.aiff", "-af", af, "-ac", "1", str(p)], check=True)
    return trim(sf.read(str(p), dtype="float32")[0])


def rir(seed: int, rt60: float = RT60) -> np.ndarray:
    """합성 방 울림: 3ms 뒤부터 RT60에 60dB 줄어드는 잡음 꼬리, 에너지 1."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(rt60 * SR)) / SR
    h = rng.normal(0, 1, len(t)) * np.exp(-6.91 * t / rt60)
    h[: int(0.003 * SR)] = 0
    return (h / np.linalg.norm(h)).astype(np.float32)


def place(a: np.ndarray, d: float, seed: int) -> np.ndarray:
    """d미터 떨어진 목소리: 직접음은 거리에 반비례, 울림(확산음)은 거리와 상관없이 일정 → 멀수록 울림 비율이 커진다."""
    out = fftconvolve(a, rir(seed)).astype(np.float32)
    out[: len(a)] += a * (RC / d)
    return out


def active_rms(a: np.ndarray) -> float:
    """말소리 구간 크기: 20ms 틀 중 가장 큰 틀에서 35dB 안쪽인 틀만."""
    w = SR // 50
    f = np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1))
    return float(np.sqrt(np.mean(f[f > f.max() * 10 ** (-35 / 20)] ** 2)))


def cafe(n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    voices = []
    for p in sorted((REC / "tts-compare" / "roles").glob("_all-supertonic3-*.wav")):
        a, sr = sf.read(str(p), dtype="float32", always_2d=True)
        voices.append(np.interp(np.arange(0, len(a), sr / SR), np.arange(len(a)), a[:, 0]).astype(np.float32))
    babble = np.zeros(n, np.float32)
    for _ in range(6):
        v = voices[rng.integers(len(voices))]
        v = np.tile(v, n // len(v) + 2)
        s = rng.integers(len(v) - n)
        babble += v[s : s + n] * rng.uniform(0.5, 1.0)
    babble = fftconvolve(babble, rir(seed + 1, 0.8))[:n]  # 멀리서: 거의 울림만
    pink = np.fft.irfft(np.fft.rfft(rng.normal(0, 1, n)) / np.sqrt(np.maximum(np.fft.rfftfreq(n, 1 / SR), 20)), n)
    out = babble / np.sqrt(np.mean(babble**2)) + 0.3 * pink / np.sqrt(np.mean(pink**2))
    sos = butter(4, [2000, 6000], "bandpass", fs=SR, output="sos")
    t = 0.5
    while t < n / SR - 0.2:  # 그릇 소리: 2~6kHz 짧게 울리고 사라짐
        k = int(t * SR)
        burst = sosfilt(sos, rng.normal(0, 1, int(0.15 * SR))) * np.exp(-np.arange(int(0.15 * SR)) / (0.03 * SR))
        out[k : k + len(burst)] += 2.5 * burst / np.sqrt(np.mean(burst**2) + 1e-12)
        t += rng.uniform(2, 6)
    return out.astype(np.float32)


def finish(clean: np.ndarray, snr: float | None, seed: int) -> np.ndarray:
    """말소리를 SPEECH_DBFS로 맞추고 소음을 SNR만큼 아래로 더한다. 소음 없으면 fake_meeting처럼 아주 약한 잡음만."""
    a = clean * (10 ** (SPEECH_DBFS / 20) / active_rms(clean))
    if snr is None:
        return (a + np.random.default_rng(seed).normal(0, 0.0002, len(a))).astype(np.float32)
    nz = cafe(len(a), seed)
    return (a + nz * (10 ** ((SPEECH_DBFS - snr) / 20) / np.sqrt(np.mean(nz**2)))).astype(np.float32)


# ── 잴 것 ───────────────────────────────────────────────


def segment(audio: np.ndarray, th: float, ms: int) -> tuple[list[float], list[dict]]:
    seg, starts, segs = Segmenter(ms, threshold=th), [], []
    for k in range(0, len(audio) - FRAME, FRAME):
        for ev in seg.feed(audio[k : k + FRAME]):
            if ev[0] == "start":
                starts.append(ev[1])
            else:
                segs.append({"t0": ev[1], "t1": ev[2], "quiet_from": seg.quiet_from, "audio": ev[3]})
    return starts, segs


def ov(a0, a1, b0, b1) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def verdict(sims: dict | None, other_max: float) -> str:
    """speakers.barge_verdict와 같은 규칙 (등록 임계는 지금 값 THRESHOLD)."""
    if not sims:
        return "unsure"
    best = max(sims.values())
    return "member" if best >= THRESHOLD else "other" if best < other_max else "unsure"


def bucket(sec: float) -> str:
    return next(f"{a}~{b}초" if b < 99 else f"{a}초+" for a, b in LEN_BUCKETS if a <= sec < b)


def barge_rows(items: list[tuple[str, float, dict | None]]) -> dict:
    """items: (정답 종류, 마디 길이, {등록자: 유사도} 또는 None) → 종류·길이별 member/other/unsure 수 (other 임계별)."""
    out = {}
    for th in OTHER_TH:
        t = {}
        for kind, dur, sims in items:
            r = t.setdefault(kind, {}).setdefault(bucket(dur), {"member": 0, "other": 0, "unsure": 0})
            r[verdict(sims, th)] += 1
        out[th] = t
    return out


def enroll_fake(cond: tuple, seed: int) -> Registry:
    """등록도 같은 방·같은 소음에서 한다 (회의 시작 직전 그 자리에서 5초씩)."""
    room, _, snr = cond
    reg = Registry(Path(tempfile.mkdtemp()) / "speakers.json")
    for l in (VOICE / "scenarios" / "enroll.txt").read_text().splitlines():
        who, text = (x.strip() for x in l.split(":", 1))
        a = say(text, PITCH[who])
        a = place(a, DIST[who], list(PITCH).index(who)) if room else a
        reg.enroll(who, finish(np.concatenate([np.zeros(SR // 2, np.float32), a]), snr, seed + 7))
    return reg


def fake_timeline(overlap: bool) -> list[dict]:
    lines = []
    for name in SCRIPTS:
        lines += [tuple(x.strip() for x in l.split(":", 1)) for l in (VOICE / "scenarios" / f"{name}.txt").read_text().splitlines() if ":" in l]
    rng, rov = random.Random(0), random.Random(1)  # 틈은 겹침 여부와 상관없이 같게
    turns, end = [], 0.5
    for i, (who, text) in enumerate(lines):
        a = say(text, PITCH[who])
        gap = rng.choice([0.3, 0.5, 0.7, 0.9, 1.2, 2.0])
        if overlap and i and rov.random() < 0.25 and turns[-1]["speaker"] != who:
            gap = -0.6  # 앞사람 말 끝 0.6초를 덮고 시작
        t0 = end + gap
        turns.append({"speaker": who, "t0": t0, "t1": t0 + len(a) / SR, "text": text, "audio": a})
        end = t0 + len(a) / SR
        if overlap and len(a) / SR > 3 and rov.random() < 0.3:  # 맞장구가 말 중간에 겹친다
            other = rov.choice([m for m in MEMBERS if m != who])
            text_b = rov.choice(BACKCHANNELS)
            b = say(text_b, PITCH[other])
            bt = t0 + len(a) / SR * 0.6
            turns.append({"speaker": other, "t0": bt, "t1": bt + len(b) / SR, "text": text_b, "audio": b, "back": True})
    return sorted(turns, key=lambda u: u["t0"])


def render(turns: list[dict], room: bool) -> np.ndarray:
    out = np.zeros(int((max(u["t1"] for u in turns) + 2.5) * SR), np.float32)
    for u in turns:
        a = place(u["audio"], DIST[u["speaker"]], list(PITCH).index(u["speaker"])) if room else u["audio"]
        s = int(u["t0"] * SR)
        out[s : s + len(a)] += a[: len(out) - s]
    return out


def fake_measure(turns, segs, reg) -> dict:
    main = [u for u in turns if not u.get("back")]
    r = {"마디": len(segs)}
    hyp = " ".join(s["text"] for s in segs)
    r["CER"] = round(cer(" ".join(u["text"] for u in turns), hyp), 4)
    r["CER(맞장구 빼고)"] = round(cer(" ".join(u["text"] for u in main), hyp), 4)
    # 말 끝: 한 사람 말의 마지막 마디가 조용해졌다고 본 때 - 실제 끝 (울림 꼬리 때문에 늦을 수 있다)
    errs, split, missed = [], 0, 0
    for u in main:
        hit = [s for s in segs if ov(s["t0"], s["t1"], u["t0"], u["t1"]) >= 0.2]
        if not hit:
            missed += 1
            continue
        split += len(hit) > 1
        errs.append((hit[-1]["quiet_from"] - u["t1"]) * 1000)
    merged = sum(1 for s in segs if len({u["speaker"] for u in main if ov(s["t0"], s["t1"], u["t0"], u["t1"]) >= 0.3}) >= 2)
    ghost = [s for s in segs if all(ov(s["t0"], s["t1"], u["t0"], u["t1"]) < 0.1 for u in turns)]
    r["말 끝"] = {
        "늦음ms 중앙": round(statistics.median(errs)), "p90": round(float(np.percentile(errs, 90))),
        "한 말이 쪼개짐": split, "두 사람이 한 마디로": merged, "놓친 말": missed, "잡음 마디": len(ghost), "사람 말": len(main),
    }
    # 화자: 마디마다 가장 오래 겹친 사람이 정답. 둘째 사람도 0.5초 넘게 겹치면 "섞임"으로 뺀다
    rows, mixed, short = [], 0, 0
    for s in segs:
        by: dict[str, float] = {}
        for u in turns:
            by[u["speaker"]] = by.get(u["speaker"], 0) + ov(s["t0"], s["t1"], u["t0"], u["t1"])
        top = sorted(by.items(), key=lambda x: -x[1])
        s["truth"] = None
        if top[0][1] < 0.1:
            continue
        if len(top) > 1 and top[1][1] >= 0.5:
            mixed += 1
            continue
        s["truth"] = top[0][0]
        v = embed(s["audio"])
        s["sims"] = None if v is None else {k: float(v @ e) for k, e in reg.voices.items()}
        if v is None:
            short += 1
        else:
            rows.append((s["truth"], s["sims"]))
    spk = {}
    for th in SPK_TH:
        t = {"맞음": 0, "다른 사람으로": 0, "모름": 0, "민수에 이름": 0, "민수 모름": 0}
        for who, sims in rows:
            best = max(sims, key=sims.get)
            named = best if sims[best] >= th else None
            if who in MEMBERS:
                t["맞음" if named == who else "다른 사람으로" if named else "모름"] += 1
            else:
                t["민수에 이름" if named else "민수 모름"] += 1
        spk[th] = t
    r["화자"] = {"등록자 마디": sum(1 for s in segs if s["truth"] in MEMBERS), "1초 미만(화자 없음)": short, "섞임(뺌)": mixed, "임계별": spk}
    return r


def fake_barge(turns, segs, reg) -> list[tuple]:
    """final.barge 시험 재료: 등록 4명은 member, 민수·잡음 마디는 outsider. 한 명씩 빼고 등록한 경우도 (그 사람이 outsider)."""
    items = []
    for s in segs:
        dur = s["t1"] - s["t0"]
        if all(ov(s["t0"], s["t1"], u["t0"], u["t1"]) < 0.1 for u in turns):
            v = embed(s["audio"])
            items.append(("잡음", dur, None if v is None else {k: float(v @ e) for k, e in reg.voices.items()}))
        elif s["truth"] in MEMBERS:
            items.append(("member", dur, s["sims"]))
            items.append(("outsider(팀원 한 명 빼고 등록)", dur, s["sims"] and {k: v for k, v in s["sims"].items() if k != s["truth"]}))
        elif s["truth"]:
            items.append(("outsider(민수)", dur, s["sims"]))
    return items


def barge_detect(turns, starts) -> dict:
    """사람 말 시작을 0.5초 안에 잡나, 사람 말이 없는데 start가 나나(미티가 말하는 중이면 잡음이 미티를 끊는다)."""
    main = [u for u in turns if not u.get("back")]
    caught = sum(1 for u in main if any(u["t0"] - 0.2 <= t <= u["t0"] + 0.5 for t in starts))
    false = sum(1 for t in starts if all(not (u["t0"] - 0.3 <= t <= u["t1"] + 0.6) for u in turns))
    mins = (max(u["t1"] for u in turns) + 2.5) / 60
    return {"사람 말 시작 잡음": f"{caught}/{len(main)}", "말 없는데 start(분당)": round(false / mins, 2)}


def run_fake() -> dict:
    res = {}
    transcribe(np.zeros(SR, np.float32))
    names = ", ".join(MEMBERS)
    for name, cond in CONDS.items():
        room, overlap, snr = cond
        turns = fake_timeline(overlap)
        audio = finish(render(turns, room), snr, 3)
        sf.write(str(ROOM / f"fake-{name}.wav"), audio, SR)
        reg = enroll_fake(cond, 3)
        r = {"길이(초)": round(len(audio) / SR, 1), "vad": {}}
        for th, ms in VADS:
            starts, segs = segment(audio, th, ms)
            for s in segs:
                s["text"] = transcribe(s["audio"], hint(names))
            m = fake_measure(turns, segs, reg)
            m["끊기 감지"] = barge_detect(turns, starts)
            r["vad"][f"{th}/{ms}"] = m
            if (th, ms) == VADS[0]:
                r["final.barge"] = barge_rows(fake_barge(turns, segs, reg))
                r["texts"] = [{"t0": round(s["t0"], 2), "text": s["text"]} for s in segs]
            print(f"[fake {name} {th}/{ms}] {json.dumps({k: v for k, v in m.items() if k != '화자'}, ensure_ascii=False)} 화자0.75 {m['화자']['임계별'][0.75]} 짧음 {m['화자']['1초 미만(화자 없음)']} 섞임 {m['화자']['섞임(뺌)']}", flush=True)
        starts, _ = segment(audio, BARGE_VAD, VADS[0][1])
        r["끊기 감지 0.8"] = barge_detect(turns, starts)
        print(f"  미티 말하는 중(VAD 0.8) 끊기 감지 {r['끊기 감지 0.8']}", flush=True)
        res[name] = r
    return res


def run_real() -> dict:
    audio0 = sf.read(str(MENTORING), dtype="float32", frames=END * SR)[0]
    md = MD.read_text()
    ref = reference(md)
    bl = blocks(md, len(audio0) / SR)
    res = {}
    transcribe(np.zeros(SR, np.float32))
    conds = {"원본(줌)": (False, None), "2m·울림": (True, None), "2m·울림+카페20": (True, 20), "2m·울림+카페10": (True, 10)}
    for name, (room, snr) in conds.items():
        audio = finish(place(audio0, 2.0, 11)[: len(audio0)], snr, 5) if room else audio0
        audio = np.concatenate([audio, np.zeros(SR, np.float32)])
        sf.write(str(ROOM / f"real-{name}-2min.wav"), audio[: 120 * SR], SR)
        _, segs = segment(audio, *VADS[0])
        for s in segs:
            s["text"] = transcribe(s["audio"], hint("기헌, 태은, 지호"))
        r = {"마디": len(segs), "CER": round(cer(ref, " ".join(s["text"] for s in segs)), 4)}
        r["전사 경계를 넘는 마디"] = sum(1 for s in segs if any(s["t0"] + 0.3 < b["t0"] < s["t1"] - 0.3 for b in bl))
        # 화자: real_voice.py와 같게 사람마다 앞 10초로 등록, 나머지 시험
        lab = [(s, label(s, bl)[0]) for s in segs]
        reg, used = Registry(Path(tempfile.mkdtemp()) / "speakers.json"), set()
        for who in ("멘토", "기헌"):
            acc, got = [], 0.0
            for i, (s, w) in enumerate(lab):
                if w == who and got < 10:
                    acc.append(s["audio"]), used.add(i)
                    got += s["t1"] - s["t0"]
            reg.enroll(who, np.concatenate(acc)[: int(15 * SR)])
        tests, short, items = [], 0, []
        for i, (s, w) in enumerate(lab):
            if not w or i in used:
                continue
            v = embed(s["audio"])
            sims = None if v is None else {k: float(v @ e) for k, e in reg.voices.items()}
            if sims is None:
                short += 1
            else:
                tests.append((w, sims))
            dur = s["t1"] - s["t0"]
            items.append(("member", dur, sims))
            items.append(("outsider(한 명 빼고 등록)", dur, sims and {k: x for k, x in sims.items() if k != w}))
        spk = {}
        for th in SPK_TH:
            t = {"맞음": 0, "다른 사람으로": 0, "모름": 0}
            for w, sims in tests:
                best = max(sims, key=sims.get)
                t["맞음" if sims[best] >= th and best == w else "다른 사람으로" if sims[best] >= th else "모름"] += 1
            spk[th] = t
        r["화자"] = {"시험 마디": len(tests), "1초 미만": short, "임계별": spk}
        r["final.barge"] = barge_rows(items)
        res[name] = r
        print(f"[real {name}] 마디 {len(segs)} CER {r['CER']} 경계넘음 {r['전사 경계를 넘는 마디']} 화자 {spk} 짧음 {short}", flush=True)
    return res


def main():
    ROOM.mkdir(parents=True, exist_ok=True)
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    res = json.loads(OUT.read_text()) if OUT.exists() else {}
    if which in ("fake", "all"):
        res["fake"] = run_fake()
        OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str))
    if which in ("real", "all"):
        res["real"] = run_real()
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str))
    print(f"\n→ {OUT}")


if __name__ == "__main__":
    main()
