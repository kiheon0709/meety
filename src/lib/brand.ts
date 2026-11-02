// 서비스 이름·한 줄은 여기서만 바꾼다. 화면에 보이는 이름은 미티 하나 (기헌 10/31: 갈피는 화면에서 뺀다, docs/architecture/uiux-redesign.md §1)
export const BRAND = {
  name: "미티",
  tagline: "회의에 같이 앉는 팀원",
  // 가치 한 줄 자리 — 기헌이 쓴 문장으로 바꾼다 (uiux-redesign.md §7). 그때까지는 이름과 한 줄 소개만
  headline: "회의에 같이 앉는 팀원, 미티",
  description: "미티는 회의에 같이 앉아 듣고, 지난 결정과 어긋나면 짚고, 끝나면 무엇이 무엇으로 바뀌었는지 정리해요.",
} as const;
