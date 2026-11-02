"""온디바이스 실시간 받아쓰기 후보: sherpa-onnx 한국어 스트리밍 zipformer(k2-fsa 2024-06-16, Apache-2.0, CPU).

사용: voice/cache/venvs/sherpa/bin/python voice/eval/stt_sherpa.py 녹음.wav 출력.events.jsonl [말끝 침묵초=0.5]
0.1초씩 실시간처럼 넣고(계산이 실시간보다 빠르면 기다림 없이), 우리 서버와 같은 꼴의 이벤트를 남긴다:
  speech_start(첫 글자가 보인 때) · partial{text} · final{t0,t1,text} — "audio"는 그 이벤트가 나간 오디오 시계(초) + 실제 계산이 밀린 만큼.
말 끝은 sherpa 끝점 규칙(말한 뒤 침묵 N초)으로 — 음성 서버의 silero·Smart Turn과 다른 자체 판단이다.
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf

MODEL = Path.home() / ".cache/huggingface/hub/models--k2-fsa--sherpa-onnx-streaming-zipformer-korean-2024-06-16/snapshots"


def recognizer(silence: float):
    d = next(MODEL.iterdir())
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(d / "tokens.txt"), encoder=str(d / "encoder-epoch-99-avg-1.int8.onnx"), decoder=str(d / "decoder-epoch-99-avg-1.int8.onnx"),
        joiner=str(d / "joiner-epoch-99-avg-1.int8.onnx"), num_threads=2, sample_rate=16000, feature_dim=80, decoding_method="greedy_search",
        enable_endpoint_detection=True, rule1_min_trailing_silence=2.4, rule2_min_trailing_silence=silence, rule3_min_utterance_length=20)


def main():
    wav, out = sys.argv[1], Path(sys.argv[2])
    silence = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    a, sr = sf.read(wav, dtype="float32")
    a = np.concatenate([a, np.zeros(3 * sr, np.float32)])
    rec = recognizer(silence)
    s = rec.create_stream()
    ev, seg_id, last, lag, t_first = [], 0, "", 0.0, None
    step = sr // 10
    busy = 0.0
    for k in range(0, len(a), step):
        clock = (k + step) / sr
        t = time.monotonic()
        s.accept_waveform(sr, a[k : k + step])
        while rec.is_ready(s):
            rec.decode_stream(s)
        text = rec.get_result(s).strip()
        dt = time.monotonic() - t
        busy += dt
        lag = max(0.0, lag - 0.1) + dt  # 실시간이었다면 계산이 밀린 만큼
        at = round(clock + lag, 3)
        if text and text != last:
            if not last:
                seg_id += 1
                t_first = clock
                ev.append({"type": "speech_start", "id": seg_id, "t": round(clock, 2), "audio": at})
            ev.append({"type": "partial", "id": seg_id, "text": text, "audio": at})
            last = text
        if rec.is_endpoint(s):
            if last:
                ev.append({"type": "final", "id": seg_id, "t0": round(t_first - 0.5, 2), "t1": round(clock - silence, 2), "text": last, "audio": at})
            rec.reset(s)
            last = ""
    out.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in ev))
    print(f"{wav}: final {sum(e['type'] == 'final' for e in ev)}개, 계산 {busy:.1f}초 / 소리 {len(a) / sr:.1f}초 (RTF {busy / (len(a) / sr):.3f})")


if __name__ == "__main__":
    main()
