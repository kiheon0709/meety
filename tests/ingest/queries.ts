// 다음 회의에서 할 법한 질문·발언 30개 → docs/plan/current-plan.md에서 찾아야 하는 사실.
// expect: 정답 사실의 text에 맞는 정규식 (여러 개면 하나만 맞아도 정답). 다시 뽑아 말투가 조금 바뀌어도 맞게 넓게 잡는다. noisy: 받아쓰기 흔들림을 일부러 넣음.
export interface Query {
  q: string;
  expect: string[];
  conflict?: boolean; // 기획과 어긋나는 발언
  noisy?: boolean;
  miss?: string; // 낱말 검색으로는 못 찾는 걸 알고 있음 (이유)
}

// 사실은 tests/ingest/fixtures/current-plan.facts.json (2026-10-30 haiku, 지시문 v3로 뽑은 것) — 모델 없이 결정적으로 돈다.
export const FIXTURE = "tests/ingest/fixtures/current-plan.facts.json";

export const QUERIES: Query[] = [
  // 묻기·확인 (20)
  { q: "대회 제출 마감이 언제였지?", expect: ["11-02|11월 2일|11/2"] },
  { q: "대회 제출이 십일월 이일 맞나요", expect: ["11-02|11월 2일|11/2"], noisy: true },
  { q: "멘토님 언제 강의실에 오신다고 했지", expect: ["멘토"] },
  { q: "회의에 들어오는 에이전트 이름 뭐로 정했더라", expect: ["이름[은을]? 미티"] },
  { q: "미띠야 이거 기록에 있어?", expect: ["미티야"], noisy: true },
  { q: "강도 단계가 몇 개였죠", expect: ["세 단계"] },
  { q: "끼어 들기 강도 몇단계 였더라", expect: ["세 단계"], noisy: true },
  { q: "중간 강도는 몇 초 쉬면 말해?", expect: ["0.8초"] },
  { q: "강도를 하로 하면 미티가 어떻게 해요", expect: ["손만 (든다|들)"] },
  { q: "강도 올리려면 어떻게 해야 돼요", expect: ["올리는 (건|것은|것) 화면"] },
  { q: "로컬 모드면 데이터가 밖으로 안 나가는 거지?", expect: ["로컬 모드"] },
  { q: "우리 타겟이 누구였지", expect: ["서기도 PM도 없는 작은 팀"] },
  { q: "시연은 라이브로 해요 영상으로 해요", expect: ["시연은 영상"] },
  { q: "멘토링에서 수익 모델 얘기 나왔었지", expect: ["수익 모델"] },
  { q: "발표 첫 문장 어떻게 고치기로 했어", expect: ["발표 첫 문장"] },
  { q: "미티 목소리는 정했나요?", expect: ["미티 목소리"] },
  { q: "카톡 연동은 어떻게 돼 가요", expect: ["카톡 연동"] },
  { q: "음성 인식은 어디서 돌려요", expect: ["Whisper"] },
  { q: "젯슨 보드 쓰기로 했었나", expect: ["Jetson"], noisy: true },
  { q: "회의 끝나면 미티가 뭐 해 줘요", expect: ["체크리스트"] },
  // 기획과 어긋나는 발언 (10)
  { q: "끼어드는 강도는 다섯 단계로 나눌게요", expect: ["세 단계"], conflict: true },
  { q: "회의 내용은 써버로 다 올려서 처리하면 돼요", expect: ["로컬 모드"], conflict: true, noisy: true },
  { q: "미티가 기존 기록을 직접 고쳐 버리면 되잖아", expect: ["기록[은을]? 읽기만"], conflict: true },
  { q: "시연은 현장에서 라이브로 하자", expect: ["시연은 영상"], conflict: true },
  { q: "젯슨 박스에 올려서 돌리자", expect: ["Jetson"], conflict: true, noisy: true },
  { q: "대회 마감 11월 9일이니까 여유 있어", expect: ["11-02|11월 2일|11/2"], conflict: true },
  { q: "회의 중에는 미티가 아예 안 끼어드는 걸로 하죠", expect: ["스스로 타이밍을 잡아 끼어들", "어긋나는 말이 나오면", "목소리로 끼어든다", "어긋날 때로 좁힌다"], conflict: true },
  { q: "강도 올리는 것도 그냥 말로 하면 되게 하자", expect: ["올리는 (건|것은|것) 화면"], conflict: true },
  { q: "미티가 팀원별로 잘했는지 점수 매겨 주면 좋겠다", expect: ["사람을 평가하지 않는다"], conflict: true, miss: "\"점수 매기기\"와 \"평가\"는 겹치는 글자가 없음 (뜻으로만 같음)" },
  { q: "AI인 건 굳이 밝히지 말고 그냥 팀원처럼 하자", expect: ["AI(라는 걸|임을|라는 것을) 밝"], conflict: true },
];

export const isAnswer = (x: Query, text: string) => x.expect.some((e) => new RegExp(e).test(text));
