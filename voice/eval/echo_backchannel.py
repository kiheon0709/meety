"""맞장구 재생 중 에코: 미티 맞장구가 스피커로 나가 마이크에 다시 들어올 때 받아쓰기에 사람 말로 들어가지 않나.

사용: (음성 서버를 켠 뒤) voice/.venv/bin/python voice/eval/echo_backchannel.py [포트]
맞장구마다 두 경우를 실제 서버 /ws에 1배속으로 흘린다. 화면과 똑같이 맞장구를 트는 동안 {"type":"tts","on":true,"text":맞장구}를 보낸다.
  에코만: 맞장구 소리가 스피커→마이크(0.12초 늦게, 방 울림 RT60 0.4초, 사람 말보다 6dB 작게)로만 들어옴 → barge_in·글자 있는 final이 없어야 함
  사람도: 같은 때 사람(맥 목소리, 0.6m)이 "그래서 다음 안건은요" 하고 말함 → barge_in이 나고 사람 말이 받아써져야 함
"""

import asyncio
import json
import sys
from pathlib import Path

import numpy as np
import websockets

VOICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE))
sys.path.insert(0, str(VOICE / "eval"))
import tts  # noqa: E402
from room_mix import place, say  # noqa: E402
from tts_compare import to16k  # noqa: E402

SR = 16000
HUMAN = "그래서 다음 안건은요, 리허설 시간을 다시 정해 봐요."


async def run(port: int, audio: np.ndarray, on: float, off: float, text: str) -> list[dict]:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    step, events = SR // 50, []
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws", max_size=None) as ws:
        async def rx():
            async for m in ws:
                events.append(json.loads(m))
        task = asyncio.create_task(rx())
        await ws.send(json.dumps({"type": "start", "save": False}))
        sent_on = sent_off = False
        t0 = asyncio.get_running_loop().time()
        for k in range(0, len(pcm), step):
            if not sent_on and k / SR >= on:
                await ws.send(json.dumps({"type": "tts", "on": True, "text": text}))
                sent_on = True
            if not sent_off and k / SR >= off:
                await ws.send(json.dumps({"type": "tts", "on": False}))
                sent_off = True
            await ws.send(pcm[k : k + step].tobytes())
            await asyncio.sleep(max(0, t0 + (k + step) / SR - asyncio.get_running_loop().time()))
        await asyncio.sleep(3)
        task.cancel()
    return events


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8773
    rows = []
    human = place(say(HUMAN, 1.0), 0.6, 0)
    for text in tts.config.BACKCHANNELS:
        bc = to16k(tts.synth(text))
        on, delay = 1.0, 0.12
        echo = place(bc, 1.0, 7) * 10 ** (-6 / 20)  # 스피커 → 마이크
        for case in ("에코만", "사람도"):
            a = np.zeros(int((on + delay + len(echo) / SR + (len(human) / SR if case == "사람도" else 0) + 2.5) * SR), np.float32)
            s = int((on + delay) * SR)
            a[s : s + len(echo)] += echo
            if case == "사람도":
                h = int((on + 0.2) * SR)
                a[h : h + len(human)] += human
            a += np.random.default_rng(1).normal(0, 0.0005, len(a)).astype(np.float32)
            ev = asyncio.run(run(port, a, on, on + len(bc) / SR, text))
            finals = [e for e in ev if e["type"] == "final"]
            rows.append({
                "맞장구": text, "경우": case,
                "barge_in": sum(e["type"] == "barge_in" for e in ev),
                "글자 있는 final": [f["text"] for f in finals if f.get("text")],
                "echo 표시 final": sum(bool(f.get("echo")) for f in finals),
            })
            print(rows[-1], flush=True)
    (VOICE / "recordings" / "echo_backchannel.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
