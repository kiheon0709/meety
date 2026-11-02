// 에이전트가 쓴 이유 문장에 섞여 나오는 내부 표기(노드 id, 영어 상태값)를 화면용 우리말로 바꾼다.
// 예: "이미 agreed 상태인 결정(n37)을 뒤집는 변경이다." → "이미 합의된 결정을 뒤집는 변경이다."
const WORDS: [RegExp, string][] = [
  [/\bagreed\s*상태(인|의)?/g, "합의된"],
  [/\bagreed\b/g, "합의된"],
  [/\bproposed\b/g, "제안된"],
  [/\bsuperseded\b/g, "바뀐"],
  [/\bwithdrawn\b/g, "철회된"],
  [/\badopted\b/g, "채택된"],
  [/\brejected\b/g, "기각된"],
  [/\bresolved\b/g, "해결된"],
  [/\bbroken\b/g, "깨진"],
  [/\bsupersede\b/g, "대체"],
  [/\bwithdraw\b/g, "철회"],
  [/\bdecision\b/g, "결정"],
  [/\bclaim\b/g, "의견"],
  [/\bquestion\b/g, "안건"],
  [/\baction\b/g, "할 일"],
  [/\bassumption\b/g, "전제"],
];

export function plain(s: string | null | undefined): string {
  if (!s) return "";
  let t = s
    .replace(/\s*\(\s*n\d+(?:\s*[,·/]\s*n\d+)*\s*\)/g, "") // "(n37)", "(n3, n4)"
    .replace(/\s*\bn\d+\b\s*/g, " "); // 괄호 없이 나온 id
  for (const [re, ko] of WORDS) t = t.replace(re, ko);
  return t.replace(/\s{2,}/g, " ").replace(/\s+([.,])/g, "$1").trim();
}
