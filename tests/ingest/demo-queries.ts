// 시연 영상 콘티 v2(docs/presentation/demo-storyboard.md) 회의 1~3에서 나올 "…였지?" 질문 → 시연 자료 세트에서 찾아야 하는 사실.
// expect: 정답 사실 text 정규식(하나만 맞아도 정답). where: 정답이 있어야 할 문서. scene: 콘티 장면 번호(없으면 그 회의 안건에서 나올 법한 것).
export interface DemoQuery {
  meeting: 1 | 2 | 3;
  scene?: string;
  q: string;
  expect: string;
  where: string;
}

// 시연 자료 세트 (RUNBOOK 11절)
export const DEMO_DOCS = [
  "docs/plan/meety-plan.md",
  "docs/plan/DECISIONS-2026-10-30-pivot.md",
  "docs/멘토링-사전자료-2026-10-25.pdf",
  "docs/presentation/demo-storyboard.md",
  "docs/presentation/submission-guide.md",
];

export const DEMO_QUERIES: DemoQuery[] = [
  // 회의 1 — 발표 준비 계획 (제출물 일정)
  { meeting: 1, scene: "1-1", q: "제출 마감이 언제였지?", expect: "11/2|11월 2일", where: "meety-plan 13절" },
  { meeting: 1, scene: "1-1", q: "제출해야 되는 게 뭐뭐였지?", expect: "확인서|팀원구성|제출물", where: "submission-guide · meety-plan 13절" },
  { meeting: 1, scene: "1-2", q: "영상은 회의 장면이랑 정리 화면 중에 뭘 먼저 보여 주기로 했었지?", expect: "회의 장면을? 먼저", where: "demo-storyboard 1절(10/30 결정)" },
  { meeting: 1, q: "영상 길이 몇 분까지였지?", expect: "5분", where: "demo-storyboard 한눈에 · meety-plan 13절" },
  { meeting: 1, scene: "1-4", q: "포스터 초안 언제까지 만들기로 했지?", expect: "토요일 밤", where: "demo-storyboard 1-4(대사 초안)" },
  { meeting: 1, q: "포스터에 꼭 들어가야 하는 게 뭐였지?", expect: "지도교수", where: "meety-plan 13절" },
  { meeting: 1, q: "작품 부문은 뭐로 내기로 했었지?", expect: "실용성|작품부문", where: "meety-plan 13절" },
  // 회의 2 — 포스터 정하기·촬영 날짜
  { meeting: 2, scene: "2-1", q: "포스터 사이즈가 뭐였지? A2였나?", expect: "A1", where: "submission-guide" },
  { meeting: 2, scene: "2-2", q: "미티야 파일 이름 규칙도 있었지?", expect: "\\[포스터\\]팀명", where: "submission-guide" },
  { meeting: 2, q: "포스터 인쇄해서 내야 돼?", expect: "인쇄물", where: "submission-guide" },
  { meeting: 2, q: "포스터 JPG로도 내야 되나?", expect: "JPG", where: "submission-guide" },
  { meeting: 2, q: "보고서 낼 때 주의할 거 뭐였지?", expect: "사인|서명", where: "submission-guide" },
  { meeting: 2, q: "팀원구성 엑셀은 몇 부였더라", expect: "1부", where: "submission-guide" },
  { meeting: 2, scene: "2-3", q: "포스터 제목 2번 후보가 뭐였지?", expect: "대사로 시작", where: "demo-storyboard 2-3(대사 초안)" },
  { meeting: 2, scene: "2-5", q: "촬영 날짜 언제로 잡혀 있었지?", expect: "10/31|11/1", where: "demo-storyboard 한눈에" },
  { meeting: 2, q: "작년 행사 홈페이지 주소 뭐였지?", expect: "wixsite", where: "submission-guide" },
  { meeting: 2, q: "유튜브 영상은 조건이 뭐였더라", expect: "재생", where: "meety-plan 13절 · demo-storyboard 편집" },
  { meeting: 2, q: "멘토님 언제 오신다고 했지?", expect: "11월 7일|11/7", where: "(세트 밖: docs/plan/current-plan.md)" },
  // 회의 3 — 영상 마지막 장면 아이디어 (브레인스토밍)
  { meeting: 3, scene: "3-1", q: "마지막에 띄울 숫자 뭐뭐였지?", expect: "141|잘못 끼어든|약 2초", where: "demo-storyboard 6절" },
  { meeting: 3, q: "말 끝나고 미티가 말하기까지 몇 초였지?", expect: "1\\.8|2\\.2|약 2초|2초 안", where: "meety-plan 3·8절" },
  { meeting: 3, q: "보안 공격 몇 번 막았더라", expect: "141", where: "meety-plan 8절 · demo-storyboard 6절" },
  { meeting: 3, scene: "3-1", q: "브레인스토밍이면 다이얼 몇으로 하기로 했지?", expect: "다이얼 7|7로", where: "demo-storyboard 3절" },
  { meeting: 3, q: "회의 한 시간 비용 얼마였지?", expect: "0\\.80|0\\.8", where: "meety-plan 8절" },
  { meeting: 3, q: "미티 캐릭터 어떤 모양으로 하기로 했었지?", expect: "마스코트|눈 큰|둥글", where: "meety-plan 6·12절" },
  { meeting: 3, q: "마지막 장면 색 뭐로 맞추기로 했지?", expect: "6A3FD8|보라", where: "demo-storyboard 편집" },
];
