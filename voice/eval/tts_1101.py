"""미티 목소리 다시 고르기 (11/1, 기헌 "느리고 어눌하고 축 처진 느낌" → 또렷하고 조금 빠르고 밝은 '야무진 팀원').

  ~/.cache/meety/venvs/mlx/bin/python voice/eval/tts_1101.py qwen        # Sohee 말투 지시 바꾸기·VoiceDesign 여·남 (첫 소리 = 스트리밍 첫 들리는 조각)
  voice/.venv/bin/python voice/eval/tts_1101.py rest                     # 속도 1.1·1.2배(ffmpeg atempo, 높낮이 그대로)·Supertonic 여·남·되짚기·표
  voice/.venv/bin/python voice/eval/tts_1101.py video                    # 휴대폰으로 한 번에 듣는 mp4
→ voice/recordings/tts-compare/1101/ (git 제외). 앱 기본 목소리는 바꾸지 않는다.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

VOICE = Path(__file__).resolve().parent.parent
OUT = VOICE / "recordings" / "tts-compare" / "1101"
LINES = ["잠깐만요, 지난주 회의에서는 웹 중심으로 가기로 정했어요. 그대로 갈까요?",
         "아이디어 하나 드려도 될까요? 기준 세 개로 두 안을 점수 매겨 보면 어떨까요?",
         "네, 좋아요. 제가 자료 찾아서 바로 보여 드릴게요."]
NOW_STYLE = "회의에 같이 앉은 20대 한국인 팀원처럼 차분하고 자연스러운 대화체로"
CUSTOM = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
DESIGN = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit"
# (이름, 설명, 모델, 방식, 말투/목소리 지시)
QWEN = [
    ("q0-now", "지금 목소리: Sohee + 지금 말투(차분하고 자연스러운 대화체)", CUSTOM, "custom", NOW_STYLE),
    ("q1-bright", "Sohee + 밝고 또렷하게, 조금 빠르게, 자신 있게", CUSTOM, "custom", "밝고 또렷하게, 조금 빠르게, 자신 있게 말해요. 회의에서 야무지게 의견을 내는 20대 팀원처럼."),
    ("q2-crisp", "Sohee + 차분하지만 또렷하게, 빠르게", CUSTOM, "custom", "차분하지만 또렷하게, 빠르고 분명한 발음으로 말해요."),
    ("q3-lively", "Sohee + 활기차고 친근하게, 빠른 말씨", CUSTOM, "custom", "활기차고 친근하게, 말끝을 흐리지 말고 빠른 말씨로 또박또박 말해요."),
    ("q4-design-f", "VoiceDesign 여성: 밝고 또렷한 20대 팀원", DESIGN, "design", "20대 중반 한국인 여성. 밝고 또렷하며 자신감 있는 목소리, 말씨가 조금 빠르고 발음이 분명한 야무진 회사 팀원. 서울말."),
    ("q5-design-m", "VoiceDesign 남성: 밝고 또렷한 20대 팀원", DESIGN, "design", "20대 중반 한국인 남성. 밝고 또렷하며 자신감 있는 목소리, 말씨가 조금 빠르고 발음이 분명한 야무진 회사 팀원. 서울말."),
]


def results() -> dict:
    p = OUT / "results.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save(new: dict):
    r = results()
    r.update(new)
    (OUT / "results.json").write_text(json.dumps(r, ensure_ascii=False, indent=1))


def qwen():
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    OUT.mkdir(parents=True, exist_ok=True)
    loaded = {}
    for name, desc, repo, how, instruct in QWEN:
        if repo not in loaded:
            loaded.clear()
            loaded[repo] = load_model(repo)
        m = loaded[repo]

        def gen(text):
            if how == "custom":
                return m.generate_custom_voice(text=text, speaker="sohee", language="korean", instruct=instruct, stream=True, streaming_interval=0.32)
            return m.generate_voice_design(text=text, language="korean", instruct=instruct, stream=True, streaming_interval=0.32)

        for _ in gen("네."):  # 데우기
            pass
        rows = []
        for i, line in enumerate(LINES, 1):
            t, got, chunks = time.monotonic(), [], []
            for r in gen(line):
                chunks.append(np.array(r.audio, dtype=np.float32).ravel())
                got.append((time.monotonic() - t, sum(len(c) for c in chunks)))
            total = time.monotonic() - t
            a = np.concatenate(chunks)
            w = 240
            f = np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1) + 1e-12)
            on = np.where(f > f.max() * 0.03)[0]
            k = int(on[0] * w) if len(on) else 0
            a = a[max(0, k - 720) : (on[-1] + 1) * w + 3600 if len(on) else len(a)]  # 앞 30ms·뒤 150ms만 (앱도 이렇게 다듬는다)
            sf.write(str(OUT / f"{name}-{i}.wav"), a, 24000)
            first = next((tt for tt, n in got if n > k), total)
            rows.append({"file": f"{name}-{i}.wav", "first_ms": round(first * 1000), "sec": round(len(a) / 24000, 2), "rtf": round(total / (len(a) / 24000), 2)})
            print(name, i, rows[-1], flush=True)
        save({name: {"desc": desc, "rows": rows}})


def rest():
    import numpy as np
    import soundfile as sf

    sys.path.insert(0, str(VOICE))
    import tts.config as config
    from tts import supertonic

    # 2) 지금 목소리를 1.1·1.2배로 (ffmpeg atempo — 높낮이는 그대로, 길이만 줄임)
    base = results()["q0-now"]
    for sp in (1.1, 1.2):
        name = f"q0-now-x{sp}"
        rows = []
        for i, x in enumerate(base["rows"], 1):
            out = OUT / f"{name}-{i}.wav"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(OUT / x["file"]), "-af", f"atempo={sp}", str(out)], check=True)
            rows.append({"file": out.name, "first_ms": x["first_ms"], "sec": round(sf.info(str(out)).duration, 2), "rtf": round(x["rtf"] * sp, 2)})
        save({name: {"desc": f"지금 목소리 + 재생 속도 {sp}배 (높낮이 그대로)", "rows": rows}})
    # 4) Supertonic 비교: 여성 F1·남성 M1, 8단계 (앱 다듬기와 같게 앞뒤 무음 자름)
    config.SUPERTONIC_MODEL, config.SUPERTONIC_STEPS = "supertonic-3", 8
    for v, desc in (("F1", "Supertonic-3 여성 F1 (8단계, 예전 기본)"), ("M1", "Supertonic-3 남성 M1 (8단계)")):
        supertonic.synth("네.", OUT / "_w.wav", v)
        rows = []
        for i, line in enumerate(LINES, 1):
            out = OUT / f"st-{v}-{i}.wav"
            t = time.monotonic()
            supertonic.synth(line, out, v)
            ms = round((time.monotonic() - t) * 1000)
            from tts import tidy

            tidy(out, level=False)
            rows.append({"file": out.name, "first_ms": ms, "sec": round(sf.info(str(out)).duration, 2), "rtf": None})
        save({f"st-{v}": {"desc": desc, "rows": rows}})
    (OUT / "_w.wav").unlink(missing_ok=True)
    check()


def check():
    """whisper로 되짚어 대사와 다른 곳을 적는다."""
    import difflib
    import re

    sys.path.insert(0, str(VOICE))
    import numpy as np

    from replay import cer
    from segmenter import transcribe
    from tts_compare import to16k

    norm = lambda s: re.sub(r"[\s\W]", "", s)  # noqa: E731
    transcribe(np.zeros(16000, np.float32))
    r = results()
    for k, v in r.items():
        for i, x in enumerate(v["rows"]):
            heard = transcribe(np.concatenate([to16k(OUT / x["file"]), np.zeros(8000, np.float32)]))
            x["heard"], x["cer"] = heard, round(cer(LINES[i], heard), 3)
            a, b = norm(LINES[i]), norm(heard)
            x["diff"] = [f"{a[i1:i2]}→{b[j1:j2]}" for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes() if op != "equal"]
        print(k, [x["cer"] for x in v["rows"]], [x["diff"] for x in v["rows"]], flush=True)
    (OUT / "results.json").write_text(json.dumps(r, ensure_ascii=False, indent=1))


CARD = """
import sys
from PIL import Image, ImageDraw, ImageFont
out, title, sub = sys.argv[1:4]
f = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
im = Image.new("RGB", (1280, 720), (15, 61, 58))
d = ImageDraw.Draw(im)
lines = sub.split("\\n")
items = [(title, 110 if len(lines) > 1 else 130, (255, 255, 255))] + [(l, 40 if i == 0 else 30, (208, 240, 236) if i == 0 else (170, 210, 205)) for i, l in enumerate(lines)]
y = 120 if len(lines) > 1 else 230
for text, size, color in items:
    ft = ImageFont.truetype(f, size)
    w = d.textlength(text, font=ft)
    d.text(((1280 - w) / 2, y), text, font=ft, fill=color)
    y += size + (60 if size > 100 else 22)
im.save(out)
"""
# ffmpeg에 글자 그리기(drawtext)가 없고 음성 서버 venv엔 Pillow가 없어, Pillow가 있는 venv로 그린다
PIL_PY = VOICE / "cache" / "venvs" / "xtts" / "bin" / "python"


def card(png: Path, title: str, sub: str):
    subprocess.run([str(PIL_PY), "-c", CARD, str(png), title, sub], check=True)


ORDER = ["q0-now", "q1-bright", "q2-crisp", "q3-lively", "q0-now-x1.1", "q0-now-x1.2", "q4-design-f", "q5-design-m", "st-F1", "st-M1"]


def video():
    """후보마다 "후보 N: 설명" 화면 + 세 문장(사이 0.6초) → mp4 하나. 정지 화면이라 작다."""
    import numpy as np
    import soundfile as sf

    r = results()
    parts = []
    for n, k in enumerate([k for k in ORDER if k in r], 1):
        v = r[k]
        segs = [np.zeros(int(0.8 * 24000), np.float32)]
        for x in v["rows"]:
            a, sr = sf.read(str(OUT / x["file"]), dtype="float32", always_2d=True)
            a = a.mean(axis=1)
            if sr != 24000:
                a = np.interp(np.arange(0, len(a), sr / 24000), np.arange(len(a)), a).astype(np.float32)
            segs += [a, np.zeros(int(0.6 * 24000), np.float32)]
        segs.append(np.zeros(int(0.6 * 24000), np.float32))
        wav = OUT / f"_v{n}.wav"
        sf.write(str(wav), np.concatenate(segs), 24000)
        png = OUT / f"_v{n}.png"
        card(png, f"후보 {n}", v["desc"])
        mp4 = OUT / f"_v{n}.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "5", "-i", str(png), "-i", str(wav), "-shortest",
                        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "5", "-c:a", "aac", "-b:a", "96k", str(mp4)], check=True)
        parts.append(mp4)
    lst = OUT / "_list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    final = OUT / "미티-목소리-후보-1101.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(final)], check=True)
    for p in parts + [lst] + list(OUT.glob("_v*.wav")) + list(OUT.glob("_v*.png")):
        p.unlink(missing_ok=True)
    print(final, round(final.stat().st_size / 1e6, 1), "MB")


if __name__ == "__main__":
    {"qwen": qwen, "rest": rest, "video": video, "check": check}[sys.argv[1]]()
