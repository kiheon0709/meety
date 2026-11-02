// 회의 중 미티(실시간 에이전트)의 공용 계약. 음성(S2)·두뇌(S3)·자료(S4)·화면(S6)이 이 파일만 보고 따로 만든다.
// 바꾸려면 docs/agent/CONTRACT.md의 "계약 바꾸기" 절차를 따른다. 세션은 이 파일을 직접 고치지 않는다.

// ── 끼어들기 강도 ─────────────────────────────────────────────
// high: 말이 끝났다고 판단되면 바로(gap 300) 말한다.  mid: 0.8초 이상 끊기면 말한다.
// 음성 서버의 말 끝 판정(VOICE_MIN_SILENCE_MS, 기본 500)이 있어 high도 실제로는 말 끝 +0.6초쯤이다.
// low: 먼저 말하지 않는다. 화면에 손만 든다. 사람이 수락하거나 "미티야"로 부르면 말한다.
export type Intensity = "high" | "mid" | "low";
export const GAP_MS: Record<Exclude<Intensity, "low">, number> = { high: 300, mid: 800 };

// ── 음성 서버(voice/, 포트 8765) → 브라우저 : WebSocket /ws ────────────
// 기존 이벤트(speech_start, speech_end, partial, final)는 그대로. gap·barge_in·speaker·echo·enroll이 추가분.
// HTTP: POST /tts {text, voice?, engine?} → wav · POST /tts/prefetch {texts, engine?} → {queued, cached}
//       GET/POST/DELETE /speakers… (등록된 목소리 관리)
// 미티를 끊은 말의 목소리. member: 등록 참석자 → 끊김 인정 / other: 등록자와 확실히 다름(제3자·배경, 유사도 < 0.5) → 두뇌는
// 다음 침묵에 남은 말을 다시 할 수 있다 / unsure: 등록자 없음·말이 짧음·애매 → 끊김으로 본다(팀원을 남으로 잘못 보면 가장 나쁘다)
export type BargeVerdict = "member" | "other" | "unsure";
export type VoiceEvent =
  | { type: "speech_start"; id: number; t: number }
  | { type: "speech_end"; id: number; t0: number; t1: number }
  // partial.stable (10/31 S2 제안 채택): text 앞에서 몇 글자가 "안정"인지 — 최근 partial 2개(약 0.8초)에서 바뀌지 않은 앞부분(띄어쓰기 포함 text 글자 수). 첫 partial은 0, 고쳐 쓰면 줄어든다.
  // 두뇌의 다이얼 높음(말 끝나기 전 미리 판단)은 text.slice(0, stable)만 믿는다. 실측(S2 10/31): final 글자의 45%가 평균 4.4초 먼저 안정, 편집 거리 4.9%. 없으면 0으로 본다.
  | { type: "partial"; id: number; text: string; stable?: number }
  // echo: 미티가 말하던 동안 들어온 말 (스피커 소리가 다시 들어왔을 수 있음 → 두뇌는 판단에서 뺀다)
  // barge: 이 마디가 barge_in을 낸 말이면 그 목소리 판정 (아래 BargeVerdict)
  // final.turn (10/31 S2 acde592): Smart Turn v3.2 "말이 끝났나" 확률 0~1. 0.8 이상이면 서버가 200ms 만에 final을 낸다.
  // 4명 회의에선 "말 끝"과 "미티가 답할 때"가 다르다 — 두뇌는 낮은 turn엔 먼저 꺼내기를 미루는 데만 쓴다.
  | { type: "final"; id: number; t0: number; t1: number; text: string; speaker?: string; echo?: boolean; barge?: BargeVerdict; turn?: number }
  // 말이 끝난 뒤 침묵이 ms를 넘을 때마다 한 번씩 (300, 800, 1500). 그 사이 누가 말하면 안 보낸다.
  // 같은 after_id의 final보다 먼저 올 수 있다 → 두뇌는 버리지 말고 final이 오면 "이미 ms만큼 조용했다"로 처리
  | { type: "gap"; after_id: number; ms: 300 | 800 | 1500 }
  // 미티가 말하는 중에 사람이 말을 시작함 → 화면은 미티 소리를 즉시 끈다
  // 누가 끊었는지는 여기 없다: 끊는 0.35초엔 목소리 지문을 못 만든다(말 시작 뒤 ~1.5초 필요). 같은 id의 final.barge로 온다
  // (docs/architecture/live-screen-design.md §6 — 멈춤→판정→이어 말하기 2단계 대신 이 방식으로 정함)
  | { type: "barge_in"; id: number; t: number }
  // 받은 오디오 5초마다 (심장박동). 소리를 보내는데 15초간 아무 이벤트도 안 오면 음성 서버가 멎은 것 → 화면이 끊고 다시 붙는다
  | { type: "tick"; t: number }
  | { type: "enrolled"; name: string; seconds: number }
  | { type: "enroll_error"; name: string; message: string };

// 브라우저 → 음성 서버 (텍스트 메시지)
export type VoiceClientMsg =
  | { type: "start"; prompt?: string; save?: boolean } // prompt: 참석자 이름을 쉼표로 (호출어·이름 받아쓰기 힌트)
  | { type: "tts"; on: boolean; text?: string } // text: 지금 읽는 문장 (스피커 에코를 미티 목소리와 견줘 거름). 문장마다 on을 보낼 수 있다
  | { type: "enroll"; name: string | null }; // name으로 시작, null로 끝

// ── 브라우저 → 두뇌(Next, /api/live/...) ─────────────────────────
export interface AgendaItem {
  title: string;
  expected: string[]; // 이 안건이 끝날 때 나와야 하는 것 (예: "장면 순서 확정", "담당자")
}

// POST /api/live/start
export interface StartMeetingReq {
  spaceId: string;
  title: string;
  agenda: AgendaItem[];
  intensity: Intensity;
  docIds?: string[]; // S4가 읽어 둔 자료 (발표 시연은 기획 문서)
  participants?: string[];
  budgetUsd?: number; // 이 회의의 모델 비용 상한. 없으면 서버 환경변수 LIVE_MEETING_BUDGET_USD(기본 $1). 닿으면 status "budget"
  // ── 2026-10-30 방향 전환(팀원 역할 7개) 추가분. 전부 선택이고 없으면 지금 동작 그대로 ──
  host?: string; // 호스트 이름. 사설(private)·손들기 audience "host"가 가는 사람. 없으면 첫 참석자
  // 참여도 다이얼 0~10 (2026-10-30 기헌: 모델의 온도처럼 "얼마나 끼어드나" 하나로). 낮을수록 손들기·카드 위주로 조용히, 높을수록 제안·피드백·리서치 보고도 소리로 적극적으로.
  // 고정 횟수 제한(예: 10분에 N번)은 두지 않는다 — 얼마나 자주 말할지는 다이얼과 미티의 판단. mode는 이 값의 초깃값만 정한다 [제안: decision 5, brainstorm 8, presentation 3].
  // 회의 중 "미티야 더 끼어들어/조용히 해"와 화면 슬라이더로 바뀐다. 없으면 intensity에서 유추(high 7, mid 5, low 2)
  participation?: number;
  mode?: MeetingMode; // 프리셋(결정 회의·브레인스토밍·발표). 역할·예산 기본값을 바꾼다
  roles?: Partial<Record<RoleKind, boolean>>; // 역할 켜기/끄기. 없으면 mode 기본값
  budget?: { voicePer10Min?: number; maxSentences?: number }; // (선택) 자발 음성 상한. 기본 없음 — 다이얼이 정한다. 팀이 원할 때만
  shadow?: RoleKind[]; // 그림자 모드: 감지만 하고(기록) 말·손들기·카드는 내지 않음 — 새 역할의 놓침률(MIR)·오탐률(FIR) 측정용
  plannedMinutes?: number; // 예정 시간. 끝이 가까우면 자동 침묵(mode 이벤트 time_pressure)
}
export type MeetingMode = "decision" | "brainstorm" | "presentation";
export interface StartMeetingRes {
  meetingId: string;
  // 회의 열쇠. 이후 모든 /api/live/{meetingId}/* 요청에 헤더 x-live-token(또는 ?token=, EventSource용)으로 보낸다.
  // 없거나 틀리면 401. 다른 기기에서 같은 회의를 열려면 링크에 ?token=을 붙여 넘긴다. LIVE_INSECURE=1이면 검사 끔(연결 시험용).
  // /api/live/start는 로그인한 사람이 그 스페이스에 접근할 수 있어야 한다(canAccessSpace).
  controlToken: string;
}

// POST /api/live/{meetingId}/utterance — final 받을 때마다 (partial은 아래 /partial로 따로)
export interface UtteranceReq {
  id: number;
  t0: number;
  t1: number;
  text: string;
  speaker?: string; // 모르면 비움. 설정 변경 명령의 권한 확인에 쓴다
  // 미티가 말하던 동안 들어온 말. 통째로 버리지 않는다: 설정 명령("끼어들지 마")·호출은 받고,
  // 어긋남 판단·변경 카드에서는 뺀다. (화면은 미티가 방금 읽은 문장과 거의 같은 echo만 아예 안 넘긴다)
  echo?: boolean;
  // 이 말이 미티를 끊은 말이면 그 목소리 판정(음성 final.barge 그대로). 두뇌는 /barge의 id와 이 id로 잇는다.
  // final이 빈 글이면(기침·잡음·지어내기 거름) utterance가 안 온다 → 두뇌는 "끊었는데 몇 초 안에 말이 없으면 other와 같게" 볼 수 있다
  barge?: BargeVerdict;
}
// POST /api/live/{meetingId}/gap        body: { after_id, ms }        음성 서버 gap을 그대로 전달
// POST /api/live/{meetingId}/barge      body: { id, playedMs? }       미티가 말하다 끊김. playedMs: 재생 시작부터 끊김까지 → 2초 미만이면 다음 침묵에 다시 말한다
//   actionId? (10/31 S3 제안 채택): 끊길 때 화면이 실제로 틀던 말. 있으면 두뇌는 이걸 끊긴 말로 친다(없으면 보낸 차례·글자 수로 추정)
// POST /api/live/{meetingId}/partial    body: { id, text, stable? }   받아쓰기 중간 결과 (10/31). 화면이 1.5초에 한 번·10자 이상일 때만 넘긴다. 두뇌는 text.slice(0, stable)만 보고 draft 이벤트만 낸다(LIVE_PARTIAL=1일 때).
// POST /api/live/{meetingId}/respond    body: { actionId, accept, choice? }  손든 것을 수락/거절. choice: "speak"(소리로) | "keep_private"(사설 유지) | "dismiss"
// POST /api/live/{meetingId}/settings   body: { intensity, confirmed, roles?, budgetPer10Min?, participation? } 화면에서 바꿈. 올리는 건 confirmed=true 필요. participation은 다이얼(0~10)
// POST /api/live/{meetingId}/private    body: { actionId, to: "person" | "all" | "drop" }  호스트가 사설(private)을 당사자에게/전체에/버림 — 2단(사설 → 호스트 승인 → 공개)
// 열쇠: controlToken은 호스트용. [제안] viewToken(보기 전용: stream·GET만)을 따로 두어 다른 기기 링크로는 설정을 못 바꾸게 — 구현 시 StartMeetingRes.viewToken? 추가
// POST /api/live/{meetingId}/end        회의 끝 → 체크리스트를 보내고 회의록 파이프라인으로 넘김. 응답 EndMeetingRes
// GET  /api/live/{meetingId}             회의 설정과 현재 상태 (다른 기기에서 같은 회의 열기) → MeetingInfo
// GET  /api/live/docs?spaceId=           그 스페이스가 쓸 수 있는 자료 목록 → DocInfo[] (자료는 스페이스에 묶어야 쓸 수 있다: scripts/live-docs.ts)
export interface EndMeetingRes {
  sessionId?: string; // 정리 파이프라인으로 넘긴 회의
  items?: ChecklistItem[];
}
export interface MeetingInfo extends StartMeetingReq {
  meetingId: string;
  intensity: Intensity; // 현재 값
  ended: boolean;
  sessionId?: string; // 회의 끝에 정리 파이프라인으로 넘긴 회의 (끝난 뒤에만)
  status?: Extract<AgentEvent, { type: "status" }>; // 두뇌 건강 상태 (회의 도중 새로 붙은 화면이 바로 쓰게)
}

// ── 두뇌 → 브라우저 : SSE GET /api/live/{meetingId}/stream ───────────
// 팀원 역할 7개(docs/architecture/brain-design.md §2) + 대답 2종. 역할은 모두 "후보"를 만들고, 말할지·어느 채널(소리→손들기→카드→사설)로 낼지는 중재기 하나가 우선순위·예산으로 정한다
export type RoleKind =
  | "conflict" // 어긋남: 합의된 결정·기한 있는 할 일·자료와 반대되는 말
  | "owner_gap" // 역할 빈칸: 결정 직후 담당이 없음 ("누가 맡나요?") — 옛 이름 open_item
  | "structure" // 갈등 구조 제안: 같은 두 안이 반복될 때 기준표 제안, 소수 의견 익명 재발화(사설)
  | "quiet_member" // 조용한 멤버: 오래 말 없는 사람 → 호스트/당사자 사설
  | "research" // 리서치 카드: 지식 공백 발언에 자료·수치·출처 카드 (소리는 부르면)
  | "feedback" // 피드백: 반론 없이 빨리 수렴할 때 질문형 1회
  | "suggest"; // 제안·추천: 발산 구간 긴 침묵에 두 번째 응답자로, 기준표 형태 (11/2 뒤)
export type ActionKind = RoleKind | "open_item" /* 옛 이름, owner_gap으로 */ | "answer" /* "미티야"로 불러서 답함 */ | "ack"; /* 설정 변경 등 짧은 대답 */

// 캔버스에 보여 줄 것 — 두뇌는 그리지 않고 "고른다". 화면이 모르는 kind는 무시한다 (docs/architecture/live-screen-design.md §1-3)
export type CanvasSpec =
  | { kind: "evidence"; items: Evidence[] }
  | { kind: "compare"; title: string; aLabel: string; bLabel: string; rows: { label: string; a: string | number; b: string | number }[] }
  | { kind: "timeline"; title: string; points: { date: string; label: string; current?: boolean }[] }
  | { kind: "bar"; title: string; unit?: string; data: { name: string; value: number }[]; highlight?: string } // v2
  | { kind: "flow"; title: string; mermaid: string } // v2 — 화면은 strict + parse 선검증 뒤에만 그린다
  | { kind: "text"; title: string; lines: string[] };

export interface Evidence {
  label: string; // "9/30 회의 — 입구는 웹 중심, 디스코드 봇은 2단계"
  quote?: string; // 근거 발언·문장 원문
  nodeId?: string; // HEAD 노드
  docId?: string; // S4 자료
  loc?: string; // 자료 안 위치 (쪽, 제목)
}

export type AgentEvent =
  // 할 말이 생겼고 말이 끊기길 기다리는 중 (화면: "할 말이 있어요")
  // why: 화면이 소리 전에 띄우는 "왜 말하려는지" 한 줄. evidence: 그 근거 (speak까지 안 기다리고 "왜" 카드를 채우려고)
  | { type: "queued"; actionId: string; kind: ActionKind; preview: string; why?: string; evidence?: Evidence[] }
  // 대사가 준비됨 → 화면은 POST /tts/prefetch {texts: sentences}로 미리 굽는다. 같은 actionId의 speak가 뒤따를 수 있다
  // 첫 소리를 빠르게 하려면 gap을 기다리기 전에(queued와 같이) 최대한 일찍 보낸다
  | { type: "prepare"; actionId: string; kind: ActionKind; sentences: string[] }
  // leadMs: 화면이 queued("왜" 카드)를 보여 준 뒤 이만큼 조용하면 재생 (예고 0.8~2초). 없으면 바로
  | { type: "speak"; actionId: string; kind: ActionKind; text: string; sentences: string[]; evidence: Evidence[]; leadMs?: number; urgent?: true }
  // urgent (10/31 S3 제안 채택): 다이얼 5 이상에서 확정된 어긋남처럼 지금 말해야 하는 것. 화면은 다음 final 뒤 짧은 틈(0.3~0.8초, Smart Turn 말끝 확률 높음)이면 바로 시작하고, settings low("끼어들지 마")보다 먼저 받은 urgent는 버리지 않는다. 사람이 말을 시작하면(barge) 그대로 멈춘다.
  // audience: 누구 화면에 뜨나. "all"(기본) | "host"(호스트만) | "member"(to에 적힌 사람만). 사설은 조용한 멤버 알림처럼 당사자에게만 갈 때 — 호스트 승인 단계는 기본 아님(팀이 켤 때만)
  | { type: "hand_raise"; actionId: string; kind: ActionKind; preview: string; evidence: Evidence[]; audience?: "all" | "host" | "member"; to?: string }
  // 캔버스에 보여 줄 것. 같은 actionId의 speak/hand_raise와 함께 또는 직전. 화면이 못 그리면 무시
  | { type: "show"; actionId: string; canvas: CanvasSpec; ttlMs?: number }
  // 사설: 소리·공개 카드가 아닌 것(조용한 멤버 알림, 소수 의견 재발화). to: "host" 또는 사람 이름. 호스트 화면에 먼저(승인 대기)
  | { type: "private"; actionId: string; to: string; kind: ActionKind; text: string; evidence: Evidence[] }
  // (선택) 자발 음성 상한을 켠 회의에서만. 바뀔 때만
  | { type: "budget"; used: number; limit: number; windowMin: number }
  // 미티의 판단 상태(두뇌 건강 status와 따로): 시간 압박·격한 갈등·호스트 지시로 자동 침묵 중인지
  | { type: "mode"; quiet: boolean; reason: "time_pressure" | "heated" | "host"; message: string }
  // draft (10/31 S3 제안 13 채택): 말이 끝나기 전 partial의 안정 글자만 보고 "미리 생각 중"(thinking) / 거둠(dropped). 소리·손들기·카드·기록 아님 — 확정되면 지금처럼 queued·speak가 온다.
  // 화면은 마스코트의 아주 작은 반응만(최소 0.6초 유지). 두뇌는 LIVE_PARTIAL=1·다이얼 7 이상일 때만 보낸다.
  | { type: "draft"; uttId: number; kind: RoleKind; state: "thinking" | "dropped"; why?: string }
  // think (10/31 능동형 미티): 먼저 꺼내기 루프가 떠올린 것 — 말하기 전, 소리 없음. 화면은 마스코트 작은 반응 + "생각 중 · text" 메모(20초, research면 "찾아보는 중").
  // 실제로 말하면(queued·speak) 그 메모가 왜 카드로 이어진다. 1:1·다인 모두. 같은 걸 두 번 보내지 않는다.
  | { type: "think"; kind: "idea" | "gap" | "todo" | "research" | "question"; text: string; why?: string }
  // backchannel (10/31): 짧은 맞장구("음", "아 네", "맞아요") — 줄 세우기와 따로, 미티가 말하는 중이거나 기다리는 말이 있으면 화면이 무시. 자막 없음.
  // 두뇌는 사람이 말 사이에 잠깐 쉴 때만, 20초에 한 번 이하. text는 음성 서버 맞장구 캐시 글자 그대로.
  | { type: "backchannel"; text: string }
  // note: 왜 거뒀는지 (예: "다시 확인에서 버림: …", "대화로 해결됨") — E2E 기록에서 놓침 원인을 가르기 위함. rest: barge_in으로 못 한 문장 → 화면이 자막으로 이어쓴다
  | { type: "cancel"; actionId: string; reason: "barge_in" | "stale" | "dismissed"; note?: string; rest?: string[] }
  | { type: "change_card"; cardId: string; title: string; from?: string; to: string; evidence: Evidence[] }
  | { type: "settings"; intensity: Intensity; by: string; pendingConfirm?: Intensity; roles?: Partial<Record<RoleKind, boolean>>; budgetPer10Min?: number; participation?: number } // by: 사람 이름 또는 "screen". participation: 다이얼 0~10
  | { type: "checklist"; items: ChecklistItem[]; final?: boolean; sessionId?: string } // final이면 sessionId(정리 회의)도 같이 // 회의 중에도 보낸다(진행 표시). 끝날 땐 final=true. 손든 항목은 넣지 않는다(화면이 따로 보여줌)
  | { type: "latency"; role: ModelRole; ms: number; firstTokenMs?: number }
  // 두뇌 건강 상태 (모델 API 오류·속도 제한·키 없음·비용 상한). 바뀔 때만 온다. 화면은 ok가 아니면 작게 알린다
  | { type: "status"; state: "ok" | "degraded" | "paused" | "down" | "budget"; reason?: string; untilMs?: number; message: string };
// 화면은 모르는 이벤트 type이 와도 무시하고 계속 동작해야 한다 (두뇌가 먼저 새 이벤트를 보낼 수 있다)

export interface ChecklistItem {
  agenda: string;
  expected: string;
  status: "done" | "open" | "no_owner";
  note?: string; // "일요일 저녁으로 정함, 담당 미정"
  evidence: Evidence[];
}

// ── 모델 역할 (S3가 라우터를 만든다. 다른 세션은 이 이름만 쓴다) ──────────
// watch: 발화마다 "끼어들 일 있나" 빠른 판단 · speak: 실제로 할 말 · verify: 말하기 전 근거 확인
// summarize: 1분 요약 · extract: 자료에서 사실 뽑기(S4)
export type ModelRole = "watch" | "speak" | "verify" | "summarize" | "extract";

// ── 자료(S4) → 두뇌(S3) ──────────────────────────────────────
export interface DocFact {
  id: string;
  docId: string;
  text: string; // "미티는 회의에 참석하는 AI 팀원이다"
  kind: "decision" | "claim" | "number" | "plan";
  loc: string;
  quote: string;
  keys?: string[]; // 검색용 다른 표현
}
export interface DocInfo {
  id: string;
  title: string;
  path: string;
  facts: number;
}
// src/lib/ingest/index.ts 가 내보내는 함수 (S4 구현, S3는 이것만 import)
//   listDocs(): DocInfo[]
//   getFacts(docId: string): DocFact[]
//   searchDocs(query: string, k?: number, opts?: { docIds?: string[] }): { fact: DocFact; score: number }[]
//     → 회의에 고른 자료만 찾도록 docIds를 꼭 넘긴다 (옛 자료엔 지금 기획과 반대인 사실이 있다)
//   ingestPath(path: string): Promise<DocInfo>   같은 내용이면 캐시 (비용 0)
