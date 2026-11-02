// "화자: 발화" 줄 단위 전사본 파서. 화자 없는 줄은 직전 화자에 이어 붙인다.
export interface ParsedUtterance {
  idx: number;
  speaker: string;
  text: string;
}

export function parseTranscript(raw: string): ParsedUtterance[] {
  const out: ParsedUtterance[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
    if (m) {
      out.push({ idx: out.length + 1, speaker: m[1].trim(), text: m[2].trim() });
    } else if (out.length) {
      out[out.length - 1].text += " " + t;
    } else {
      out.push({ idx: 1, speaker: "?", text: t });
    }
  }
  return out;
}

export function speakersOf(utts: ParsedUtterance[]): string[] {
  return [...new Set(utts.map((u) => u.speaker))];
}
