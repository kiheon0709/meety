"""Qwen3-TTS가 자주 나오는 낱말을 잘못 읽나 ("회의"→"페이"). 작업자(tts_worker.py)를 직접 불러 조건별로 3번씩 만들고 whisper로 되짚는다.

사용: (작업자가 떠 있을 때) voice/.venv/bin/python voice/eval/qwen_misread.py → voice/recordings/qwen_misread.json
"""

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
from segmenter import transcribe  # noqa: E402

WORDS = [("회의", "회의 내용 정리 화면, 기존 갈피 화면이죠?"), ("미티", "미티가 먼저 정리해 볼게요."), ("갈피", "갈피에서 지난 회의 기록을 찾아볼게요."),
         ("결정", "그건 지난주에 결정한 내용이에요."), ("리허설", "리허설은 일요일 저녁에 해요."), ("디스코드", "디스코드 알림은 다음 단계로 미뤄요."),
         ("시연", "시연 영상은 회의 장면부터 보여 줘요."), ("안건", "오늘 안건은 세 개예요."), ("담당", "담당은 지호 님이 맡기로 했어요."), ("기록", "기록엔 없지만 제 생각은 이래요.")]
CONDS = {"지금(말투 지시)": {}, "말투 지시 없음": {"instruct": ""}, "말투 지시 + 온도 0.3": {"temperature": 0.3}}


def say(text, kw):
    r = urllib.request.Request("http://127.0.0.1:8790/stream", data=json.dumps({"text": text, **kw}).encode(), headers={"content-type": "application/json"}, method="POST")
    b = urllib.request.urlopen(r, timeout=60).read()
    a = np.frombuffer(b[: len(b) // 2 * 2], dtype="<i2").astype(np.float32) / 32767
    return np.interp(np.arange(0, len(a), 1.5), np.arange(len(a)), a).astype(np.float32)  # 24k → 16k


def main():
    transcribe(np.zeros(16000, np.float32))
    res = {}
    for name, kw in CONDS.items():
        miss = []
        for w, sent in WORDS:
            for k in range(3):
                heard = transcribe(say(sent, kw))
                if w not in heard.replace(" ", ""):
                    miss.append({"word": w, "heard": heard})
        res[name] = {"miss": len(miss), "of": len(WORDS) * 3, "examples": miss}
        print(name, f"{len(miss)}/{len(WORDS) * 3} 놓침", [(m["word"], m["heard"]) for m in miss], flush=True)
    (VOICE / "recordings" / "qwen_misread.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
