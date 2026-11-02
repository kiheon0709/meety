// 미티 자막 줄나눔: 한 줄 16자(라틴·숫자·공백·문장부호 0.5자), 최대 2줄, 어절 경계, 2줄이면 아래가 긴 피라미드형.
// 두 줄로도 넘치는 문장은 여러 장으로 (Netflix 한국어 자막 지침, docs/architecture/live-screen-design.md §1-4)
const LINE = 16;
const half = (ch: string) => ch.charCodeAt(0) < 0x80 || /[ -⁯　-〿！-／]/.test(ch);
export const widthOf = (s: string) => [...s].reduce((w, ch) => w + (half(ch) ? 0.5 : 1), 0);

type Tok = { t: string; glue: boolean }; // glue: 앞 토큰에 띄어쓰기 없이 붙는다 (16자 넘는 낱말을 자른 조각)
const join = (ts: Tok[]) => ts.map((x, i) => (i && !x.glue ? " " : "") + x.t).join("");

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  for (const w of s.trim().split(/\s+/).filter(Boolean)) {
    let cur = "";
    let first = true;
    for (const ch of w) {
      if (widthOf(cur + ch) > LINE) {
        out.push({ t: cur, glue: !first });
        cur = "";
        first = false;
      }
      cur += ch;
    }
    out.push({ t: cur, glue: !first });
  }
  return out;
}

// 두 줄짜리 한 장을 다시 나눈다: 둘 다 16자 안, 아래가 같거나 길게, 그중 차이가 가장 작게
function balance(ts: Tok[]): string[] {
  let best: { k: number; score: number } | null = null;
  for (let k = 1; k < ts.length; k++) {
    const a = widthOf(join(ts.slice(0, k)));
    const b = widthOf(join(ts.slice(k)));
    if (a > LINE || b > LINE) continue;
    // 낱말 중간(잘린 조각 사이)은 띄어쓰기 자리가 없을 때만
    const score = (ts[k].glue ? 1000 : 0) + (b >= a ? 0 : 100) + Math.abs(b - a);
    if (!best || score < best.score) best = { k, score };
  }
  return best ? [join(ts.slice(0, best.k)), join(ts.slice(best.k))] : [join(ts)];
}

export function pagesOf(sentence: string): string[][] {
  const ts = tokens(sentence);
  if (!ts.length) return [];
  // 욕심껏 줄을 채우고 두 줄씩 한 장으로
  const lines: Tok[][] = [];
  for (const x of ts) {
    const cur = lines.at(-1);
    if (cur && widthOf(join([...cur, x])) <= LINE) cur.push(x);
    else lines.push([x]);
  }
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const page = lines.slice(i, i + 2);
    pages.push(page.length === 1 ? [join(page[0])] : balance(page.flat()));
  }
  return pages;
}
