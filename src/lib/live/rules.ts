// 모델 없이 바로 판단하는 것들: 호출어, 설정 명령, 회의 끝. 빨라야 하고 흔들리면 안 된다.
import type { Intensity } from "./contract";

// "미티야"가 받아쓰기에서 흔들린 형태까지. 앞 글자가 한글이면(커미티 등) 다른 단어로 본다.
// "미트"는 고기(미트볼·미트소스)와 겹치니 "미트야/미트아"처럼 부르는 꼴일 때만 받는다. "미팅"·"미디어"는 받지 않는다.
const WAKE = /(?:^|[^가-힣])(?:미티|미띠|밋티|밋띠|메티|메띠|미치야|미트야|미트아|밋트야)/;

export function hasWakeWord(text: string): boolean {
  return WAKE.test(text);
}

// 받아쓰기가 음성 서버의 힌트 문장("회의 참석자는 …, 그리고 AI 팀원 미티.")을 그대로 뱉은 것 (Whisper 환각).
// S7 실제 녹음 E2E 10/30 #276: "이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티." 두 번. 사람이 한 번 소개하는 말은 받는다.
const HINT = /그리고\s*AI\s*팀원\s*미티/g;
export function isHintEcho(text: string): boolean {
  return (text.match(HINT)?.length ?? 0) >= 2 || /회의\s*참석자는.*AI\s*팀원\s*미티|회의에는\s*AI\s*팀원\s*미티도\s*참석/.test(text);
}

// 발화 맨 앞에서 조사 없이 부름 ("미티, 조용히 해", "미티 끼어들지 마") — "미티가 ~"·"미티는 ~"(3인칭)은 아니다
const LEADING = /^\s*(?:미티|미띠|밋티|밋띠|메티|메띠)(?![가-힣])/;
export function isLeadingCall(text: string): boolean {
  return LEADING.test(text);
}

// 부르는 꼴("미티야", "미티 씨") — 3인칭으로 말하는 것("미티는", "미티예요")과 구분하는 힌트.
const VOCATIVE = /(?:^|[^가-힣])(?:미티|미띠|밋티|밋띠|메티|메띠|미트|밋트)(?:야|아|씨|님)(?![가-힣])|(?:^|[^가-힣])미치야(?![가-힣])/;
export function isVocative(text: string): boolean {
  return VOCATIVE.test(text);
}

export interface SettingsCommand {
  intensity: Intensity;
  direction: "down" | "up";
}

// 받아쓰기에선 "끼어들지 마"가 "끼어들지나"·"끼어드지마"·"끼어 들지 마"로도 나온다 (S7 실제 음성)
const LOW = /끼[어여]\s*드?들?지\s*(좀\s*)?(마|말|않|나)|조용히\s*(해|있어|좀)|말하지\s*(마|말)|손만\s*들어|그만\s*끼어들|나서지\s*(마|말)|입\s*다물|(강도|참여도)\s*(좀\s*)?(내려|낮춰)/;
const MID = /덜\s*끼어들|가끔만\s*(끼어들|말해)|중간\s*(으로|강도)|좀\s*참았다가|조금만\s*끼어들/;
const HIGH = /적극적으로|자주\s*끼어들|바로바로\s*말|마음껏\s*끼어들|다시\s*끼어들어|편하게\s*끼어들|(강도|참여도)\s*(좀\s*)?(올려|높여)/;

// "끼어들다"는 미티에게만 쓰는 말이라 호출어가 없어도 미티에게 한 말로 본다. "조용히 해" 같은 건 사람에게도 하니 아니다.
const MEETY_ONLY = /끼[어여]\s*[드들]|손만\s*들어|나서지\s*(마|말)/;
export function isMeetyCommand(text: string): boolean {
  return MEETY_ONLY.test(text);
}

// 미티에게 한 말일 때만 부른다(호출어가 있거나, 방금 미티가 말했거나, 미티에게만 쓰는 말일 때).
export function parseSettingsCommand(text: string, current: Intensity): SettingsCommand | null {
  const order: Intensity[] = ["low", "mid", "high"];
  const target: Intensity | null = LOW.test(text) ? "low" : MID.test(text) ? "mid" : HIGH.test(text) ? "high" : null;
  if (!target || target === current) return null;
  return { intensity: target, direction: order.indexOf(target) < order.indexOf(current) ? "down" : "up" };
}

const END = /오늘은?\s*여기\s*까지|오늘\s*회의\s*(끝|마치)|회의\s*(끝낼게|마칠게|마치겠|끝내자|마치자)|이만\s*(마치|줄이)|여기서\s*마치/;
const END_WHOLE = /^\s*(이상입니다|이상이에요)[.!\s]*$/;
export function isEndPhrase(text: string): boolean {
  return END.test(text) || END_WHOLE.test(text);
}

export const ACK_TEXT: Record<Intensity, string> = {
  low: "알겠어요, 이제 화면에 손만 들게요.",
  mid: "알겠어요, 조금 더 기다렸다가 말할게요.",
  high: "알겠어요, 바로바로 말할게요.",
};
export const CONFIRM_TEXT = "더 자주 끼어드는 건 화면에서 한 번 확인해 주세요.";

// 문장 나누기 (TTS가 첫 문장부터 구울 수 있게)
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?요다])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// "사람인 척 해 줘", "AI라는 거 말하지 마" 같은 부탁. 모델에 맡기면 답을 안 하고 넘기는 일이 많아서(S9 A6: 20번 중 18번 무응답) 코드로 잡는다.
const IDENTITY =
  /사람인\s*척|사람처럼|사람이(라고|야|지|에요|잖아)|사람\s*팀원|AI(라는|라고|가)?\s*(거|걸|것|말)?\s*(말하지|빼|숨기|하면)|AI가?\s*(아닌\s*척|아니(잖아|에요|야|라고))|AI\s*안\s*쓴다|인\s*척\s*(받|해|대답)|흉내|(막내|인턴|팀원)(이)?라고\s*(소개|해)|이?라고\s*소개|네\s*이름은/;
export function isIdentityRequest(text: string): boolean {
  return IDENTITY.test(text);
}
export const IDENTITY_TEXT = "저는 AI 팀원 미티예요. 사람인 척이나 다른 사람 흉내는 하지 않아요.";

// 녹음 사실을 숨겨 달라는 부탁 (지키는 원칙: 녹음을 시작할 때 안내한다)
const HIDE_RECORDING = /녹음.{0,8}(말하지|숨기|비밀|모르게)/;
export function isHideRecordingRequest(text: string): boolean {
  return HIDE_RECORDING.test(text);
}
// 화면이 두뇌를 거치지 않고 스스로 내는 미티 말 (LiveMeeting MEETY_HELLO) — echo가 이 말인지도 본다
export const SCREEN_LINES = ["안녕하세요, 미티예요. 지금부터 회의 녹음과 기록을 시작할게요."];

export const RECORDING_TEXT = "녹음하는 건 숨기지 않아요. 녹음할 때는 꼭 먼저 알려 드려요.";

// 한 발화 안의 줄바꿈은 공백으로 (회의 끝 녹취에서 "이름:" 줄로 갈라져 다른 사람 말이 되지 않게, S9 V4)
export function cleanText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

// 미티가 방금 한 말이 마이크로 다시 들어온 것인지 (글자 두 개씩 겹치는 정도)
export function overlap(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/[\s.,!?·]/g, "");
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

// 질문이거나 결정을 알고 다시 열자는 말 — 어긋남이 아닐 수 있어서, 미리 만든 말로 바로 끼어들지 않고 확인을 기다린다
const TENTATIVE = /\?|까요|어때|어떨|할래|할까|다시\s*(열|정하|얘기|논의)|바꾸(자|면|는\s*거|기로)|재검토|동의해/;
export function isTentative(text: string): boolean {
  return TENTATIVE.test(text);
}

// 말로 짚을 때 앞에 붙이는 여는 말. 한 회의 안에서 차례로 바꿔 쓴다 (늘 "잠깐만요"면 기계 같다).
// 첫 문장 앞에 쉼표로 붙인다("잠깐만요, 10월 10일 회의에서 …") — 따로 한 문장이면 문장 사이 틈이 하나 더 생긴다. 빈 것은 여는 말 없이.
export const OPENERS = ["잠깐만요.", "하나만요.", "", "참고로요."];
// 어긋남 지적의 둘째 문장: 되묻는 말 하나 (10/31 S6: 녹화마다 2문장 8.9초~4문장 16초로 들쭉날쭉). 근거는 화면 카드가 보여 준다
export const CONFLICT_ASKS = ["그대로 갈까요, 바꿀까요?", "바꾸는 걸로 할까요?"];
export function withOpener(opener: string, line: string): string {
  return opener ? `${opener.replace(/[.!]$/, ",")} ${line}` : line;
}
const OPENER_HEAD = /^\s*(잠깐만요|잠시만요|하나만요|참고로요|저기요)\s*[,.!]?\s*/;
// 모델이 그래도 여는 말을 붙여 오면 떼어 낸다
export function stripOpener(line: string): string {
  return line.replace(OPENER_HEAD, "").trim();
}

// 앞의 제안을 받는 말 — 합의 카드는 이런 말이 나온 줄에서만 낸다 (관리 세션 10/30: 제안하는 줄이 아니라 동의가 나온 줄)
// "그래서·그래도"는 받는 말이 아니다
// 받아쓰기 흔들림("조아", "그래요")도 받는다
const ACCEPT = /(^|[\s,.!?])(네|넵|예|좋아|좋아요|좋습니다|조아|조아요|그래(?![서도야])|그러자|그렇게\s*하자|그렇게\s*해요|그걸로|오케이|오키|찬성|동의(해요|합니다|해(?!\s*\?))|콜|알겠|맞아요|맞아)/;
export function isAcceptance(text: string): boolean {
  return ACCEPT.test(text);
}

// 말이 아직 안 끝난 것 같은 final ("…만들어서", "…했는데", 음성 서버가 20초에서 강제로 자른 것)
// → 사람이 숨 고르는 중일 수 있으니 강도 상·중이어도 gap 1500까지 기다린다
const FINISHED = /([.?!…~]|요|다|죠|까|네|지|야|군|래|자|어|아|게|걸|니다)\s*$/;
export function isUnfinished(text: string): boolean {
  const t = text.trim();
  return !!t && !FINISHED.test(t);
}

// 맞장구·짧은 진행 말 ("음, 일단 들어보자.", "네네", "오케이") — 앞에서 나온 어긋남을 바로잡거나 주제를 넘기는 말이 아니다.
// 미티가 들고 있는 할 말을 "주제가 넘어감·해결됨"으로 거두는 데 세지 않는다 (E2E day2 10/30)
const BACK_WORDS = new Set(["음", "어", "아", "오", "흠", "네", "넵", "예", "응", "오케이", "일단", "들어보자", "들어", "보자", "볼게요", "계속", "계속해", "계속하세요", "그렇죠", "그렇구나", "그러네요", "그래요", "맞아요", "좋아요", "알겠어요", "말해봐", "말해보세요"]);
export function isBackchannel(text: string): boolean {
  const words = text.replace(/[,.!?~…]/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && words.every((w) => BACK_WORDS.has(w.replace(/(.)\1+$/, "$1")) || /^(음|어|아|네)+$/.test(w));
}

// 지식 공백 — 팀원끼리 기억이 안 나는 사실을 묻는 말 ("마감이 언제였지?", "그게 얼마였더라", "기억 안 나") → 리서치 카드 후보
// "얼마로 했었죠?"·"언제로 정했었지?" — 11/2 처음부터 시험: 참여도 5에서 "예산은 지난번에 얼마로 했었죠?"에 카드가 안 나옴
const GAP_Q = /(얼마|뭐|무엇|언제|며칠|몇\s*\S{0,3}|누구|누가|어디|어느)\s*(였|이었|더|이더)(지|라|죠|나|더라)|(얼마|뭐|무엇|언제|며칠|몇\s*\S{0,3}|누구|누가|어디|어느)\S{0,2}\s*(했|정했|하기로\s*했)었(지|죠|나|더라)|(뭐|언제|얼마|어디)더라|기억(이)?\s*안\s*나|생각이\s*안\s*나|찾아\s*봐야|확인해\s*봐야/;
export function isKnowledgeGap(text: string): boolean {
  return GAP_Q.test(text);
}
// 그 물음에 누가 답한 것 같은 말: 숫자·날짜·요일·수 세는 말
const ANSWERISH = /\d|(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(개|명|번|단계|시|장|가지|주)|[월화수목금토일]요일|어제|오늘|내일|모레|이번\s*주|다음\s*주/;
export function looksLikeAnswer(text: string): boolean {
  return ANSWERISH.test(text);
}

// 맞서는 말 꼴 (갈등 구조 제안 후보) — 같은 논점에서 이런 말이 여러 사람에게서 되풀이되면 신음 구간(groan zone)
const DISAGREE = /근데|그런데|아니\s|아니요|아니야|그건\s*좀|반대|별로|그래도|하지만|글쎄|그게\s*아니라|오히려|차라리/;
export function isDisagreement(text: string): boolean {
  return DISAGREE.test(text);
}
// 격한 말 — 갈등 구조 제안도 참는다 (먼저 가라앉게)
const HEATED = /말\s*좀\s*끝까지|왜\s*자꾸|그만\s*좀|짜증|답답하|말\s*끊지/;
export function isHeated(text: string): boolean {
  return HEATED.test(text);
}
// 아이디어를 찾는 말 (제안·추천 후보) · 막힌 말
const IDEA_Q = /아이디어|뭐가\s*좋을까|뭐\s*없을까|어떻게\s*하면|다른\s*방법|뭐\s*있을까|좋은\s*생각|추천/;
export function isIdeaSeeking(text: string): boolean {
  return IDEA_Q.test(text);
}
const STALL = /글쎄|모르겠|생각이\s*안\s*나|떠오르|막막|음+\s*[.…]*$|흠+/;
export function isStall(text: string): boolean {
  return STALL.test(text) || isBackchannel(text);
}

// 스스로 맡거나 누구에게 맡기는 말 ("제가 할게요", "준영이가 맡아 줘") — 역할 빈칸(owner_gap)을 거둔다. 사람 이름은 meeting.ts가 따로 본다
const ASSIGN = /제가|내가|저희가|우리가|맡을게|맡겠|맡아|할게요|할게|하겠습니다|해 볼게|해볼게|담당할|담당은/;
export function isAssignment(text: string): boolean {
  return ASSIGN.test(text);
}

// 미리 만든 말을 확인(verify) 전에 바로 꺼내면 안 되는 말: 안 끝난 말, 무언가를 부정하는 말.
// watch(Haiku)가 "요약이 메인이 아닌데"(결정도 요약을 버림 = 같은 방향)를 어긋남으로 잘못 보는 일이 있었다 (S7 실제 녹음 E2E 10/30, 1160초).
// "~하는 게 낫지 않아요"는 흔한 제안 꼴이라 "않"은 넣지 않는다 (D2 채점: 그걸로 확인을 기다리다 주제가 넘어감)
const NEGATES = /아니|말고|대신/;
export function needsCheck(text: string): boolean {
  return isUnfinished(text) || NEGATES.test(text);
}

// 미티에게 의견·대답을 바로 청하는 2인칭 말 ("너는 어떻게 생각해?", "대답해 봐") — 미티가 방금 말한 뒤에만 쓴다
const ASK_YOU = /(너는|넌|네\s*생각|니\s*생각|네가\s*보기|어떻게\s*생각(해|하세요|해요|하니|하냐)|대답해\s*봐|말해\s*봐|말해\s*줘)/;
export function isAskingYou(text: string): boolean {
  return ASK_YOU.test(text);
}

// 이름만 부른 말("미티야", "미티야?") — 받침말("네?")만 하고 다음 말을 부름으로 받는다
const BARE_CALL = /^[\s,.~!?…]*(?:미티|미띠|밋티|밋띠|메티|메띠|미트|밋트|미치)(?:야|아|씨|님)?[\s,.~!?…]*$/;
export function isBareCall(text: string): boolean {
  return BARE_CALL.test(text);
}

// 음성 서버가 미리 구워 두는 맞장구·생각 소리 (S2 voice/tts/config.py BACKCHANNEL_KINDS 그대로 — 글자가 다르면 새로 굽는다)
export const BACKCHANNEL_KINDS = {
  ack: ["네네", "네, 네.", "아 네", "네네."],
  agree: ["맞아요", "맞아요.", "그렇죠", "그쵸"],
  think: ["음", "음…", "음..."], // "으음"은 뺌 — Qwen3 목소리 메아리가 사람으로 잡혀 barge_in (S2 27e334a)
  recall: ["아 그거요", "아~ 그거요", "아, 그거요."],
  hold: ["음, 잠깐만요.", "음 잠깐만요", "잠깐만요."],
  interest: ["아하", "아하.", "오~ 좋네요"], // "오, 좋네요."는 뺌 — 같은 까닭
} as const;
export type BackchannelKind = keyof typeof BACKCHANNEL_KINDS;

// 음성 서버가 미리 구워 두는 받침말 (S2 voice/tts/config.py FILLERS — 글자 하나라도 다르면 새로 합성해서 느리다)
export const FILLER = { what: "네?", wait: "네, 잠깐만요.", go: "네, 말씀하세요.", think: "음, 잠깐 생각해 볼게요.", listening: "네, 듣고 있어요.", lookup: "기록 좀 볼게요.", web: "네, 한번 찾아볼게요." } as const;
// 기록·자료를 찾아야 하는 물음 — 받침말로 "찾는 중"임을 먼저 말해 검색 지연을 가린다 (HN 댓글 사례). "기록 좀 볼게요."는 S2 FILLERS에 넣어 굽기
const RECORD_Q = /뭐였|뭐로\s*(정|했)|정했|언제|누가|누구|담당|기한|마감|결정|기록|자료|문서|몇\s*(단계|개|명|일|시)|며칠/;
export function isRecordQuestion(text: string): boolean {
  return RECORD_Q.test(text);
}
// 웹에서 찾을 것 같은 부름 — 받침말을 "네, 한번 찾아볼게요."로 (11/2: "네, 잠깐만요." 뒤에 "한번 찾아볼게요."가 또 들림). 기록 물음이 먼저다
// 11/2 리허설: "업계 평균이랑 비교하면", "다른 회의 AI들도 먼저 말해?" — 팀 바깥 사실을 짐작으로 답함(2/3)
const WEB_Q = /찾아\s*(봐|줘|볼래|봐\s*줘)|검색|알아\s*(봐|줘)|인터넷|웹에서|시장\s*규모|경쟁\s*(서비스|사|업체|제품)|요즘|최신|뉴스|통계|업계|평균적|다른\s*(회의\s*)?(AI|에이아이|서비스|회사|앱|제품|툴|도구)|남들은|보통\s*(다른|회사)/;
export function isWebAsk(text: string): boolean {
  return WEB_Q.test(text);
}
// 대답 모델이 웹으로 가며 쓰는 첫 줄 ("한번 찾아볼게요.") — 받침말이 이미 나갔으면 안 말한다
export function isWebAck(line: string): boolean {
  return /^(네,?\s*)?(한번\s*)?찾아볼게요[.!]?$/.test(line.trim());
}
// 웹으로 갈 때 대답 앞에 붙는 군말 — "회의 AI 시장 규모는 이 기록에 없어요. 웹에서 찾아볼게요." (11/2 S6 상황 5: 찾는 중인 검색에 붙으며 섞임)
export function isWebFiller(line: string): boolean {
  return isWebAck(line) || /찾아\s*볼게요|찾아\s*볼까요|검색해\s*볼게요|웹에서\s*(찾|확인)/.test(line) || /(기록|자료)(에는|엔|에)[^.?!]*없어요[.!]?\s*$/.test(line.trim());
}

// 대답을 재촉만 하는 부름 ("미티야 대답해야지", "어떻게 생각해?") — 이미 만들고 있는 대답에 합친다
const NUDGE = /^(?:대답\s*(?:해|해야지|해\s*봐|좀\s*해|안\s*해|해\s*줘)|어떻게\s*생각(?:해|하세요|해요|하니)|듣고\s*있어|왜\s*대답\s*안\s*해|말\s*좀\s*해\s*봐|말해\s*봐)[\s?!.~요]*$/;
export function isNudge(text: string): boolean {
  const rest = text.replace(/(?:미티|미띠|밋티|밋띠|메티|메띠|미트|밋트|미치)(?:야|아|씨|님)?/g, "").replace(/^[\s,.~!?…]+/, "").trim();
  return NUDGE.test(rest);
}

// 맨 앞에서 쉼표·느낌표로 부름 ("미티, 이거 맞아?") — "미티 목소리는 …"(3인칭)과 가르는 빠른 부름용
const LEADING_CALL = /^\s*(?:미티|미띠|밋티|밋띠|메티|메띠)\s*[,，!！?？~]/;
export function isCommaCall(text: string): boolean {
  return LEADING_CALL.test(text) || (LEADING.test(text) && LEADING_REQUEST.test(text));
}
// 맨 앞 "미티 …" + 부탁·물음으로 끝남 ("미티 체크리스트 보여줘") — "미티 목소리는 …"(3인칭 이야기)과 가른다
const LEADING_REQUEST = /(줘|줄래|주세요|해\s*봐|말해\s*봐|뭐야|뭐였지|했지|할까)\s*[?？.!~]*$|[?？]\s*$/;
