"""사람 말 끝 → final (포스터 "말 끝 → 음성 인식 확정"): replay.py가 남긴 이벤트에서, 정답(turns.json)의 말마다 그 말 끝(t1)을 덮는 첫 final이
도착한 오디오 시각 − t1. 같은 방법으로 10/31 기헌 1:1 8마디가 908ms(침묵 500ms) → 632ms(Smart Turn 0.8)였다 (S2 보고서).

사용: voice/.venv/bin/python voice/eval/end_to_final.py 정답.turns.json a.events.jsonl [b.events.jsonl …]
"""

import json
import statistics
import sys


def main():
    turns = json.load(open(sys.argv[1]))
    for f in sys.argv[2:]:
        ev = [json.loads(line) for line in open(f)]
        ends = {e["id"]: e for e in ev if e["type"] == "speech_end"}
        fin = [e for e in ev if e["type"] == "final" and e.get("text", "").strip()]
        se, sf, tot = [], [], []
        for u in turns:
            c = [x for x in fin if x["t0"] < u["t1"] and x["t1"] >= u["t1"] - 0.6]  # 이 말 끝 근처에서 끝난 마디
            if not c:
                print("  final 없음:", u["text"])
                continue
            x = c[0]
            tot.append((x["audio"] - u["t1"]) * 1000)
            if x["id"] in ends:
                se.append((ends[x["id"]]["audio"] - u["t1"]) * 1000)
                sf.append((x["audio"] - ends[x["id"]]["audio"]) * 1000)
        print(f"{f}: 말 {len(tot)}개 · 말 끝→speech_end 중앙 {statistics.median(se):.0f} · speech_end→final {statistics.median(sf):.0f} · "
              f"말 끝→final 중앙 {statistics.median(tot):.0f}ms (범위 {min(tot):.0f}~{max(tot):.0f}) {[round(t) for t in tot]}")


if __name__ == "__main__":
    main()
