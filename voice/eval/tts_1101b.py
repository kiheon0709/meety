"""11/1 미티 목소리 '고정판' — 같은 후보 안에서 문장마다 말투·속도가 흔들린다(기헌: 8번은 두 문장 속도 차이가 큼, 3번도 다름).

  ~/.cache/meety/venvs/mlx/bin/python voice/eval/tts_1101b.py gen     # 무작위성 낮추기(온도·씨앗 고정) + 기준 녹음 복제(Qwen3 Base)
  voice/.venv/bin/python voice/eval/tts_1101b.py rest                  # 6번 1.2배, 되짚기, 문장별 빠르기 표, 후보마다 mp4(받아쓰기로 소리·화면 맞나 확인)
→ voice/recordings/tts-compare/1101b/ (git 제외). 앱 기본값은 그대로.
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

VOICE = Path(__file__).resolve().parent.parent
OUT = VOICE / "recordings" / "tts-compare" / "1101b"
PREV = VOICE / "recordings" / "tts-compare" / "1101"
sys.path.insert(0, str(VOICE / "eval"))
from tts_1101 import LINES, NOW_STYLE, QWEN, card  # noqa: E402

CUSTOM = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
BASE = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"
STYLE = {k: v[4] for k, v in ((q[0], q) for q in QWEN)}
TEMP, TOP_K, SEED = 0.5, 20, 7  # 모델 기본 0.9·50 → 낮춰서 문장마다 덜 흔들리게, 씨앗은 문장마다 같은 값으로
# (이름, 설명, 방식, 인자). 복제 기준 = 지난번 만든 것 중 빠르기가 가운데이고 잘못 읽은 데 없는 문장
CANDS = [
    ("c2", "후보 2 고정: Sohee + 밝고 또렷하게, 조금 빠르게 (온도 0.5·씨앗 고정)", "custom", {"instruct": STYLE["q1-bright"]}),
    ("c2-clone", "후보 2 복제: 후보 2의 한 문장을 기준 녹음으로 복제", "clone", {"ref": PREV / "q1-bright-2.wav", "ref_text": LINES[1]}),
    ("c3", "후보 3 고정: Sohee + 차분하지만 또렷하게, 빠르게 (온도 0.5·씨앗 고정)", "custom", {"instruct": STYLE["q2-crisp"]}),
    ("c3-clone", "후보 3 복제: 후보 3의 한 문장을 기준 녹음으로 복제", "clone", {"ref": PREV / "q2-crisp-1.wav", "ref_text": LINES[0]}),
    ("c6-raw", "(6번 재료) Sohee + 지금 말투, 온도 0.5·씨앗 고정", "custom", {"instruct": NOW_STYLE}),
    ("c8", "후보 8 고정: VoiceDesign 남성 한 문장을 기준 녹음으로 복제", "clone", {"ref": PREV / "q5-design-m-2.wav", "ref_text": LINES[1]}),
]
SHOW = [("c2", 2), ("c2-clone", 2), ("c3", 3), ("c3-clone", 3), ("c6", 6), ("c8", 8)]


def norm(s):
    return re.sub(r"[\s\W]", "", s)


def results():
    p = OUT / "results.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save(new):
    r = results()
    r.update(new)
    (OUT / "results.json").write_text(json.dumps(r, ensure_ascii=False, indent=1))


def speech(a, sr):
    """앞뒤 무음을 자른 (소리, 앞 무음 샘플 수). 앱 다듬기와 같게 앞 30ms·뒤 150ms 남김."""
    import numpy as np

    w = sr // 100
    f = np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1) + 1e-12)
    on = np.where(f > f.max() * 0.03)[0]
    if not len(on):
        return a, 0
    k = on[0] * w
    return a[max(0, k - int(0.03 * sr)) : (on[-1] + 1) * w + int(0.15 * sr)], k


def gen():
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    OUT.mkdir(parents=True, exist_ok=True)
    models = {}
    for name, desc, how, kw in CANDS:
        repo = CUSTOM if how == "custom" else BASE
        if repo not in models:
            models.clear()
            models[repo] = load_model(repo)
        m = models[repo]

        def run(text):
            mx.random.seed(SEED)
            if how == "custom":
                return m.generate_custom_voice(text=text, speaker="sohee", language="korean", instruct=kw["instruct"], temperature=TEMP, top_k=TOP_K,
                                               stream=True, streaming_interval=0.32)
            return m.generate(text=text, ref_audio=str(kw["ref"]), ref_text=kw["ref_text"], lang_code="korean", temperature=TEMP, top_k=TOP_K,
                              stream=True, streaming_interval=0.32)

        for _ in run("네."):
            pass
        rows = []
        for i, line in enumerate(LINES, 1):
            t, got, chunks = time.monotonic(), [], []
            for r in run(line):
                chunks.append(np.array(r.audio, dtype=np.float32).ravel())
                got.append((time.monotonic() - t, sum(len(c) for c in chunks)))
            a = np.concatenate(chunks)
            s, k = speech(a, 24000)
            first = next((tt for tt, n in got if n > k), time.monotonic() - t)
            sf.write(str(OUT / f"{name}-{i}.wav"), s, 24000)
            rows.append({"file": f"{name}-{i}.wav", "first_ms": round(first * 1000), "sec": round(len(s) / 24000, 2)})
            print(name, i, rows[-1], flush=True)
        save({name: {"desc": desc, "rows": rows}})


def rest():
    import numpy as np
    import soundfile as sf

    sys.path.insert(0, str(VOICE))
    from replay import cer
    from segmenter import transcribe
    from tts_compare import to16k

    r = results()
    # 6번: 고정한 지금 목소리를 1.2배 (atempo, 높낮이 그대로)
    rows = []
    for i, x in enumerate(r["c6-raw"]["rows"], 1):
        out = OUT / f"c6-{i}.wav"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(OUT / x["file"]), "-af", "atempo=1.2", str(out)], check=True)
        rows.append({"file": out.name, "first_ms": x["first_ms"], "sec": round(sf.info(str(out)).duration, 2)})
    r["c6"] = {"desc": "후보 6 고정: 지금 목소리(온도 0.5·씨앗 고정) + 재생 속도 1.2배", "rows": rows}
    transcribe(np.zeros(16000, np.float32))
    for k, v in r.items():
        for i, x in enumerate(v["rows"]):
            x["rate"] = round(len(norm(LINES[i])) / x["sec"], 2)
            x["heard"] = transcribe(np.concatenate([to16k(OUT / x["file"]), np.zeros(8000, np.float32)]))
            x["cer"] = round(cer(LINES[i], x["heard"]), 3)
        rates = [x["rate"] for x in v["rows"]]
        v["rate_spread"] = round((max(rates) - min(rates)) / (sum(rates) / len(rates)) * 100, 1)
        # 쉼을 뺀 말 속도: 소리가 나는 10ms 틀만 센다 (문장 3 "네, 좋아요. 제가…"처럼 쉼이 많은 문장이 느려 보이지 않게)
        for i, x in enumerate(v["rows"]):
            a, sr = sf.read(str(OUT / x["file"]), dtype="float32")
            w = sr // 100
            f = np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1) + 1e-12)
            x["artic"] = round(len(norm(LINES[i])) / (np.sum(f > f.max() * 0.05) / 100), 2)
        ar = [x["artic"] for x in v["rows"]]
        v["artic_spread"] = round((max(ar) - min(ar)) / (sum(ar) / len(ar)) * 100, 1)
    (OUT / "results.json").write_text(json.dumps(r, ensure_ascii=False, indent=1))
    # 후보마다 mp4: 화면 = 후보 번호·설명·세 문장, 소리 = 세 문장(사이 0.7초). 만든 뒤 mp4 소리를 다시 받아써 화면 문장과 맞나 본다
    for key, num in SHOW:
        v = r[key]
        segs = [np.zeros(int(0.8 * 24000), np.float32)]
        for x in v["rows"]:
            a, sr = sf.read(str(OUT / x["file"]), dtype="float32")
            segs += [a, np.zeros(int(0.7 * 24000), np.float32)]
        wav = OUT / f"_{key}.wav"
        sf.write(str(wav), np.concatenate(segs), 24000)
        dur = sf.info(str(wav)).duration
        png = OUT / f"_{key}.png"
        card(png, f"후보 {num}" + (" (복제)" if "clone" in key else ""), v["desc"] + "\n" + "\n".join(f"{i}. {l}" for i, l in enumerate(LINES, 1)))
        mp4 = OUT / f"미티-후보{num}{'-복제' if 'clone' in key else ''}.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "5", "-i", str(png), "-i", str(wav), "-t", f"{dur:.2f}",
                        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "5", "-c:a", "aac", "-b:a", "128k", str(mp4)], check=True)
        # 확인: mp4에서 소리를 다시 뽑아 받아쓰기 → 세 문장과 비교
        chk = OUT / "_chk.wav"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(mp4), "-ac", "1", "-ar", "16000", str(chk)], check=True)
        a = sf.read(str(chk), dtype="float32")[0]
        heard = transcribe(a)
        v["mp4"] = mp4.name
        v["mp4_cer"] = round(cer(" ".join(LINES), heard), 3)
        v["mp4_sec"] = round(dur, 1)
        print(mp4.name, "소리-화면 대조 CER", v["mp4_cer"], "|", heard[:80], flush=True)
        for p in (wav, png, chk):
            p.unlink(missing_ok=True)
    (OUT / "results.json").write_text(json.dumps(r, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    {"gen": gen, "rest": rest}[sys.argv[1]]()
