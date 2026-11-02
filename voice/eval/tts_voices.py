"""미티 목소리 고르기: 같은 대사 3개를 이 맥에서 바로 도는 목소리 전부로 읽혀 듣기 페이지를 만든다 (기헌 1:1 시험 "목소리부터 별로" 뒤).

사용: voice/.venv/bin/python voice/eval/tts_voices.py
  → voice/recordings/tts-compare/voices/{후보}-{n}.wav, results.json, 그리고 듣고 점수 매기는 voice/recordings/tts-compare/index.html
"첫 소리까지" = 문장 하나를 다 만드는 시간 (어댑터가 다 만든 뒤 돌려준다), 모델을 데운 뒤. "알아듣기" = whisper로 다시 받아쓴 글자 차이.
자연스러움은 사람이 듣고 매긴다 — 페이지의 점수는 그 브라우저에만 남고 [점수 복사]로 꺼낸다.
"""

import html
import json
import statistics
import sys
import time
from pathlib import Path

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
import tts.config as config  # noqa: E402
from replay import cer  # noqa: E402
from segmenter import transcribe  # noqa: E402
from tts import say, supertonic  # noqa: E402
from tts_compare import setup_supertonic, to16k  # noqa: E402

PAGE = VOICE / "recordings" / "tts-compare" / "index.html"
OUT = PAGE.parent / "voices"
# 기헌 1:1 시험(10/31)에서 미티가 실제로 한 말·할 말
LINES = ["회의 내용 정리 화면, 기존 갈피 화면이죠?", "기록엔 없지만 제 생각엔 화면부터 정하는 게 먼저예요.", "네, 잠깐만요."]

# (이름, 설명, 어댑터, 목소리, 준비). 같은 목소리의 4단계(10/31 오후까지 기본)·8단계(지금 기본)를 나란히 — 째짐 차이 듣기
CANDIDATES = []
for v in ("F1", "F2", "M1"):
    CANDIDATES += [(f"supertonic3-{v}-4step", f"Supertonic-3 {v} · 4단계 (예전 기본)" if v == "F1" else f"Supertonic-3 {v} · 4단계", supertonic, v, setup_supertonic("supertonic-3", 4)),
                   (f"supertonic3-{v}", f"Supertonic-3 {v} · 8단계 (지금 기본)" if v == "F1" else f"Supertonic-3 {v} · 8단계", supertonic, v, setup_supertonic("supertonic-3", 8))]
    if v == "F1":
        CANDIDATES.append(("supertonic3-F1-16step", "Supertonic-3 F1 · 16단계", supertonic, "F1", setup_supertonic("supertonic-3", 16)))
CANDIDATES += [(f"supertonic3-{v}", f"Supertonic-3 {v} · 8단계", supertonic, v, setup_supertonic("supertonic-3", 8))
               for v in ("F3", "F4", "F5", "M2", "M3", "M4", "M5")]
CANDIDATES += [(f"supertonic2-{v}", f"Supertonic-2 {v} (가장 빠름)", supertonic, v, setup_supertonic("supertonic-2", 4)) for v in ("F1", "F3", "M1")]
CANDIDATES += [("say-Yuna", "맥 내장 Yuna", say, "Yuna", lambda: None)]

# 이 맥에서 아직 못 돈 후보: 사람이 정할 것이 남아 있다
PENDING = [
    ("XTTS-v2 (Coqui)", "한국어 됨, 목소리 복제. 설치는 끝남(voice/cache/venvs/xtts). 모델(1.9GB)을 받으려면 Coqui 공개 모델 라이선스(CPML, 비상업만) 동의가 필요 — 기헌 결정"),
    ("CosyVoice2-0.5B (알리바바)", "한국어 됨, Apache-2.0, 모델 약 5GB. GitHub 코드와 옛 라이브러리 묶음을 설치해야 하는데 이 세션에서 외부 코드 설치가 막혔다 — 기헌이 허용하면 따로 venv로"),
    ("ElevenLabs", "유료 API, 키 없음(자리만: voice/tts/elevenlabs.py). 문장이 회사 밖으로 나간다 — 기헌 결정"),
    ("OpenAI tts", "유료 API, 키 없음. 문장이 밖으로 나간다 — 기헌 결정"),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    transcribe(__import__("numpy").zeros(16000, "float32"))
    results = []
    for name, desc, mod, voice, prep in CANDIDATES:
        prep()
        mod.synth("네.", OUT / "_warm.wav", voice)  # 데우기
        ms, cers, files = [], [], []
        for i, line in enumerate(LINES, 1):
            p = OUT / f"{name}-{i}.wav"
            t = time.monotonic()
            mod.synth(line, p, voice)
            ms.append(round((time.monotonic() - t) * 1000))
            cers.append(round(cer(line, transcribe(to16k(p))), 3))
            files.append(p.name)
        results.append({"name": name, "desc": desc, "ms": ms, "cer": round(statistics.mean(cers), 3), "files": files})
        print(f"{name}: {ms} ms, CER {results[-1]['cer']}", flush=True)
    (OUT / "_warm.wav").unlink(missing_ok=True)
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    page(results)
    print(f"→ {PAGE}")


def page(results: list[dict]):
    rows = []
    for r in results:
        cells = "".join(f'<td><audio controls preload="none" src="voices/{f}"></audio><div class="ms">{m}ms</div></td>' for f, m in zip(r["files"], r["ms"]))
        stars = "".join(f'<label><input type="radio" name="{r["name"]}" value="{k}">{k}</label>' for k in range(1, 6))
        rows.append(f'<tr><th>{html.escape(r["desc"])}<div class="id">{r["name"]} · 알아듣기 CER {r["cer"]}</div></th>{cells}<td class="score">{stars}</td></tr>')
    pending = "".join(f"<tr><th>{html.escape(a)}</th><td colspan=4>{html.escape(b)}</td></tr>" for a, b in PENDING)
    heads = "".join(f"<th>{html.escape(l)}</th>" for l in LINES)
    PAGE.write_text(f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>미티 목소리 고르기</title>
<style>
:root{{--bg:#fff;--fg:#1d1f23;--mute:#6b7280;--line:#e5e7eb;--accent:#0f766e}}
@media (prefers-color-scheme:dark){{:root{{--bg:#16181c;--fg:#e8e8ea;--mute:#9aa0a8;--line:#2c2f36;--accent:#2dd4bf}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;margin:24px 16px}}
h1{{font-size:20px;margin:0 0 4px}} p{{color:var(--mute);margin:4px 0 16px}}
.wrap{{overflow-x:auto}} table{{border-collapse:collapse;min-width:900px}}
th,td{{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}}
thead th{{font-size:13px;color:var(--mute);font-weight:500}} tbody th{{font-weight:600;width:220px}}
.id,.ms{{font-size:12px;color:var(--mute);font-weight:400}} audio{{width:190px;height:32px}}
.score label{{margin-right:6px;font-size:13px}} button{{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer}}
h2{{font-size:16px;margin:28px 0 8px}} #out{{white-space:pre-wrap;font-size:13px;color:var(--mute)}}
</style></head><body>
<h1>미티 목소리 고르기</h1>
<p>같은 대사 세 개를 목소리마다 읽혔어요. 듣고 오른쪽에 자연스러움 1~5점을 매긴 뒤 [점수 복사]를 눌러 관리 세션에 붙여 주세요. 칸 아래 숫자는 그 문장을 만드는 데 걸린 시간(첫 소리까지)이에요.</p>
<button onclick="copyScores()">점수 복사</button> <span id="out"></span>
<div class="wrap"><table><thead><tr><th>목소리</th>{heads}<th>자연스러움</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<h2>아직 못 들어 본 후보 (사람이 정할 것이 남음)</h2>
<div class="wrap"><table><tbody>{pending}</tbody></table></div>
<script>
const KEY="meety-voice-scores";
let saved={{}};try{{saved=JSON.parse(localStorage.getItem(KEY)||"{{}}")}}catch(e){{}}
document.querySelectorAll('.score input').forEach(i=>{{if(saved[i.name]==i.value)i.checked=true;i.addEventListener('change',()=>{{saved[i.name]=i.value;try{{localStorage.setItem(KEY,JSON.stringify(saved))}}catch(e){{}}}})}});
document.querySelectorAll('audio').forEach(a=>a.addEventListener('play',()=>document.querySelectorAll('audio').forEach(b=>{{if(b!==a)b.pause()}})));
function copyScores(){{const t=Object.entries(saved).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+": "+v).join("\\n")||"(아직 점수 없음)";
navigator.clipboard.writeText(t).then(()=>{{document.getElementById('out').textContent="복사했어요:\\n"+t}},()=>{{document.getElementById('out').textContent=t}})}}
</script></body></html>""")


if __name__ == "__main__":
    main()
