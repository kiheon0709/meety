"use client";

import { useState } from "react";

const SAMPLE = `기헌: 시연 영상은 누가 찍지?
준영: 제가 찍을게요. 토요일까지 녹음 화면 붙여놓고요.
태은: 발표 슬라이드 초안은 제가 할게요.
지호: 차별점 한 장이랑 경쟁 비교는 제가요.
기헌: 좋아. 그럼 발표 순서는 다음에 정하자. 안건으로 올려놔.`;

// 클로바노트 내보내기 형식("00:00 이름\n내용" 또는 "이름 00:00\n내용")도 "이름: 내용"으로 맞춘다.
function normalize(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let pendingSpeaker: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^[^:：]{1,20}[:：]\s*\S/.test(t)) {
      out.push(t);
      pendingSpeaker = null;
      continue;
    }
    const m = t.match(/^(?:\d{1,2}:\d{2}(?::\d{2})?\s+)?([^\s\d][^\s]{0,19})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
    if (m && t.length <= 30) {
      pendingSpeaker = m[1];
      continue;
    }
    if (pendingSpeaker) out.push(`${pendingSpeaker}: ${t}`);
    else out.push(t);
  }
  return out.join("\n");
}

export function TranscriptField() {
  const [v, setV] = useState("");
  const lines = v.split("\n").filter((l) => /^[^:：]{1,20}[:：]/.test(l.trim())).length;
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setV(normalize(text));
  };
  return (
    <label className="block">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-[12px] font-medium text-ink-2">
          녹취 — 한 줄에 한 사람 말, <code className="font-mono bg-black/6 px-1 rounded">이름: 내용</code>
        </span>
        <span className="flex items-center gap-3 text-[12px]">
          <label className="text-blue hover:underline underline-offset-4 cursor-pointer">
            파일 올리기 (.txt)
            <input type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <button type="button" onClick={() => setV(SAMPLE)} className="text-ink-3 hover:text-ink">
            예시 채우기
          </button>
        </span>
      </div>
      <textarea
        name="transcript"
        required
        rows={14}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={(e) => setV(normalize(e.target.value))}
        className="input mt-1 font-mono text-[13px] leading-relaxed"
        placeholder={"기헌: 오늘은 입구부터 정하자.\n지호: 저는 디스코드 봇이 주 입구여야 한다고 봐요.\n준영: 발표 전엔 웹이 현실적이에요."}
      />
      <div className="mt-1.5 text-[12px] text-ink-3">{lines > 0 ? `${lines}줄 읽음` : "클로바노트·줌에서 내보낸 텍스트를 그대로 붙여넣거나 파일로 올리세요. 형식은 알아서 맞춰요."}</div>
    </label>
  );
}
