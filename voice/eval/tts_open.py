"""오픈소스 새 목소리 후보를 이 맥(M3 Max)에서 직접 돌려 같은 대사 4개로 비교한다 (기헌 "오픈소스에도 자연스러운 목소리 많은데").

후보마다 따로 venv에서 돈다 (지금 음성 서버 환경을 건드리지 않으려고):
  voice/cache/venvs/mlx/bin/python voice/eval/tts_open.py run qwen3-0.6b-sohee qwen3-1.7b-sohee …   # mlx-audio 후보
  voice/.venv/bin/python voice/eval/tts_open.py supertonic                                            # 비교 기준: 지금 기본
  voice/.venv/bin/python voice/eval/tts_open.py page                                                              # 비교 페이지 맨 위 "오픈소스 새 후보" 칸
→ voice/recordings/tts-compare/open/{후보}-{n}.wav, open/results.json. 모델은 HF 캐시(~/.cache/huggingface)에 — 저장소엔 안 올린다.
첫 소리 = 생성 시작 → 첫 소리 조각 (스트리밍), 합성 시간 = 문장을 다 만든 시간, RTF = 합성 시간 / 소리 길이, 메모리 = 그 후보의 최대 사용(맥 통합 메모리).
"""

import html
import json
import re
import sys
import time
from pathlib import Path

VOICE = Path(__file__).resolve().parent.parent
OUT = VOICE / "recordings" / "tts-compare" / "open"
PAGE = OUT.parent / "index.html"
LINES = ["회의 내용 정리 화면, 기존 갈피 화면이죠?", "음… 제 생각엔 화면부터 정하는 게 먼저일 것 같아요.", "아 네, 맞아요.", "기록엔 없는데, 촬영은 일요일 오전이 어때요?"]
STYLE = "회의에 같이 앉은 20대 한국인 팀원처럼 차분하고 자연스러운 대화체로"

# 이름: (설명, 라이선스, 모델, 방식, 인자)
QWEN = "Qwen3-TTS (알리바바, Apache-2.0)"
CANDS = {
    "qwen3-0.6b-sohee": ("Qwen3-TTS 0.6B · Sohee(한국어 여성 프리셋)", QWEN, "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", "custom", {"speaker": "sohee"}),
    "qwen3-1.7b-sohee": ("Qwen3-TTS 1.7B · Sohee + 말투 지시", QWEN, "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "custom", {"speaker": "sohee", "instruct": STYLE}),
    "qwen3-1.7b-design-f": ("Qwen3-TTS 1.7B VoiceDesign · 여성(글로 만든 목소리)", QWEN, "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit", "design",
                            {"instruct": "20대 후반 한국인 여성. 차분하고 따뜻한 목소리, 회의에서 말하듯 자연스러운 서울말 대화체."}),
    "qwen3-1.7b-design-m": ("Qwen3-TTS 1.7B VoiceDesign · 남성(글로 만든 목소리)", QWEN, "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit", "design",
                            {"instruct": "20대 후반 한국인 남성. 부드럽고 낮은 목소리, 회의에서 말하듯 자연스러운 서울말 대화체."}),
    # 범용 generate(): 목소리 복제 기준 소리는 지금 Supertonic F1 문장(합성 목소리라 동의 문제 없음) — 한국어 여성. 남성은 M1
    "fish-s2pro-f": ("Fish Audio S2 Pro · 여성(Supertonic F1 목소리 복제)", "Fish Audio Research License — **비상업만**", "mlx-community/fish-audio-s2-pro", "gen",
                     {"ref": "supertonic3-F1-2.wav", "ref_array": True}),
    "fish-s2pro-m": ("Fish Audio S2 Pro · 남성(Supertonic M1 목소리 복제)", "Fish Audio Research License — **비상업만**", "mlx-community/fish-audio-s2-pro", "gen",
                     {"ref": "supertonic3-M1-2.wav", "ref_array": True}),
    "voxcpm2-f": ("VoxCPM2 2B · 여성(글로 만든 목소리)", "Apache-2.0", "mlx-community/VoxCPM2-8bit", "gen", {"instruct": "A Korean woman in her late twenties, calm and warm conversational voice"}),
    "voxcpm2-m": ("VoxCPM2 2B · 남성(글로 만든 목소리)", "Apache-2.0", "mlx-community/VoxCPM2-8bit", "gen", {"instruct": "A Korean man in his late twenties, soft and low conversational voice"}),
    "chatterbox-ml-f": ("Chatterbox 다국어 · 여성(Supertonic F1 목소리 복제)", "MIT", "mlx-community/chatterbox-8bit", "gen", {"ref": "supertonic3-F1-2.wav", "lang_code": "ko"}),
}


def run(names: list[str]):
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    OUT.mkdir(parents=True, exist_ok=True)
    for name in names:
        desc, lic, repo, how, kw = CANDS[name]
        t = time.monotonic()
        model = load_model(repo)
        load_s = time.monotonic() - t
        mx.reset_peak_memory()

        def gen(text, stream):
            if how == "custom":
                return model.generate_custom_voice(text=text, language="korean", stream=stream, streaming_interval=0.32, **kw)
            if how == "design":
                return model.generate_voice_design(text=text, language="korean", stream=stream, streaming_interval=0.32, **kw)
            import inspect

            args = {k: v for k, v in kw.items() if k not in ("ref", "ref_array")}
            if "ref" in kw:
                ref = str(OUT / kw["ref"])
                if kw.get("ref_array"):  # Fish는 경로가 아니라 그 모델 샘플레이트의 소리 배열을 받는다
                    x, xsr = sf.read(ref, dtype="float32")
                    msr = getattr(model, "sample_rate", xsr)
                    ref = mx.array(np.interp(np.arange(0, len(x), xsr / msr), np.arange(len(x)), x).astype(np.float32))
                args.update(ref_audio=ref, ref_text=LINES[1])
            args.update(stream=stream, streaming_interval=0.32)
            ps = inspect.signature(model.generate).parameters
            if not any(p.kind == p.VAR_KEYWORD for p in ps.values()):
                args = {k: v for k, v in args.items() if k in ps}  # 그 모델이 안 받는 인자(스트리밍 등)는 뺀다
            return model.generate(text=text, **args)

        for _ in gen("네.", False):  # 데우기
            pass
        rows = []
        for i, line in enumerate(LINES, 1):
            t = time.monotonic()
            got, chunks, sr = [], [], 24000
            for r in gen(line, True):
                chunks.append(np.array(r.audio, dtype=np.float32).ravel())
                got.append((time.monotonic() - t, sum(len(c) for c in chunks)))
                sr = getattr(r, "sample_rate", sr) or sr
            total = time.monotonic() - t
            a = np.concatenate(chunks) if chunks else np.zeros(1, np.float32)
            f = f"{name}-{i}.wav"
            sf.write(str(OUT / f), a, sr)
            rows.append({"file": f, **timing(a, sr, got, total)})
            print(name, i, rows[-1], flush=True)
        save_results({name: {"desc": desc, "license": lic, "model": repo, "load_s": round(load_s, 1), "peak_gb": round(mx.get_peak_memory() / 1e9, 2), "rows": rows}})
        del model


def onset(a, sr) -> int:
    """처음 들리는 소리(10ms 틀이 가장 큰 틀의 3%를 넘는 곳)의 샘플 위치. 모델이 앞에 무음을 붙이는 일이 많다."""
    import numpy as np

    w = sr // 100
    f = np.sqrt(np.mean(a[: len(a) // w * w].reshape(-1, w) ** 2, axis=1) + 1e-12)
    on = np.where(f > f.max() * 0.03)[0]
    return int(on[0] * w) if len(on) else 0


def timing(a, sr, got, total) -> dict:
    """got: [(받은 때 초, 그때까지 샘플 수)]. 첫 소리 = 처음 들리는 소리가 든 조각을 받은 때."""
    k = onset(a, sr)
    first = next((t for t, n in got if n > k), total)
    return {"first_chunk_ms": round(got[0][0] * 1000) if got else None, "first_ms": round(first * 1000), "lead_s": round(k / sr, 2),
            "total_ms": round(total * 1000), "sec": round(len(a) / sr, 2), "rtf": round(total / max(len(a) / sr, 1e-3), 2)}


def supertonic():
    import time as _t

    sys.path.insert(0, str(VOICE))
    import soundfile as sf

    import tts.config as config
    from tts import supertonic as st

    OUT.mkdir(parents=True, exist_ok=True)
    config.SUPERTONIC_MODEL, config.SUPERTONIC_STEPS = "supertonic-3", 8
    st._tts = None
    res = {}
    for v in ("F1", "M1"):
        st.synth("네.", OUT / "_w.wav", v)
        rows = []
        for i, line in enumerate(LINES, 1):
            f = f"supertonic3-{v}-{i}.wav"
            t = _t.monotonic()
            st.synth(line, OUT / f, v)
            total = _t.monotonic() - t
            a, sr = sf.read(str(OUT / f), dtype="float32")
            rows.append({"file": f, **timing(a, sr, [(total, len(a))], total)})
        res[f"supertonic3-{v}"] = {"desc": f"지금 기본: Supertonic-3 {v} 8단계" if v == "F1" else f"Supertonic-3 {v} 8단계 (남성)", "license": "코드 MIT, 모델 OpenRAIL-M",
                                   "model": "Supertone/supertonic-3", "load_s": None, "peak_gb": None, "rows": rows}
    (OUT / "_w.wav").unlink(missing_ok=True)
    save_results(res)


def check():
    """만든 소리를 whisper로 다시 받아써 대사와 글자 차이(CER)를 적는다 — 잘못 읽은 것("오전이었대요") 찾기. 지금 음성 서버 venv에서."""
    sys.path.insert(0, str(VOICE))
    import numpy as np

    from replay import cer
    from segmenter import transcribe
    from tts_compare import to16k

    transcribe(np.zeros(16000, np.float32))
    res = load_results()
    for k, r in res.items():
        for i, x in enumerate(r["rows"]):
            if "heard" not in x:
                x["heard"] = transcribe(to16k(OUT / x["file"]))
                x["cer"] = round(cer(LINES[i], x["heard"]), 3)
        print(k, [x["cer"] for x in r["rows"]], [x["heard"] for x in r["rows"]], flush=True)
    save_results(res)


def load_results() -> dict:
    p = OUT / "results.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save_results(new: dict):
    """파일을 다시 읽어 합친다 — 후보마다 다른 프로세스(다른 venv)가 차례로 쓴다."""
    res = load_results()
    res.update(new)
    (OUT / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))


SKIPPED: list[tuple[str, str]] = []  # (후보, 왜 못 했나) — page()가 표 아래에 적는다. 채우는 곳: 아래 SKIP


def page():
    res = load_results()
    order = [k for k in res if k.startswith("supertonic")] + [k for k in res if not k.startswith("supertonic")]
    heads = "".join(f"<th>{html.escape(l)}</th>" for l in LINES)
    rows = []
    for k in order:
        r = res[k]
        cells = "".join(f'<td><audio controls preload="none" src="open/{x["file"]}"></audio><div class="ms">첫 소리 {x["first_ms"]}ms (앞 무음 {x["lead_s"]}초) · RTF {x["rtf"]}{f' · 들림 "{html.escape(x["heard"])}"' if x.get("heard") is not None else ""}</div></td>' for x in r["rows"])
        stars = "".join(f'<label><input type="radio" name="open:{k}" value="{s}">{s}</label>' for s in range(1, 6))
        mem = f" · 메모리 {r['peak_gb']}GB" if r.get("peak_gb") else ""
        rows.append(f'<tr><th>{html.escape(r["desc"])}<div class="id">{html.escape(r["license"])}{mem}</div></th>{cells}<td class="score">{stars}</td></tr>')
    skipped = "".join(f"<li><b>{html.escape(a)}</b>: {html.escape(b)}</li>" for a, b in SKIP)
    sec = (f'<!--open--><h2>오픈소스 새 후보 (이 맥에서 직접 돌림, 10/31)</h2><p>맨 위 두 줄이 지금 쓰는 Supertonic이에요. 같은 대사 4개, 첫 소리는 스트리밍으로 첫 조각까지 걸린 시간이에요(Supertonic은 다 만들어야 나가서 합성 시간과 같음).</p>'
           f'<div class="wrap"><table><thead><tr><th>목소리</th>{heads}<th>자연스러움</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
           f'<p>못 돌린 후보</p><ul>{skipped}</ul><!--/open-->')
    h = PAGE.read_text()
    h = re.sub(r"<!--open-->.*<!--/open-->", "", h, flags=re.S)
    h = h.replace('<div class="wrap">', sec + '\n<div class="wrap">', 1)
    PAGE.write_text(h)
    print(f"→ {PAGE}")


SKIP = [
    ("XTTS-v2 (Coqui)", "프로그램은 깔려 있음(voice/cache/venvs/xtts). 모델을 받으려면 Coqui 공개 모델 라이선스(CPML, 비상업만) 동의가 필요 — 기헌 결정"),
    ("CosyVoice3 / CosyVoice2", "mlx-audio에 없음. GitHub 코드 + 옛 라이브러리 묶음 설치가 이 세션 권한에서 막힘(10/31 낮에 시도) — 기헌이 허용하면 따로 venv로"),
    ("MeloTTS-Korean", "mlx-audio엔 영어 MeloTTS만 있음. PyPI melotts는 설치 파일이 깨져 있음(10/30)"),
    ("F5-TTS 한국어 파인튠", "공식 한국어 모델이 없고 개인이 올린 파인튠뿐 — 이번엔 뺌"),
    ("Zonos · Higgs Audio v2 · OmniVoice", "mlx-audio에 있으나 한국어 확인이 안 됐거나(Zonos2·Higgs) 쓰는 법이 달라(OmniVoice) 시간 순서상 뒤로 — 위 후보 뒤에 시간 되면"),
]

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "run":
        run(sys.argv[2:])
    elif cmd == "supertonic":
        supertonic()
    elif cmd == "check":
        check()
    else:
        page()
