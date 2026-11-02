// 한글 음절의 중성(모음)을 입 모양 aa ih ou ee oh(VRM 이름 규약)로. 소리 크기에 곱해서 쓴다 (설계서 §3-1).
// 지금 마스코트는 입이 없어서 이 값의 합을 몸이 들썩이는 크기로 쓴다
export type Mouth = Partial<Record<"aa" | "ih" | "ou" | "ee" | "oh", number>>;

// 중성 순서: ㅏ ㅐ ㅑ ㅒ ㅓ ㅔ ㅕ ㅖ ㅗ ㅘ ㅙ ㅚ ㅛ ㅜ ㅝ ㅞ ㅟ ㅠ ㅡ ㅢ ㅣ
const JUNG: Mouth[] = [
  { aa: 1 }, { ee: 1 }, { aa: 1 }, { ee: 1 }, { aa: 0.6, oh: 0.4 }, { ee: 1 }, { aa: 0.6, oh: 0.4 }, { ee: 1 },
  { oh: 1 }, { aa: 1 }, { ee: 1 }, { ee: 1 }, { oh: 1 }, { ou: 1 }, { aa: 0.6, oh: 0.4 }, { ee: 1 },
  { ih: 1 }, { ou: 1 }, { ih: 1 }, { ih: 1 }, { ih: 1 },
];

export function visemeOf(ch: string): Mouth {
  const c = ch.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return JUNG[Math.floor(((c - 0xac00) % 588) / 28)];
  if (/[A-Za-z0-9]/.test(ch)) return { aa: 0.5 };
  return {};
}

// 음절은 1, 그 밖(공백·문장부호)은 0.5 길이로 문장 소리 길이를 나눠 t초의 입 모양
export function mouthAt(sentence: string, duration: number, t: number): Mouth {
  const chars = [...sentence];
  const w = chars.map((ch) => (/[가-힣A-Za-z0-9]/.test(ch) ? 1 : 0.5));
  const total = w.reduce((a, b) => a + b, 0);
  if (!total || t < 0 || t >= duration) return {};
  let at = (t / duration) * total;
  for (let i = 0; i < chars.length; i++) {
    if (at < w[i]) return visemeOf(chars[i]);
    at -= w[i];
  }
  return {};
}
