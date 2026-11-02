"""맞장구·생각 소리 고르기: 같은 말을 문장부호·띄어쓰기만 바꿔 몇 벌 구워(지금 기본 목소리, 짧은 말 다듬기 포함) 비교한다.

사용: voice/.venv/bin/python voice/eval/backchannels.py
  → voice/recordings/tts-compare/backchannels/*.wav, results.json, 그리고 voice/recordings/tts-compare/index.html 아래쪽 "맞장구" 표
자동으로 고르는 기준(사람 귀 대신 어림): 다시 받아쓰면 그 말로 들리고(글자 차이 1/3 이하, "음"류는 거의 비어 나오고), 길이 0.25~0.9초
(4글자 넘으면 1.2초), 끝이 올라가지 않는 것
(물음 맞장구 "아, 그거요?"는 예외). 기본으로 쓸 글자는 voice/tts/config.py BACKCHANNELS — 기헌이 페이지에서 듣고 바꾼다.
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
import tts  # noqa: E402
from segmenter import transcribe  # noqa: E402
from partial_stability import edit  # noqa: E402
from tts_compare import to16k  # noqa: E402

OUT = VOICE / "recordings" / "tts-compare" / "backchannels"
# 말 → 벌 (같은 말을 억양 다르게 읽히려고 문장부호·띄어쓰기만 바꿈)
VARIANTS = {
    "음": ["음", "음.", "흠", "음~"],
    "음…": ["음…", "음...", "으음", "으음…"],
    "아 네": ["아 네", "아, 네.", "아~ 네", "아네"],
    "네네": ["네네", "네, 네.", "네네.", "네 네"],
    "맞아요": ["맞아요", "맞아요.", "맞아요!", "맞아요~"],
    "그렇죠": ["그렇죠", "그렇죠.", "그쵸", "그쵸."],
    "아 그거요": ["아 그거요", "아, 그거요.", "아, 그거요?", "아~ 그거요"],
    "음, 잠깐만요": ["음, 잠깐만요.", "음… 잠깐만요.", "음 잠깐만요", "음, 잠깐만요?"],
    "아하": ["아하", "아하.", "아~ 하", "아하!"],
    "오, 좋네요": ["오, 좋네요.", "오 좋네요", "오~ 좋네요", "오, 좋네요!"],
}
QUESTION = {"아 그거요"}
HUMS = {"음", "음…"}  # 받아쓰기가 비거나 "음"으로 나오면 맞음


def end_rise(a: np.ndarray, sr: int = 16000) -> float | None:
    import librosa

    f0, _, _ = librosa.pyin(a, fmin=70, fmax=500, sr=sr, frame_length=1024)
    f0 = f0[~np.isnan(f0)]
    if len(f0) < 6:
        return None
    k = max(2, len(f0) // 3)
    return round(float(12 * np.log2(np.median(f0[-k:]) / np.median(f0[:k]))), 1)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tts.synth("네.")
    transcribe(np.zeros(16000, np.float32))
    res = []
    for item, vs in VARIANTS.items():
        rows = []
        for i, v in enumerate(vs):
            src = tts.synth(v)  # 캐시에 다듬어진 채로 남는다 (서버와 같은 파일)
            p = OUT / f"{len(res):02d}-{i}.wav"
            p.write_bytes(src.read_bytes())
            a = to16k(p)
            heard = transcribe(a, None) if len(a) > 0.3 * 16000 else ""
            want = re.sub(r"[\s\W~]", "", item)
            got = re.sub(r"[\s\W~]", "", heard)
            ok = (got in ("", "음", "흠", "으음")) if item in HUMS else edit(want, got) <= max(1, len(want) // 3)
            rows.append({"text": v, "file": p.name, "sec": round(len(a) / 16000, 2), "heard": heard, "ok": bool(ok), "rise": end_rise(a)})
        longest = 1.2 if len(re.sub(r"[\s\W~]", "", item)) >= 4 else 0.9
        good = [r for r in rows if r["ok"] and 0.25 <= r["sec"] <= longest and (item in QUESTION or (r["rise"] is None or r["rise"] < 2))]
        pick = (good or rows)[0]["text"]
        res.append({"item": item, "pick": pick, "rows": rows})
        print(item, "→", pick, [(r["text"], r["sec"], r["heard"], r["rise"]) for r in rows], flush=True)
    (OUT / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    page(res)


def page(res: list[dict]):
    """tts_voices.py가 만든 index.html 아래에 맞장구 표를 넣는다 (다시 돌리면 그 부분만 바꾼다). 점수는 같은 [점수 복사]로 나간다."""
    import html

    path = OUT.parent / "index.html"
    if not path.exists():
        return
    rows = []
    for r in res:
        cells = []
        for x in r["rows"]:
            mark = " ★" if x["text"] == r["pick"] else ""
            stars = "".join(f'<label><input type="radio" name="bc:{html.escape(x["text"])}" value="{k}">{k}</label>' for k in range(1, 6))
            cells.append(f'<td><b>{html.escape(x["text"])}{mark}</b><br><audio controls preload="none" src="backchannels/{x["file"]}"></audio>'
                         f'<div class="ms">{x["sec"]}초 · 들림 "{html.escape(x["heard"])}"</div><div class="score">{stars}</div></td>')
        rows.append(f"<tr><th>{html.escape(r['item'])}</th>{''.join(cells)}</tr>")
    sec = (f'<!--bc--><h2>맞장구·생각 소리 (지금 기본 목소리, 앞뒤 무음 다듬고 크기 맞춤)</h2>'
           f'<p>같은 말을 문장부호·띄어쓰기만 바꿔 읽혔어요. ★가 지금 기본(자동으로 고른 것: 다시 받아써도 그 말로 들리고 길이 알맞고 끝이 안 올라감). '
           f'제일 사람 같은 것에 점수를 주면 [점수 복사]에 같이 나와요.</p>'
           f'<div class="wrap"><table><tbody>{"".join(rows)}</tbody></table></div><!--/bc-->')
    h = path.read_text()
    h = re.sub(r"<!--bc-->.*<!--/bc-->", "", h, flags=re.S)
    h = h.replace("<script>", sec + "\n<script>", 1)
    path.write_text(h)


if __name__ == "__main__":
    main()
