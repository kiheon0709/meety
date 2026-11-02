// 회의 중 미티의 두뇌. 회의 상태는 서버 메모리(Map)에 둔다.
// 흐름: 발화(final) → watch(빠른 판단) → 어긋남이면
//   (빠른 길) 회의 시작 때 만들어 둔 "어긋날 때 할 말"을 바로 준비 + verify는 뒤에서
//   (느린 길) 미리 만든 말이 없으면 speak(대사)·verify(근거 확인)를 같이 돌림
// → gap이 강도 기준을 넘었거나 이미 넘어 있으면 바로 speak.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../ingest/config";
import { createSessionFromUtterances, processSession, saveLiveRecord } from "../service";
import { getDb } from "../db";
import { liveRecordFrom } from "./record";
import type { z } from "zod";
import type { ModelRole } from "./contract";
import { GAP_MS, type ActionKind, type AgendaItem, type AgentEvent, type ChecklistItem, type EndMeetingRes, type Evidence, type Intensity, type MeetingInfo, type MeetingMode, type RoleKind, type StartMeetingReq, type UtteranceReq } from "./contract";
import { channelOf, dialFrom, INTENSITY_DIAL, PRIORITY, profileOf, resolveBudget, resolveRoles, usedBudget, voiceAllowed, VOICE_COST, type Budget, type Channel, type Profile } from "./roles";
import { buildContext, evidenceFor, factLine, isConfirmed, splitRecent, uttLine, type ContextBundle, type Utt } from "./context";
import { allowedDocIds, searchFacts } from "./docs";
import { ANSWER_MODEL, ROLE_MODELS, type ModelChoice } from "./models";
import { call, classifyError, llmReady, roughTokens, type CallInput, type CallResult, type CallStat, type FailKind } from "./llm";
import { PLAN_SYSTEM, STATE_SYSTEM, StateOut, type MeetingState } from "./prompts";
import { ANSWER_SYSTEM, ONE_LINE_FIX_SYSTEM, SOLO_SYSTEM, WEB_SYSTEM, splitWebQuery, CHECKLIST_SYSTEM, STRUCTURE_SYSTEM, StructureOut, SUGGEST_SYSTEM, ChecklistOut, FEEDBACK_SYSTEM, parseLines, parseTemplates, parseVerify, SECOND_SYSTEM, SPEAK_SYSTEM, SUMMARY_SYSTEM, TEMPLATE_SYSTEM, VERIFY_SYSTEM, WATCH_SYSTEM, WatchOut, type WatchResult } from "./prompts";
import {
  ACK_TEXT,
  cleanText,
  CONFIRM_TEXT,
  hasWakeWord,
  isHintEcho,
  isKnowledgeGap,
  looksLikeAnswer,
  IDENTITY_TEXT,
  isEndPhrase,
  isAskingYou,
  isBareCall,
  isNudge,
  isCommaCall,
  isRecordQuestion,
  isWebAck,
  isWebAsk,
  isWebFiller,
  BACKCHANNEL_KINDS,
  type BackchannelKind,
  FILLER,
  isAcceptance,
  isDisagreement,
  isHeated,
  isIdeaSeeking,
  isStall,
  isAssignment,
  isBackchannel,
  isHideRecordingRequest,
  isIdentityRequest,
  isLeadingCall,
  isMeetyCommand,
  isTentative,
  isUnfinished,
  needsCheck,
  isVocative,
  OPENERS,
  CONFLICT_ASKS,
  withOpener,
  overlap,
  parseSettingsCommand,
  RECORDING_TEXT,
  SCREEN_LINES,
  splitSentences,
  stripOpener,
} from "./rules";

type CandState = "preparing" | "ready" | "delivering" | "spoken" | "raised" | "shown" | "cancelled" | "dropped";

// 끼어들기 한 건이 어느 단계에서 얼마나 걸렸는지 (지연 표의 원천)
export interface Timing {
  final: number; // 발화가 두뇌에 도착
  detect?: number; // watch가 어긋남을 알아챔 (앞부분)
  ready?: number; // 대사 준비 끝
  delivered?: number; // speak 또는 hand_raise
  via?: "gap" | "ready" | "respond"; // gap을 받고 말함 / 이미 조용해서 준비되자마자 말함 / 손든 걸 수락
  template?: boolean; // 미리 만든 말을 씀
  verifyMs?: number;
  verifyOk?: boolean;
  lateNo?: boolean; // 이미 말한 뒤 verify가 아니라고 함
}

export interface Candidate {
  actionId: string;
  kind: ActionKind;
  uttId: number; // 이 후보를 만든 발화
  state: CandState;
  said: string;
  against: string;
  nodeIds: string[];
  factIds: string[];
  sentences: string[];
  evidence: Evidence[];
  verified: boolean;
  hold: boolean; // 질문·다시 열자는 제안처럼 애매한 말: 확인(verify)이 끝나야 말한다
  handOnly?: boolean; // 묶음 판단에서 나온 것: 말할 때가 지났으니 손만 든다
  queued: boolean; // 화면에 "할 말이 있어요"를 보냄
  why?: string; // "왜 지금 말하려는지" 한 줄 (queued.why)
  respoken?: boolean; // 짧게 끊겨서 다시 말하는 후보 (한 번만)
  viaPartial?: boolean; // partial로 미리 찾아 final에 이어 쓴 후보
  urgent?: boolean; // speak.urgent로 보냄 (화면이 안 버림)
  prevConflictAt?: number; // 이 말을 하기 전의 lastConflictAt (끊겨서 다시 말할 때 쿨다운을 돌려주려고)
  staleAfter?: number; // 맞장구 아닌 말이 이만큼 더 지나면 버림 (없으면 STALE_AFTER)
  note?: string; // 버리거나 취소한 이유 (디버그)
  t: Timing;
}

export interface Card {
  cardId: string;
  title: string;
  from?: string;
  to: string;
  evidence: Evidence[];
}

// 회의 상태 (계약 확장): 모델 호출이 실패하거나 비용 상한에 닿으면 화면에 알린다. 그동안에도 회의는 계속된다
// (설정 명령·호출어·회의 끝 말은 모델 없이 동작하고, 녹취는 계속 쌓인다).
//   ok       정상
//   degraded 호출이 실패하기 시작함 (재시도 중)
//   paused   잠깐 판단을 쉼 (연속 실패·속도 제한) — untilMs 뒤 다시
//   down     키가 없거나 인증 실패 — 이번 회의엔 판단 안 함
//   budget   회의 비용 상한에 닿음 — 호출어·말이 많이 겹치는 발화만 판단
export type HealthState = "ok" | "degraded" | "paused" | "down" | "budget";
export type StatusEvent = { type: "status"; state: HealthState; reason?: FailKind | "budget"; untilMs?: number; message: string };
// 맞장구 (1:1에서 사람이 말 사이 쉴 때 "네." — 계약 제안 backchannel {text}, 들어가기 전까지 여기 둔다)
export type BackchannelEvent = { type: "backchannel"; kind: BackchannelKind; text: string; uttId: number };
// 떠올린 생각 메모 (소리 없음 — 계약 제안 think, 화면 S6 state.ts ThinkEvent와 같은 꼴)
export type ThinkEvent = { type: "think"; kind: "idea" | "gap" | "todo" | "research" | "question"; text: string; why?: string };
export type OutEvent = AgentEvent | StatusEvent | BackchannelEvent | ThinkEvent;
type SpeakEv = Extract<AgentEvent, { type: "speak" }>;
type PrepareEv = Extract<AgentEvent, { type: "prepare" }>;
// 말로 내보내기는 여기 한 군데 (무엇을 언제 말할지는 두뇌가 정하고, 소리로 내는 건 목소리 엔진 몫).
// 기본은 화면 이벤트(speak·prepare·backchannel) — 다른 목소리 엔진(실시간 음성 모델 등)을 붙이려면 setVoiceSink.
export type VoiceEv = SpeakEv | PrepareEv | BackchannelEvent;
export function setVoiceSink(m: Meeting, sink: ((ev: VoiceEv) => void) | undefined) {
  m.voiceSink = sink;
}
function voiceOut(m: Meeting, ev: VoiceEv) {
  ev = scrubEvent(m, ev) as VoiceEv;
  if (m.voiceSink) m.voiceSink(ev);
  emit(m, ev); // 기록·화면 자막은 그대로
}

// partial 선판단 한 마디 몫: 본 안정 앞부분·찾은 근거, final이 오면 그 final(아직 final 판단 중인지)
interface Draft {
  ids: string[];
  text: string;
  n: number;
  lastAt: number;
  judged: number;
  inflight: boolean;
  thinking: boolean;
  final?: { u: Utt; handOnly: boolean };
  usedBy?: string; // final에 이어 쓴 후보 actionId
  baked?: string; // partial 때 미리 굽게 보낸 어긋남 말 (같은 말을 또 안 보낸다)
}

export interface Health {
  state: HealthState;
  fails: number; // 연속 실패
  pausedUntil: number;
  reason?: FailKind | "budget";
  budgetHit: boolean;
  skipped: number; // 쉬는 동안 판단을 건너뛴 발화 수
}

export interface Meeting {
  id: string;
  controlToken: string; // 화면만 아는 값. 강도 올리기·읽기에 필요 (S9 V5·V6)
  spaceId: string;
  title: string;
  agenda: AgendaItem[];
  participants: string[];
  docIds: string[];
  intensity: Intensity;
  budgetUsd: number; // 이 회의의 모델 비용 상한
  ctx: ContextBundle;
  health: Health;
  templates: Map<string, string>; // 결정·사실 id → 어긋날 때 할 말
  templatesReady: Promise<void>;
  templateStats?: { targets: number; cached: number; made: number; ms: number; cost: number };
  utts: Utt[];
  summary: string;
  summarizedUpTo: number;
  lastSummaryT: number;
  summarizing: boolean;
  cands: Candidate[];
  flagged: Set<string>; // 이미 짚은(말했거나 손든) 결정·사실 id — 같은 걸 또 짚지 않는다
  lastConflictAt: number; // 마지막으로 어긋남을 말로 짚은 때
  conflictsSpoken: number; // 여는 말 차례
  cards: Card[];
  pendingCard?: { card: Card; uttId: number }; // 제안만 나온 합의 — 다음 한두 마디에서 동의가 나오면 낸다
  spoken: { actionId: string; text: string; at: number }[];
  events: { at: number; ev: OutEvent }[];
  subs: Set<(ev: OutEvent) => void>;
  lastGap: { afterId: number; ms: number; at: number } | null;
  lastSpeechAt: number; // 사람이 말을 시작한 때 (확장 /speech, 없으면 0)
  meetyActedAtUtt: number; // 미티가 마지막으로 말하거나 손든 때의 마지막 발화 번호
  solo: boolean; // 사람 한 명과 하는 회의(1:1) — 호출어 없이도 대답, 손들기 대신 소리, 묶음 안 함
  speakersSeen: Set<string>; // 받아쓰기에 이름이 붙은 화자 (1:1 판단)
  soloLog: { uttId: number; reply: string | null }[]; // 1:1 대답 판단 (null = 대답 안 함)
  answerQ: AnswerJob[]; // 대답 줄 — 한 번에 하나씩, 말한 순서대로 (따로 돌면 끝나는 순서가 뒤섞인다)
  answering: boolean;
  preAnswers: Map<number, PreAnswer>; // partial 안정 글자로 미리 만들기 시작한 대답 (발화 id마다)
  firstPartialAt: Map<number, number>; // 발화마다 첫 partial을 받은 때 (긴 말인지)
  lastAnsweredUtt: number; // 마지막으로 대답한 발화 — 받침말이 필요한지
  lastAnswerAt: number;
  streamingFor: number; // 대답 글이 흘러오기 시작한(첫 토큰이 온) 발화 — 그러면 받침말은 안 한다
  fillerUtt: number; // 받침말을 낸 발화 — 그 대답의 "한번 찾아볼게요."는 안 말한다(받침말과 겹쳐 두 번 들림)
  answered: Set<number>; // 빠른 부름 길로 이미 대답을 시작한 발화 (watch가 또 대답하지 않게)
  awaitCall: number; // "미티야"만 부르고 "네?" 한 뒤, 이 번호의 말은 호출어가 없어도 부름
  lastFillerAt: number;
  quietAsked: boolean;
  // 능동형 미티 (10/31 기헌 결정)
  state?: MeetingState; // 회의 상태 메모
  stateText: string;
  stateAtReal: number; // 메모를 갱신한 때의 진짜 말 수
  stateBusy: boolean;
  planBusy: boolean;
  planAtReal: number; // 먼저 꺼내기를 마지막으로 본 때의 진짜 말 수
  planDue: string; // 다음 긴 침묵에 먼저 꺼내기를 볼 까닭 (주제 바뀜·몇 마디 지남)
  lastProactiveAt: number;
  debateAt: number; // 같은 논쟁 되풀이로 먼저 꺼내기를 본 때 (DEBATE.againMs에 한 번)
  proposed: { text: string; ids: string[]; tag: string }[]; // 미티가 먼저 꺼낸 것 (같은 걸 또 안 꺼내게)
  found: { query: string; lines: string[] }[]; // 뒤에서 찾아본 것
  planLog: { uttId: number; trigger: string; tag: string; text: string | null; note?: string }[];
  openingScheduled: boolean;
  lastBackchannelAt: number;
  voiceSink?: (ev: VoiceEv) => void;
  thoughts: StoredThought[]; // 속생각 저장소 (말 안 한 생각, 10분)


  openingIds: Set<string>; // 여는 말 actionId (미티 말 비중에 안 셈) // 사람이 말·화면으로 강도를 하로 내림 — 1:1이어도 스스로 꺼내는 말은 손들기로
  chain: Promise<void>; // watch는 발화 순서대로 하나씩
  busy: number;
  checklistTimer?: ReturnType<typeof setTimeout>;
  checklistRunning: boolean;
  ended: boolean;
  ending?: Promise<EndMeetingRes>;
  checklist?: ChecklistItem[];
  sessionId?: string;
  stats: CallStat[];
  tokenLog: { uttId: number; fixed: number; summary: number; recent: number }[];
  watchLog: { uttId: number; conflict: boolean; ids: string[]; second?: string }[]; // 놓친 걸 나중에 찾아보려고
  echoLog: { uttId: number; sim: number; as: "mine" | "echo" | "human" }[]; // echo 표시 말을 어떻게 봤나
  webCalls: number; // 웹 검색을 붙여 부른 횟수 (회의당 상한 WEB.maxPerMeeting)
  webOff?: string; // 계정에서 웹 검색이 꺼져 있는 등 — 이 회의에선 더 안 부른다
  webJobs: WebJob[]; // 찾은(찾는 중인) 웹 검색 — 같은 걸 두 번 찾지 않고, 부름이 찾는 중인 검색에 붙는다
  webHeld: Held[]; // 스스로 찾은 결과(웹·기록)를 말할 차례가 아니라 들고 있는 것 — 다음 긴 침묵에 "아까 그거 찾아봤는데요"
  webLog: WebLog[];
  oneLineFix?: { from: string; to: string }; // 회의 뒤 한 줄 요약을 바로잡았으면 (fixOneLine)
  // 팀원 역할 (brain-design.md §2): 켜진 역할, 그림자 모드(감지만 하고 안 냄), 자발 소리 예산과 쓴 기록
  mode?: MeetingMode;
  host?: string;
  participation: number; // 참여도 다이얼 0~10
  profile: Profile; // 다이얼이 정한 채널·강도·쿨다운·우선순위·판단 리듬
  rolesOverride?: Partial<Record<RoleKind, boolean>>; // StartMeetingReq.roles (다이얼이 바뀌어도 지킨다)
  roles: Record<RoleKind, boolean>;
  shadow: Set<RoleKind>;
  shadowLog: { at: number; uttId?: number; kind: ActionKind; would: string; text: string }[];
  budget?: Budget; // 팀이 켠 자발 소리 상한 (없으면 횟수 제한 없음)
  voiceLedger: { at: number; cost: number; kind: ActionKind }[];
  batch: Utt[]; // 묶음 판단(참여도 3 이하)으로 모으는 중인 발화
  batchTimer?: ReturnType<typeof setTimeout>;
  pendingBarge?: { cand: Candidate; rest: string[]; bargeId?: number; timer?: ReturnType<typeof setTimeout> }; // 끊김 판정 기다림
  quietNotified: Map<string, number>; // 조용한 멤버 알림을 보낸 때 (사람마다)
  drafts: Map<number, Draft>; // partial 선판단 (발화 id마다)
  partialLog: { uttId: number; stable: number; reason: string }[]; // partial을 왜 건너뛰었나·어떻게 됐나 (채점에서 이유별로 센다)
  lateLog: { uttId: number; note: string }[]; // 판단 시간 상한을 넘긴 말과 어떻게 메웠나
  lastStructureAt: number; // 마지막 갈등 구조 제안
  suggestPending?: { uttId: number }; // 아이디어를 찾는 말 — 다음 말이 막힌 말이거나 오래 조용하면 거든다
  lastSuggestAt: number;
  researchPending?: { uttId: number; question: string }; // 지식 공백 말 — 다음 말에 답이 없거나 1.5초 조용하면 찾아본다
  lastCardAt: number; // 마지막 리서치 카드 (1분에 1장)
  startedAt: number;
  errors: string[];
}

declare global {
  var __liveMeetings: Map<string, Meeting> | undefined;
}
const meetings: Map<string, Meeting> = (globalThis.__liveMeetings ??= new Map());

export function getMeeting(id: string): Meeting | undefined {
  return meetings.get(id);
}

// 서버를 내리거나 시험이 끝날 때: 열린 회의의 타이머를 멈추고 더 판단하지 않게 한다 (정리로 넘기지는 않음)
export function shutdownMeetings() {
  for (const m of meetings.values()) {
    clearTimeout(m.checklistTimer);
    m.ended = true;
    m.subs.clear();
  }
  meetings.clear();
}

// 사이에 발화가 이만큼 더 쌓이면 주제가 넘어갔다고 본다
const STALE_AFTER = 2;
// 음성 서버는 gap을 1500ms까지만 보낸다. 그 뒤로도 새 발화가 없으면 이만큼은 계속 조용하다고 본다.
// 그 사이 누가 말을 시작했으면 화면이 /speech로 알려 주거나(확장), 미티 소리가 겹치면 barge_in으로 끊긴다.
const GAP_FRESH_MS = 6000;
// 시간 값 (시험에서 바꿔 끼운다)
export const TIMING = {
  // 말로 짚은 뒤 이 시간 안에 또 어긋남이 나오면 말하지 않고 손만 든다
  cooldownMs: 20_000,
  // 합의 카드가 나온 뒤 회의 중 체크리스트를 다시 만들기까지 기다리는 시간 (몰아서 한 번)
  checklistDelayMs: 3000,
  // 장애: 연속 이만큼 실패하면 쉰다, 처음 쉬는 시간(실패가 이어지면 두 배씩), 가장 오래 쉬는 시간
  failsToPause: 3,
  pauseMs: 10_000,
  pauseMaxMs: 60_000,
  // partial 선판단 (다이얼 7 이상): 켜기 전엔 끈다 — RS 실제 시각 재생으로 오탐이 안 느는지 본 뒤 켠다 (brain-design §2-7)
  // 어긋남 미리 판단: 기본 켬(LIVE_PARTIAL=0으로 끔), 다이얼 5 이상 — 녹음에서 미티가 말할 틈이 0.7초뿐이라 final 0.4초 안에 말해야 끝까지 들린다(S6 시나리오 A)
  partialEnabled: process.env.LIVE_PARTIAL !== "0",
  partialDial: 5,
  fillerMs: 0, // 부름 대답이 이만큼 안 나오면 받침말 — 첫 토큰이 0.8초 밑으로 오는 일이 없어(scripts/live-latency.ts) final에서 바로 (목표 말 끝→받침말 0.4초)

  agent: process.env.LIVE_AGENT ? process.env.LIVE_AGENT !== "0" : !process.env.VITEST, // 능동형: 상태 메모·먼저 꺼내기·여는 말·맞장구 (시험에선 켜는 시험만)
  stateEvery: 6, // 진짜 말 이만큼마다 상태 메모 갱신
  paceScale: 1,
  openingDelayMs: 1500, // 화면이 붙고 이만큼 뒤에 여는 말 (그 사이 누가 말하면 안 함)
  backchannelAgainMs: 20_000,
  turnMin: 0.5,
  turnWaitMs: 1500, // 1:1에서 말 끝이 애매하면 이만큼 더 듣고 대답
  phraseSpeak: process.env.LIVE_PHRASE_SPEAK === "1", // 대답 첫 구를 첫 줄이 다 오기 전에 speak (S2 TTS 조각 입력·계약 맞춘 뒤 켬) // final의 말 끝 확률이 이보다 낮으면 먼저 꺼내기를 미룬다 (말이 덜 끝났을 수 있음)
  nudgeMergeMs: 3000,
  // 부름·1:1 말이면 partial 안정 글자로 대답을 미리 만들기 시작 — 꺼 둠: 부름 실제 음성(WV)에서 5번 시작해 4번 버림
  // (물음 내용이 말 끝에 와서 안정 글자가 final을 못 덮음), 이득 거의 없이 Sonnet 한 번씩 더. 긴 1:1 말에서 다시 잴 것
  preAnswer: process.env.LIVE_PRE_ANSWER === "1",
  // 1:1에서 말이 이만큼 넘게 이어지면(첫 partial부터) 그때만 미리 만들기 — LIVE_PRE_ANSWER_LONG=1로 켬 (RS 1:1로 잼)
  preAnswerLong: process.env.LIVE_PRE_ANSWER_LONG === "1",
  preAnswerLongMs: 5000,
  fastFirst: process.env.LIVE_FAST_FIRST !== "0", // 부름 대답 첫 문장은 Haiku, 나머지는 Sonnet — WV 말 끝→첫 문장 가운데 2.22 → 1.41초
  splitSpeak: process.env.LIVE_SPLIT_SPEAK !== "0", // 대답 첫 문장이 나오면 바로 speak, 나머지는 다음 speak(새 actionId)로 — 화면이 speak를 줄 세워 차례로 튼다(S6 d14c949)
  fillerAgainMs: 5000, // 받침말은 이 사이에 한 번만
  partialGapMs: 0, // 한 번에 하나만 돌리니(판단 중이면 건너뜀) 따로 간격은 안 둔다
  // 판단 시간 상한: final 뒤 이만큼 지나도 watch가 안 끝났으면(앞 판단에 막힘·API 꼬리) 미리 판단 결과나 사슬 밖 새 watch로 메운다 (10/31 S6 A2 5번 중 1번 17.9초). 0이면 끔
  judgeCapMs: 2000,
  lateWatchMs: 3000, // 사슬 밖 새 watch의 시간 상한 (다시 보내기 없음)
  // 제안: 아이디어를 찾는 말 뒤 gap 1500이 오고 이만큼 더 조용하면 거든다 (03: "15초 이상 침묵"보다 짧게 [제안])
  suggestWaitMs: 5000,
  // 묶음 판단: 첫 발화를 모은 뒤 이만큼 지나면 긴 침묵이 없어도 본다
  batchMaxMs: 45_000,
  // 끊긴 뒤 끊은 말(utterance.barge)을 이만큼 기다린다. 안 오면 잡음으로 보고 다시 말한다
  bargeWaitMs: 3000,
  // 리서치: 물음 뒤 gap 1500이 오고 이만큼 더 조용하면 찾아본다 (아는 사람이 먼저 답할 틈)
  researchWaitMs: 1500,
  // 스스로 꺼내는 말의 예고 시간: 화면이 "왜" 카드(queued)를 보여 준 뒤 이만큼 조용하면 재생 (brain-design §3-1) [제안]
  leadMs: { high: 800, mid: 1200 } as Record<Exclude<Intensity, "low">, number>,
  // 회의 하나의 모델 비용 상한($). 넘으면 감시를 줄이고 알린다. 실제 1시간 회의는 약 $0.11
  budgetUsd: Number(process.env.LIVE_MEETING_BUDGET_USD) || 1,
};
// 회의 시작 때 미리 말을 만들어 둘 항목 수 상한
const TEMPLATE_MAX = 80;

// ── 이벤트 ───────────────────────────────────────────────
// 그림자 모드 역할의 행동(할 말 알림·말·손들기·카드·사설·거둠)은 내보내지 않고 shadowLog에만 남긴다
const ACTION_EVENTS = new Set(["queued", "prepare", "speak", "hand_raise", "show", "private", "cancel"]);
function shadowKind(m: Meeting, ev: OutEvent): ActionKind | undefined {
  if (!m.shadow.size || !ACTION_EVENTS.has(ev.type) || !("actionId" in ev) || ev.actionId === "templates") return;
  const kind = "kind" in ev ? ev.kind : m.cands.find((c) => c.actionId === ev.actionId)?.kind;
  return kind && m.shadow.has(kind as RoleKind) ? kind : undefined;
}

function emit(m: Meeting, ev: OutEvent) {
  ev = scrubEvent(m, ev);
  const sk = shadowKind(m, ev);
  if (sk) {
    const c = "actionId" in ev ? m.cands.find((x) => x.actionId === ev.actionId) : undefined;
    const text = ev.type === "speak" ? ev.text : ev.type === "hand_raise" || ev.type === "queued" ? ev.preview : ev.type === "private" ? ev.text : ev.type === "cancel" ? (ev.note ?? ev.reason) : ev.type === "prepare" ? ev.sentences.join(" ") : "";
    m.shadowLog.push({ at: Date.now(), uttId: c?.uttId, kind: sk, would: ev.type, text });
    return;
  }
  m.events.push({ at: Date.now(), ev });
  for (const s of m.subs) s(ev);
}

export function subscribe(m: Meeting, fn: (ev: OutEvent) => void): () => void {
  m.subs.add(fn);
  // 화면이 처음 붙으면 미티가 회의를 연다 (상태 메모로 첫 말)
  if (TIMING.agent && !m.openingScheduled) {
    m.openingScheduled = true;
    setTimeout(() => void track(m, openMeeting(m)).catch((e) => fail(m, "plan", e)), TIMING.openingDelayMs);
  }
  return () => m.subs.delete(fn);
}

function record(m: Meeting, stat: CallStat) {
  m.stats.push(stat);
  emit(m, { type: "latency", role: stat.role, ms: stat.ms, firstTokenMs: stat.firstTokenMs });
  if (!m.health.budgetHit && m.stats.reduce((a, s) => a + s.cost, 0) >= m.budgetUsd) {
    m.health.budgetHit = true;
    if (m.health.state === "ok" || m.health.state === "degraded") setHealth(m, "budget", "budget", HEALTH_TEXT.budget);
  }
}

function track<T>(m: Meeting, p: Promise<T>): Promise<T> {
  m.busy++;
  return p.finally(() => m.busy--);
}

function fail(m: Meeting, where: string, e: unknown) {
  const msg = `${where}: ${e instanceof Error ? e.message : String(e)}`;
  m.errors.push(msg);
  console.error("[live]", msg);
}

// ── 시작 ─────────────────────────────────────────────────
// budgetUsd: 회의 비용 상한 (계약 확장 StartMeetingReq.budgetUsd, 없으면 환경변수 LIVE_MEETING_BUDGET_USD)
export function startMeeting(req: StartMeetingReq & { budgetUsd?: number }): Meeting {
  const participants = (req.participants ?? []).map((p) => p.trim()).filter(Boolean);
  // 참여도: participation > mode > intensity 순으로 초깃값. 다이얼을 줬으면 말 차례 강도도 다이얼이 정한다
  const dial = dialFrom(req);
  const profile = profileOf(dial.participation);
  // 자료는 그 스페이스에 묶인 것만 (S9 V9)
  const docIds = allowedDocIds(req.spaceId, req.docIds ?? []);
  const ctx = buildContext({ spaceId: req.spaceId, title: req.title, agenda: req.agenda, participants, docIds });
  const m: Meeting = {
    id: crypto.randomUUID(),
    controlToken: crypto.randomUUID(),
    spaceId: req.spaceId,
    title: req.title,
    agenda: req.agenda,
    participants,
    docIds,
    intensity: dial.explicit ? profile.intensity : req.intensity,
    budgetUsd: typeof req.budgetUsd === "number" && req.budgetUsd > 0 ? req.budgetUsd : TIMING.budgetUsd,
    mode: req.mode,
    host: req.host?.trim() || participants[0],
    participation: profile.participation,
    profile,
    rolesOverride: req.roles,
    roles: resolveRoles(profile, req.roles),
    shadow: new Set(req.shadow ?? []),
    shadowLog: [],
    budget: resolveBudget(req.budget),
    voiceLedger: [],
    lastCardAt: 0,
    quietNotified: new Map(),
    drafts: new Map(),
    partialLog: [],
    lateLog: [],
    lastStructureAt: 0,
    lastSuggestAt: 0,
    batch: [],
    ctx,
    health: { state: "ok", fails: 0, pausedUntil: 0, budgetHit: false, skipped: 0 },
    templates: new Map(),
    templatesReady: Promise.resolve(),
    utts: [],
    summary: "",
    summarizedUpTo: 0,
    lastSummaryT: 0,
    summarizing: false,
    cands: [],
    flagged: new Set(),
    lastConflictAt: 0,
    conflictsSpoken: 0,
    cards: [],
    spoken: [],
    events: [],
    subs: new Set(),
    lastGap: null,
    lastSpeechAt: 0,
    meetyActedAtUtt: -10,
    solo: (req.participants ?? []).length === 1 && req.mode !== "presentation",
    speakersSeen: new Set(),
    soloLog: [],
    answerQ: [],
    answering: false,
    preAnswers: new Map(),
    firstPartialAt: new Map(),
    lastAnsweredUtt: 0,
    lastAnswerAt: 0,
    streamingFor: 0,
    fillerUtt: 0,
    answered: new Set(),
    awaitCall: -1,
    lastFillerAt: 0,
    quietAsked: false,
    stateText: "",
    stateAtReal: 0,
    stateBusy: false,
    planBusy: false,
    planAtReal: 0,
    planDue: "",
    lastProactiveAt: 0,
    debateAt: 0,
    proposed: [],
    found: [],
    planLog: [],
    openingScheduled: false,
    lastBackchannelAt: 0,
    thoughts: [],


    openingIds: new Set(),
    chain: Promise.resolve(),
    busy: 0,
    checklistRunning: false,
    ended: false,
    stats: [],
    tokenLog: [],
    watchLog: [],
    echoLog: [],
    webCalls: 0,
    webJobs: [],
    webHeld: [],
    webLog: [],
    startedAt: Date.now(),
    errors: [],
  };
  meetings.set(m.id, m);
  if (!llmReady()) {
    setHealth(m, "down", "no_key", "모델 키가 없어서 이번 회의는 기록만 해요. 설정 명령·호출어·회의 끝은 돼요.");
    return m;
  }
  m.templatesReady = track(m, prepareTemplates(m)).catch((e) => fail(m, "templates", e));
  return m;
}

// ── 장애 버티기 ─────────────────────────────────────────────
const HEALTH_TEXT: Record<FailKind | "budget", string> = {
  no_key: "모델 키가 없어서 판단을 못 해요. 기록은 계속해요.",
  auth: "모델 키가 맞지 않아서 판단을 못 해요. 기록은 계속해요.",
  rate_limit: "모델 사용량 제한에 걸려서 잠깐 쉬어요. 기록은 계속해요.",
  overloaded: "모델 서버가 바빠서 잠깐 쉬어요. 기록은 계속해요.",
  timeout: "모델 응답이 늦어서 잠깐 쉬어요. 기록은 계속해요.",
  network: "인터넷 연결이 불안해서 잠깐 쉬어요. 기록은 계속해요.",
  bad_output: "모델 답을 못 읽어서 다시 해 볼게요.",
  other: "판단 중 문제가 생겨서 잠깐 쉬어요. 기록은 계속해요.",
  budget: "이번 회의 비용 상한에 닿아서, 저를 부르거나 확정된 것과 많이 겹치는 말만 볼게요.",
};

function setHealth(m: Meeting, state: HealthState, reason: Health["reason"], message: string, untilMs?: number) {
  const changed = m.health.state !== state || m.health.reason !== reason;
  m.health.state = state;
  m.health.reason = reason;
  if (changed) emit(m, { type: "status", state, ...(reason ? { reason } : {}), ...(untilMs ? { untilMs } : {}), message });
}

export function statusOf(m: Meeting): StatusEvent {
  return { type: "status", state: m.health.state, ...(m.health.reason ? { reason: m.health.reason } : {}), message: m.health.state === "ok" ? "정상" : HEALTH_TEXT[m.health.reason ?? "other"] };
}

// 지금 모델로 판단해도 되는지 (쉬는 중이면 끝났는지 보고 다시 시작)
function canThink(m: Meeting): boolean {
  if (m.health.state === "down") return false;
  if (m.health.state === "paused") {
    if (Date.now() < m.health.pausedUntil) return false;
    setHealth(m, m.health.budgetHit ? "budget" : "degraded", m.health.budgetHit ? "budget" : m.health.reason, "다시 판단해 볼게요.");
  }
  return true;
}

// 회의 안의 모든 모델 호출은 여기를 지난다: 실패를 세고, 연속 실패·속도 제한이면 잠깐 쉬고, 키·인증 문제면 이번 회의는 판단을 끈다.
// sideline: 상태 메모·먼저 꺼내기처럼 없어도 회의가 도는 호출 — 실패해도 건강(쉬기)에 안 센다 (RF: 메모가 잘려 세 번 실패하면 watch까지 쉼)
async function ask<T extends z.ZodType>(m: Meeting, role: ModelRole, input: CallInput<T>, sideline = false): Promise<CallResult<z.infer<T>>> {
  if (m.health.state === "down") throw new Error(`판단 꺼짐 (${m.health.reason})`);
  if (sideline) return call(role, input);
  try {
    const r = await call(role, input);
    if (m.health.fails > 0 || m.health.state === "degraded") {
      m.health.fails = 0;
      setHealth(m, m.health.budgetHit ? "budget" : "ok", m.health.budgetHit ? "budget" : undefined, m.health.budgetHit ? HEALTH_TEXT.budget : "다시 정상이에요.");
    }
    return r;
  } catch (e) {
    const { kind, retryAfterMs } = classifyError(e);
    m.health.fails++;
    if (kind === "no_key" || kind === "auth") setHealth(m, "down", kind, HEALTH_TEXT[kind]);
    else if (kind === "rate_limit" || m.health.fails >= TIMING.failsToPause) {
      const wait = Math.min(TIMING.pauseMaxMs, retryAfterMs ?? TIMING.pauseMs * 2 ** Math.max(0, m.health.fails - TIMING.failsToPause));
      m.health.pausedUntil = Date.now() + wait;
      setHealth(m, "paused", kind, HEALTH_TEXT[kind], wait);
    } else if (kind !== "bad_output") setHealth(m, "degraded", kind, HEALTH_TEXT[kind]);
    throw e;
  }
}

// sessionId·status는 계약 확장 (sessionId: 회의가 끝나 정리로 넘어간 뒤, status: 지금 판단 상태)
export function info(m: Meeting): MeetingInfo & { sessionId?: string; status: StatusEvent; budgetUsd: number } {
  return {
    meetingId: m.id,
    spaceId: m.spaceId,
    title: m.title,
    agenda: m.agenda,
    intensity: m.intensity,
    docIds: m.docIds,
    participants: m.participants,
    ended: m.ended,
    budgetUsd: m.budgetUsd,
    ...(m.mode ? { mode: m.mode } : {}),
    ...(m.host ? { host: m.host } : {}),
    participation: m.participation,
    roles: m.roles,
    ...(m.budget ? { budget: { voicePer10Min: m.budget.voicePer10Min, maxSentences: m.budget.maxSentences } } : {}),
    ...(m.shadow.size ? { shadow: [...m.shadow] } : {}),
    ...(m.sessionId ? { sessionId: m.sessionId } : {}),
    status: statusOf(m),
  };
}

// 확정된 결정·자료 사실마다 "어긋날 때 할 말"을 미리 만들고, 화면이 목소리를 미리 굽게 prepare로 한 번에 보낸다.
// 한 번에 많이 주면 모델이 목록이 이상하다며 일부만 쓰는 일이 있어서, 15개씩 나눠 동시에 부르고 빠진 건 한 번 더 부른다.
const TEMPLATE_BATCH = 15;
// 회의 간 캐시: 같은 모델·지시문·항목 내용이면 다시 만들지 않는다 (두 번째 회의부터 거의 0초·$0).
// 메모리 + 파일(data/ingest/live-templates.json). 항목이 바뀌면 열쇠가 달라져 새로 만든다.
declare global {
  var __liveTemplateCache: Map<string, string> | undefined;
}
const templateFile = () => path.join(dataDir(), "live-templates.json");
function templateCache(): Map<string, string> {
  if (globalThis.__liveTemplateCache) return globalThis.__liveTemplateCache;
  let saved: Record<string, string> = {};
  try {
    saved = JSON.parse(fs.readFileSync(templateFile(), "utf8")) as Record<string, string>;
  } catch {
    // 처음
  }
  return (globalThis.__liveTemplateCache = new Map(Object.entries(saved)));
}
function saveTemplateCache() {
  try {
    fs.mkdirSync(path.dirname(templateFile()), { recursive: true });
    const tmp = `${templateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(templateCache())));
    fs.renameSync(tmp, templateFile());
  } catch {
    // 캐시는 못 써도 회의엔 지장 없음
  }
}
export function resetTemplateCache() {
  globalThis.__liveTemplateCache = new Map();
}
const templateKey = (line: string) => crypto.createHash("sha256").update(`${ROLE_MODELS.speak.model}\n${TEMPLATE_SYSTEM}\n${line}`).digest("hex").slice(0, 32);

async function prepareTemplates(m: Meeting): Promise<void> {
  const t0 = Date.now();
  const cost0 = m.stats.reduce((a, x) => a + x.cost, 0);
  const decisions = [...m.ctx.nodes.values()].filter(isConfirmed).sort((a, b) => (b.heldAt ?? "").localeCompare(a.heldAt ?? "")); // 최근 결정부터
  // 자료는 결정·계획·숫자 사실을 먼저 (어긋남이 잘 나는 것)
  const rank = { decision: 0, number: 1, plan: 2, claim: 3 } as const;
  const facts = [...m.ctx.facts.values()].sort((a, b) => rank[a.kind] - rank[b.kind]);
  const targets = [
    ...decisions.map((n) => ({ id: n.id, line: `${n.id} | ${n.heldAt ?? ""} 회의에서 정함: ${n.title}${n.due ? ` (기한 ${n.due})` : ""} — ${n.body}` })),
    ...facts.map((f) => ({ id: f.id, line: `${f.id} | 자료 "${m.ctx.docTitles.get(f.docId) ?? "자료"}" ${f.loc}: ${f.text}` })),
  ].slice(0, TEMPLATE_MAX);
  if (!targets.length) {
    voiceOut(m, { type: "prepare", actionId: "templates", kind: "conflict", sentences: CONFLICT_ASKS });
    return;
  }
  const cache = templateCache();
  for (const t of targets) {
    const hit = cache.get(templateKey(t.line));
    if (hit) m.templates.set(t.id, stripOpener(hit));
  }
  const cached = m.templates.size;
  const askBatch = async (items: typeof targets) => {
    const { text, stat } = await ask(m, "speak", {
      system: [TEMPLATE_SYSTEM, m.ctx.text],
      user: `아래 ${items.length}개 항목마다 한 줄씩, 빠짐없이 전부 써라.\n\n${items.map((t) => t.line).join("\n")}`,
      maxTokens: 2000,
    });
    record(m, stat);
    for (const [id, raw] of parseTemplates(text)) {
      const t = items.find((x) => x.id === id);
      const line = stripOpener(raw);
      if (!t || !line) continue;
      m.templates.set(id, line);
      cache.set(templateKey(t.line), line);
    }
  };
  const todo = targets.filter((t) => !m.templates.has(t.id));
  const batches: (typeof targets)[] = [];
  for (let i = 0; i < todo.length; i += TEMPLATE_BATCH) batches.push(todo.slice(i, i + TEMPLATE_BATCH));
  await Promise.all(batches.map((b) => askBatch(b).catch((e) => fail(m, "templates", e))));
  const missing = targets.filter((t) => !m.templates.has(t.id));
  if (missing.length && m.health.state !== "down") await askBatch(missing).catch((e) => fail(m, "templates", e));
  if (m.templates.size > cached) saveTemplateCache();
  m.templateStats = { targets: targets.length, cached, made: m.templates.size - cached, ms: Date.now() - t0, cost: m.stats.reduce((a, x) => a + x.cost, 0) - cost0 };
  // 되묻는 말과, 첫 번째로 짚을 때 쓸 꼴(여는 말 붙인 첫 문장)로 구워 두게 — 다 보내면(60여 줄) 목소리 작업자가 붙잡혀 지금 말할 문장이 3.7초 기다린다(S6).
  // 앞쪽(최근 결정·결정·숫자 사실)만 PREBAKE_MAX줄. 나머지는 쓸 때(또는 partial로 미리 찾았을 때) 굽는다
  const firsts = targets.map((t) => m.templates.get(t.id)).filter((x): x is string => !!x).slice(0, PREBAKE_MAX).map((x) => conflictSpeech(m, [x])[0]);
  const sentences = [...CONFLICT_ASKS, ...firsts];
  voiceOut(m, { type: "prepare", actionId: "templates", kind: "conflict", sentences });
}

const PREBAKE_MAX = 12;

// ── 굴러가는 층 ─────────────────────────────────────────────
// 요약을 시스템 블록으로 따로 내면(watch) 1분 동안 캐시를 읽는다 → splitSummary면 text에서 요약을 빼고 summaryBlock으로 준다
function rolling(m: Meeting, uptoId: number, opts: { splitSummary?: boolean } = {}): { text: string; recentTokens: number; summaryBlock?: string } {
  const utts = m.utts.filter((u) => u.id <= uptoId && !u.echo);
  const { recent } = splitRecent(utts, m.summarizedUpTo);
  const recentText = recent.map(uttLine).join("\n");
  const parts = [];
  const summaryBlock = m.summary ? `## 앞부분 요약\n${m.summary}` : undefined;
  if (summaryBlock && !opts.splitSummary) parts.push(summaryBlock);
  parts.push(`## 최근 발화\n${recentText || "(없음)"}`);
  if (m.ctx.searchFacts) {
    const last = utts[utts.length - 1];
    const hits = last ? searchFacts(last.text, m.docIds, 5) : [];
    if (hits.length) parts.push(`## 관련 자료 사실\n${hits.map((f) => factLine(f, m.ctx.docTitles)).join("\n")}`);
  }
  if (m.spoken.length) parts.push(`## 미티가 이미 한 말\n${m.spoken.slice(-3).map((s) => `- ${s.text}`).join("\n")}`);
  const raised = m.cands.filter((c) => c.state === "raised");
  if (raised.length) parts.push(`## 미티가 화면에 손든 것 (아직 말 안 함)\n${raised.map((c) => `- ${c.actionId}: ${c.said} ↔ ${c.against}`).join("\n")}`);
  return { text: parts.join("\n\n"), recentTokens: roughTokens(recentText), ...(opts.splitSummary && summaryBlock ? { summaryBlock } : {}) };
}

function latestId(m: Meeting): number {
  return m.utts.length ? m.utts[m.utts.length - 1].id : 0;
}

// 맞장구("네", "음")를 건너뛴 가장 최근 말 — 맞장구는 자리를 메운 게 아니라 침묵을 깨지 않는다 (02 §5-1, brain-design §4 ①)
function latestReal(m: Meeting): Utt | undefined {
  for (let i = m.utts.length - 1; i >= 0; i--) if (!isBackchannel(m.utts[i].text)) return m.utts[i];
  return undefined;
}
function latestRealId(m: Meeting): number {
  return latestReal(m)?.id ?? 0;
}

// ── 발화 ─────────────────────────────────────────────────
const ECHO_MINE_MIN = 0.5; // 미티 말과 이만큼 넘게 겹치면 미티 자기 소리
const ECHO_HUMAN_MAX = 0.3; // 이 밑이면 사람 말
const ECHO_HUMAN_CHARS = 6; // 너무 짧은 조각(잡음·"음")은 사람 말로 단정하지 않는다
// echo 말이 미티 말과 얼마나 같은가: 최근 미티 문장(두뇌가 보낸 것 + 화면이 스스로 내는 말)과의 글자 겹침, 화면이 잰 값(echoSim)이 있으면 둘 중 큰 쪽
function echoSim(m: Meeting, text: string, screen?: number): number {
  const lines = [...m.spoken.slice(-3).map((s) => s.text), ...SCREEN_LINES];
  return Math.max(0, ...lines.map((s) => overlap(text, s)), typeof screen === "number" && screen >= 0 && screen <= 1 ? screen : 0);
}
export function onUtterance(m: Meeting, req: UtteranceReq): void {
  if (m.ended) return;
  settleBarge(m, req.id, req.barge);
  const text = cleanText(req.text);
  if (!text || isHintEcho(text)) return;
  // 미티가 말하던 동안 들어온 말(echo): 미티 자기 말이 다시 들어온 거면 버린다(화면도 거르지만 한 번 더).
  // 미티 말과 거의 안 겹치면(ECHO_HUMAN_MAX 밑) 미티 말 위로 사람이 한 말이다 → 보통 말처럼 판단에 넣는다
  // (10/31 S6 A2 4판: 미티 여는 말 위로 준영이 어긋난 말을 해 echo가 붙었고, 판단에서 빠져 어긋남을 놓침. 그 말과 겹침 0.09, 미티 말 조각은 1.0).
  // 그 사이(애매)는 녹취에 남기고 설정 명령·호출은 받되, 어긋남 판단·변경 카드에서는 뺀다 (계약 UtteranceReq.echo)
  let echo = !!req.echo;
  if (echo) {
    const sim = echoSim(m, text, (req as UtteranceReq & { echoSim?: number }).echoSim);
    const as = sim > ECHO_MINE_MIN ? "mine" : sim < ECHO_HUMAN_MAX && [...text.replace(/[\s\p{P}]/gu, "")].length >= ECHO_HUMAN_CHARS ? "human" : "echo";
    m.echoLog.push({ uttId: req.id, sim: Math.round(sim * 100) / 100, as });
    if (as === "mine") return;
    echo = as === "echo";
  }
  const turn = (req as UtteranceReq & { turn?: number }).turn; // 말 끝 확률 (S2 Smart Turn, 계약 들어가기 전 확장)
  const u: Utt = { id: req.id, t0: req.t0, t1: req.t1, text, speaker: req.speaker, echo: echo || undefined, ...(turn !== undefined ? { turn } : {}), receivedAt: Date.now() };
  m.utts.push(u);
  m.utts.sort((a, b) => a.id - b.id);

  expireStale(m);
  checkOwnerGaps(m);
  checkResearch(m, u);
  checkQuiet(m, u);
  checkStructure(m, u);
  checkSuggest(m, u);

  // 설정 명령: 미티에게 한 말일 때만 — 부르는 꼴("미티야"), 맨 앞에서 부름("미티, ~"), 방금 미티가 말·손들기를 함,
  // 또는 "끼어들지 마"처럼 미티에게만 쓰는 말. "미티가 바로바로 말하게 하죠"(3인칭)는 명령이 아니다.
  const wake = hasWakeWord(text) || u.id === m.awaitCall;
  const addressed = isVocative(text) || isLeadingCall(text) || u.id - m.meetyActedAtUtt <= 1 || isMeetyCommand(text);
  let handled = false;
  // "녹음된다는 거 말하지 마"는 낮추기 명령으로도 읽히지만, 대답은 녹음을 숨기지 않는다는 말이어야 한다
  const hideRec = wake && isHideRecordingRequest(text);
  const cmd = addressed ? parseSettingsCommand(text, m.intensity) : null;
  // 이미 조용한데(다이얼 낮음) "끼어들지 마" — 바꿀 건 없지만 들었다고는 답한다 (다이얼은 그대로: 1이면 1)
  const alreadyQuiet = !cmd && addressed && m.intensity === "low" && parseSettingsCommand(text, "high")?.intensity === "low";
  if (alreadyQuiet && (!u.speaker || !m.participants.length || m.participants.includes(u.speaker))) {
    handled = true;
    emit(m, { type: "settings", intensity: "low", by: u.speaker ?? "목소리", participation: m.participation });
    sayNow(m, "ack", [ACK_TEXT.low], []);
  }
  if (cmd) {
    const known = m.participants.length > 0;
    const member = !u.speaker || (known && m.participants.includes(u.speaker));
    if (u.speaker && known && !member) {
      // 참여자가 아닌 목소리 → 무시
    } else if (u.speaker && !known) {
      // 참여자 목록이 없으면 누구 목소리인지 확인할 수 없다 → 말로는 안 바꾸고 화면 확인으로 (S9 V8)
      handled = true;
      emit(m, { type: "settings", intensity: m.intensity, by: u.speaker, pendingConfirm: cmd.intensity });
      sayNow(m, "ack", [CONFIRM_TEXT], []);
    } else {
      handled = true;
      const by = u.speaker ?? "목소리";
      if (cmd.direction === "down") {
        setIntensity(m, cmd.intensity, by);
        sayNow(m, hideRec ? "answer" : "ack", [hideRec ? RECORDING_TEXT : ACK_TEXT[cmd.intensity]], []);
        if (cmd.intensity === "low") keepConflictAsHand(m);
      } else {
        emit(m, { type: "settings", intensity: m.intensity, by, pendingConfirm: cmd.intensity });
        sayNow(m, "ack", [CONFIRM_TEXT], []);
      }
    }
  }

  // 사람인 척·녹음 숨기기 부탁은 모델에 맡기지 않고 바로 답한다 (지키는 원칙)
  if (!handled && wake) {
    if (isIdentityRequest(text)) {
      handled = true;
      sayNow(m, "answer", [IDENTITY_TEXT], []);
    } else if (hideRec) {
      handled = true;
      sayNow(m, "answer", [RECORDING_TEXT], []);
    }
  }

  // 빠른 부름 길: 부르는 꼴이면 watch(부름인지 고르기)를 기다리지 않고 final에서 바로 대답을 시작한다.
  // 0.3초 안에 대답이 안 나오면 받침말("네, 잠깐만요.")부터 (10/31 기헌 실사용: "미티야 대답해야지" 4번을 25초 무시)
  const settingsShaped = !!parseSettingsCommand(text, "high") || !!parseSettingsCommand(text, "low"); // 무시한 설정 명령(손님 목소리 등)에도 대답하지 않는다
  // "미티 목소리는 …"(맨 앞 3인칭)은 빠른 길로 안 간다 — 부르는 꼴(미티야·미티,)만. 나머지는 watch가 부름인지 고른다 (P2)
  if (!handled && wake && !u.echo && !m.ended && !settingsShaped && (isVocative(text) || isCommaCall(text) || u.id === m.awaitCall)) {
    m.answered.add(u.id);
    fastCall(m, u);
  }

  // echo는 호출("미티야")일 때만 watch를 돌린다 (부름에 답하려고). 어긋남·카드는 applyWatch에서 뺀다
  if (u.echo && (!wake || handled)) return;

  const ending = isEndPhrase(text);
  // 1:1: 호출어 없는 말도 미티에게 한 말 — 대답할지 모델이 정한다(부르는 말은 원래 부름 길로). watch는 그대로(카드·어긋남)
  updateSolo(m, u);
  if (m.solo && !wake && !handled && !ending && !isBackchannel(text)) queueAnswer(m, { u, mode: "solo", question: text });
  // 여럿이 하는 회의: 호출어가 없어도 미티가 방금(한 마디 안) 말한 뒤 "너는 어떻게 생각해?"처럼 2인칭으로 물으면 대답할지 본다
  else if (!m.solo && !wake && !handled && !u.echo && u.id - m.meetyActedAtUtt <= 1 && isAskingYou(text)) queueAnswer(m, { u, mode: "group", question: text });
  // 묶음 판단(참여도 3 이하): 부름·설정이 아닌 말은 모았다가 긴 침묵·45초·8마디·회의 끝에 한 번에 본다
  if (m.profile.rhythm === "batch" && !m.solo && !wake && !handled && !u.echo) {
    m.batch.push(u);
    if (m.batch.length === 1) m.batchTimer = setTimeout(() => flushBatch(m), TIMING.batchMaxMs);
    if (m.batch.length >= BATCH_MAX_UTTS || ending) flushBatch(m);
    maybeSummarize(m);
    if (ending) void m.chain.then(() => endMeeting(m));
    return;
  }
  // partial로 미리 찾은 어긋남은 final이 오자마자 후보로 — 앞 발화의 watch가 아직 돌아도 기다리지 않는다(사슬 밖에서)
  if (!handled && !u.echo) draftOnFinal(m, u, false);
  // 부름 같은 건 바로 본다 — 모아 둔 게 있으면 먼저 그걸 (순서대로)
  flushBatch(m);
  // busy를 미리 올려 둔다: 앞 발화 판단이 끝나길 기다리는 동안에도 "판단 중"으로 보이게
  m.busy++;
  m.chain = m.chain
    .then(() => watch(m, u, { handled, wake }))
    .catch((e) => fail(m, "watch", e))
    .finally(() => m.busy--);
  if (!handled && !u.echo && TIMING.judgeCapMs > 0) setTimeout(() => void track(m, judgeLate(m, u)).catch((e) => fail(m, "watch", e)), TIMING.judgeCapMs);
  maybeSummarize(m);
  agentTick(m);
  if (ending) void m.chain.then(() => endMeeting(m));
}

// ── partial 선판단 (다이얼 7 이상, brain-design §2-7) ──────────────────
// 받아쓰기 중간 결과로 watch를 미리 돌려, 확정된 것과 어긋나 보이면 "미리 생각 중"(draft thinking)을 알린다.
// 안정된 앞부분 text.slice(0, stable)만 본다(계약 partial.stable — 최근 partial 2개에서 안 바뀐 글자 수. S2 측정: final과 편집 거리 4.9%,
// 받는 대로 믿으면 31%). stable이 없으면 0으로 친다. 안정 앞부분이 10자 미만·확정 항목과 안 겹치면 건너뛰고,
// 더 길어졌을 때만 다시 본다. 한 마디에 최대 2번, 한 번에 하나만.
// final이 오면 미리 찾은 어긋남을 바로 후보로 이어 쓴다(final 앞부분이 본 글과 같을 때) — final watch를 기다리지 않아 그만큼 빨라진다.
// final watch는 그대로 돌고, 어긋남이 없다고 하면 이어 쓴 후보를 말하기 전에 거둔다.
const PARTIAL_TRIES = 3; // 한 마디에 미리 판단 세 번까지 (안정 글자가 늘 때만, 한 번에 하나)
export async function onPartial(m: Meeting, id: number, text: string, stable = 0): Promise<void> {
  if (!TIMING.partialEnabled) return;
  const skip = (reason: string) => void m.partialLog.push({ uttId: id, stable, reason });
  if (m.participation < TIMING.partialDial) return skip("다이얼 낮음");
  if (m.ended) return skip("회의 끝");
  if (!m.roles.conflict) return skip("어긋남 역할 꺼짐");
  if (id <= latestId(m)) return skip("final 먼저 옴");
  if (!canThink(m)) return skip("판단 쉼");
  const d: Draft = m.drafts.get(id) ?? { ids: [], text: "", n: 0, lastAt: 0, judged: 0, inflight: false, thinking: false };
  m.drafts.set(id, d);
  const t = cleanText(text.slice(0, stable));
  if (t.length < 10) return skip("안정 10자 미만");
  if (t.length <= d.judged) return skip("안정 앞부분 안 늘어남");
  if (d.n >= PARTIAL_TRIES) return skip("다 봄");
  if (d.inflight) return skip("앞 판단 중");
  if (Date.now() - d.lastAt < TIMING.partialGapMs) return skip("간격");
  if (isBackchannel(t) || hasWakeWord(t)) return skip("맞장구·부름");
  if (!touchesConfirmed(m, t)) return skip("확정 항목과 안 겹침"); // 어긋남만 미리 본다
  const u: Utt = { id, t0: 0, t1: 0, text: t, receivedAt: Date.now() };
  d.n++;
  d.lastAt = Date.now();
  d.judged = t.length;
  d.inflight = true;
  const roll = rolling(m, id - 1, { splitSummary: true });
  const user = [roll.text, `## 이번 발화 (아직 말하는 중 — 받아쓰기 중간이라 끝이 바뀔 수 있다)\n${uttLine(u)}`].join("\n\n");
  let out: WatchResult;
  try {
    const r = await track(m, ask(m, "watch", { system: [WATCH_SYSTEM, m.ctx.text, ...(roll.summaryBlock ? [roll.summaryBlock] : [])], user, schema: WatchOut, maxTokens: 600 }));
    record(m, r.stat);
    out = r.out;
  } finally {
    d.inflight = false;
  }
  const ids = out.conflict.found ? confirmedIds(m, [...out.conflict.node_ids, ...out.conflict.fact_ids]).filter((x) => !m.flagged.has(x)) : [];
  if (m.ended) return skip("회의 끝(판단 뒤)");
  if (m.drafts.get(id) !== d) return skip("final 판단이 먼저 끝남"); // 이미 final이 정했다
  if (ids.length) {
    d.ids = ids;
    d.text = t;
  }
  if (d.final) {
    // final은 왔고 final watch가 아직 도는 중 — 찾은 게 있으면 바로 이어 쓴다
    if (!ids.length) return skip("final 먼저 옴(판단 뒤), 어긋남 없음");
    skip("final 먼저 옴(판단 뒤)");
    return reuseDraft(m, d);
  }
  if (ids.length) bakeDraft(m, id, d, t);
  if (ids.length && !d.thinking) {
    d.thinking = true;
    skip("draft");
    emit(m, { type: "draft", uttId: id, kind: "conflict", state: "thinking", why: conflictWhy(m, ids.filter((x) => m.ctx.nodes.has(x))) });
  } else if (!ids.length && d.thinking) {
    d.thinking = false;
    d.ids = [];
    skip("거둠");
    emit(m, { type: "draft", uttId: id, kind: "conflict", state: "dropped" });
  } else skip(ids.length ? "draft 그대로" : "어긋남 없음");
}

// partial로 어긋남을 찾은 순간 말할 글을 화면에 미리 굽게 한다 (10/31 S6 A2: urgent 빠른 길은 final에 바로 speak라
// 그 자리에서 합성 — GPU를 3D 화면·받아쓰기와 나눠 쓰면 조각 사이 0.68초, 문장 사이 1.2초 빈다). final 때도 같은 근거·같은 차례면 글자가 같다
function bakeDraft(m: Meeting, id: number, d: Draft, text: string) {
  const tpl = bestTemplate(m, text, d.ids);
  if (!tpl) return; // 미리 만든 말이 없으면 final 때 만든다
  const sentences = conflictSpeech(m, [m.templates.get(tpl)!]);
  const key = sentences.join(" ");
  if (d.baked === key) return;
  d.baked = key;
  voiceOut(m, { type: "prepare", actionId: `draft-${id}`, kind: "conflict", sentences });
}

// final이 왔을 때(watch 시작): 미리 찾은 어긋남이 있으면 바로 후보로. 판단 중이면 끝날 때 이어 쓰도록 final을 적어 둔다
function draftOnFinal(m: Meeting, u: Utt, handOnly: boolean) {
  const d = m.drafts.get(u.id);
  if (!d) return;
  d.final = { u, handOnly };
  if (d.ids.length) reuseDraft(m, d);
}

// 띄어쓰기·문장부호를 빼고, final 앞부분이 미리 본 글의 80% 이상 같으면 같은 말로 본다
// (S2: final은 "그 뭐 이제" 같은 군말을 빼는 일이 많아 끝까지 같기를 바라면 놓친다)
const PREFIX_SAME = 0.8;
function samePrefix(seen: string, final: string): boolean {
  const norm = (x: string) => [...x.replace(/[\s\p{P}]/gu, "")];
  const a = norm(seen);
  const b = norm(final);
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return a.length > 0 && k >= a.length * PREFIX_SAME;
}

function reuseDraft(m: Meeting, d: Draft) {
  if (!d.final || d.usedBy || !d.ids.length) return;
  const { u, handOnly } = d.final;
  const log = (reason: string) => void m.partialLog.push({ uttId: u.id, stable: d.judged, reason });
  if (u.echo || isBackchannel(u.text)) return log("final이 맞장구·echo");
  if (!samePrefix(d.text, u.text)) return log("final 앞부분 다름");
  const before = new Set(m.cands.map((c) => c.actionId));
  onConflict(m, u, { found: true, node_ids: d.ids.filter((x) => m.ctx.nodes.has(x)), fact_ids: d.ids.filter((x) => m.ctx.facts.has(x)), said: "", against: "" }, undefined, false, handOnly);
  const c = m.cands.find((x) => !before.has(x.actionId) && x.uttId === u.id && x.kind === "conflict");
  if (!c) return log("final에 이어 쓸 게 없음(이미 짚음 등)");
  d.usedBy = c.actionId;
  c.viaPartial = true;
  log("final에 이어씀");
}

// final 판단이 끝난 뒤: 그 발화로 어긋남 후보가 안 생겼으면 미리 띄운 draft를 거두고,
// 미리 이어 쓴 후보는 final watch가 어긋남이 없다고 했으면 말하기 전에 거둔다
function settleDraft(m: Meeting, id: number, finalFound?: boolean) {
  const d = m.drafts.get(id);
  if (!d) return;
  m.drafts.delete(id);
  const used = d.usedBy ? m.cands.find((c) => c.actionId === d.usedBy) : undefined;
  if (used && finalFound === false && (used.state === "preparing" || used.state === "ready")) {
    drop(m, used, "final 판단: 어긋남 아님 (partial로 미리 이어 쓴 것)");
    m.partialLog.push({ uttId: id, stable: d.judged, reason: "final이 아니라고 해서 거둠" });
  }
  if (d.thinking && !m.cands.some((c) => c.uttId === id && c.kind === "conflict" && c.state !== "dropped")) emit(m, { type: "draft", uttId: id, kind: "conflict", state: "dropped" });
}

// ── 묶음 판단 (brain-design §2-7) ───────────────────────────────
const BATCH_MAX_UTTS = 8;
function flushBatch(m: Meeting) {
  clearTimeout(m.batchTimer);
  m.batchTimer = undefined;
  if (!m.batch.length) return;
  const utts = m.batch;
  m.batch = [];
  m.busy++;
  m.chain = m.chain
    .then(() => watchBatch(m, utts))
    .catch((e) => fail(m, "watch", e))
    .finally(() => m.busy--);
}

// 모은 말 가운데 확정 항목과 글이 조금이라도 겹치거나(0.05 이상) 동의 말·제안·질문이 나온 줄만 발화마다의 watch로 본다(순서대로).
// 나머지는 판단을 건너뛴다 — 어긋남 줄은 확정 항목과 글이 안 겹칠 수가 거의 없다(대본의 어긋남 줄은 모두 0.06 이상, brain-design §2-7).
// 한 프롬프트로 여러 말을 보게 했더니 어긋남을 많이 놓쳐서(대본 MIR 33~75%) 이렇게 바꿨다. 묶음에서 나온 어긋남은 손들기로.
export const BATCH_GATE_MIN = 0.05;
function batchGate(m: Meeting, u: Utt): boolean {
  if (isBackchannel(u.text)) return false;
  if (isAcceptance(u.text) || m.pendingCard || isTentative(u.text)) return true;
  return touchesConfirmed(m, u.text);
}
function touchesConfirmed(m: Meeting, text: string): boolean {
  const items = [...[...m.ctx.nodes.values()].filter(isConfirmed).map((n) => `${n.title} ${n.body}`), ...[...m.ctx.facts.values()].map((f) => f.text)];
  return items.some((x) => overlap(text, x) >= BATCH_GATE_MIN);
}

async function watchBatch(m: Meeting, utts: Utt[]): Promise<void> {
  for (const u of utts) {
    if (!batchGate(m, u)) {
      m.watchLog.push({ uttId: u.id, conflict: false, ids: [], second: "묶음 거름" });
      continue;
    }
    try {
      // 모은 말은 회의가 그 사이 끝나도 끝까지 본다 (채점·실제 모두 마지막 말 바로 뒤에 끝낼 수 있다)
      await watch(m, u, { handled: false, wake: false, handOnly: true, force: true });
    } catch (e) {
      fail(m, "watch", e);
    }
  }
}

// watch 출력의 맨 앞 `"conflict":{"found":…,"node_ids":[…],"fact_ids":[…]` 이 다 오면 바로 읽는다
const EARLY = /"conflict"\s*:\s*\{\s*"found"\s*:\s*(true|false)\s*,\s*"node_ids"\s*:\s*\[([^\]]*)\]\s*,\s*"fact_ids"\s*:\s*\[([^\]]*)\]/;
export function earlyConflict(soFar: string): { found: boolean; node_ids: string[]; fact_ids: string[] } | null {
  const mt = soFar.match(EARLY);
  if (!mt) return null;
  const list = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return { found: mt[1] === "true", node_ids: list(mt[2]), fact_ids: list(mt[3]) };
}

// 판단 시간 상한(TIMING.judgeCapMs)을 넘긴 말: watch가 앞 판단에 막혔거나(사슬은 한 줄) 그 요청이 API 꼬리에 걸렸다
// (ROLE_LIMITS watch 8초 × 다시 보내기 1번이면 16초+ — S6 A2에서 17.9초 동안 어긋남이 안 나오고 "끼어들지 마" 뒤 제안으로 옴).
// 1) partial로 미리 찾은 어긋남이 있으면 final 앞부분이 달라도 그걸로 바로. 2) 없으면 사슬 밖에서 새 watch를 짧은 상한·다시 보내기 없이.
// 늦게 끝난 원래 watch가 같은 근거를 찾으면 onConflict가 "같은 근거로 준비 중·방금 말함"으로 거른다.
// 규칙(겹침)만으로 내지는 않는다: 시나리오 A에서 어긋난 말의 겹침 0.19가 인사·안건 말(0.16·0.18)과 안 갈린다
async function judgeLate(m: Meeting, u: Utt): Promise<void> {
  if (m.ended || !m.roles.conflict || !canThink(m) || m.health.budgetHit) return;
  if (m.watchLog.some((x) => x.uttId === u.id)) return; // 제때 끝남
  if (m.cands.some((c) => c.uttId === u.id && c.kind === "conflict" && c.state !== "dropped")) return; // partial·앞부분으로 이미 시작
  if (isBackchannel(u.text) || !touchesConfirmed(m, u.text)) return;
  const log = (note: string) => void m.lateLog.push({ uttId: u.id, note });
  const d = m.drafts.get(u.id);
  if (d?.ids.length && !d.usedBy) {
    const ids = d.ids.filter((x) => !m.flagged.has(x));
    if (ids.length) {
      log("미리 판단 결과로");
      onConflict(m, u, { found: true, node_ids: ids.filter((x) => m.ctx.nodes.has(x)), fact_ids: ids.filter((x) => m.ctx.facts.has(x)), said: "", against: "" });
      const c = m.cands.find((x) => x.uttId === u.id && x.kind === "conflict" && x.state !== "dropped");
      if (c) {
        d.usedBy = c.actionId;
        c.viaPartial = true;
      }
      return;
    }
  }
  log("사슬 밖 새 watch");
  const roll = rolling(m, u.id, { splitSummary: true });
  const r = await ask(m, "watch", {
    system: [WATCH_SYSTEM, m.ctx.text, ...(roll.summaryBlock ? [roll.summaryBlock] : [])],
    user: [roll.text, `## 이번 발화\n${uttLine(u)}`].join("\n\n"),
    schema: WatchOut,
    maxTokens: 600,
    timeoutMs: TIMING.lateWatchMs,
    maxRetries: 0,
  });
  record(m, r.stat);
  if (m.ended || !r.out.conflict.found) return log(r.out.conflict.found ? "회의 끝" : "새 watch: 어긋남 없음");
  if (m.cands.some((c) => c.uttId === u.id && c.kind === "conflict" && c.state !== "dropped")) return log("새 watch: 그 사이 원래 판단이 냄");
  log("새 watch로 냄");
  onConflict(m, u, r.out.conflict);
}

type WatchOpts = { handled: boolean; wake: boolean; handOnly?: boolean; force?: boolean };
async function watch(m: Meeting, u: Utt, opts: WatchOpts): Promise<void> {
  if (m.ended && !opts.force) return;
  // 쉬는 중·꺼짐이면 건너뛴다. 비용 상한이면 부름이나 확정 항목과 많이 겹치는 말만 본다.
  const budgetSkip = m.health.budgetHit && !opts.wake && !secondLookTargets(m, u.text).length;
  if (!canThink(m) || budgetSkip) {
    m.health.skipped++;
    return;
  }
  if (!opts.handled) draftOnFinal(m, u, !!opts.handOnly);
  let finalFound: boolean | undefined;
  const roll = rolling(m, u.id, { splitSummary: true });
  m.tokenLog.push({ uttId: u.id, fixed: roughTokens(m.ctx.text), summary: roughTokens(m.summary), recent: roll.recentTokens });
  const preparing = m.cands.filter((c) => c.state === "preparing" || c.state === "ready");
  const user = [
    roll.text,
    `## 낸 카드 (이미 합의로 적은 것)\n${m.cards.map((c) => `- ${c.title}`).join("\n") || "(없음)"}`,
    `## 미티가 말하려고 준비 중인 것\n${preparing.map((c) => `- ${c.actionId}: ${c.said} ↔ ${c.against}`).join("\n") || "(없음)"}`,
    `## 이번 발화\n${uttLine(u)}`,
  ].join("\n\n");
  // 근거 id까지 오는 순간(watch 앞부분) 화면에 "할 말이 있어요"(queued)부터 보내고 대사 준비 → 사람이 판단 끝날 때까지 기다려 준다.
  // 근거가 확정된 것(합의된 결정·자료 사실)이 아니면 안 보낸다. 결국 아무것도 안 하게 되면 그 queued를 취소한다.
  let early = false;
  let preId: string | undefined;
  const onText = (soFar: string) => {
    if (early) return;
    const head = earlyConflict(soFar);
    if (!head) return;
    early = true;
    if (!head.found || (m.ended && !opts.force) || u.echo || isBackchannel(u.text)) return;
    const ids = confirmedIds(m, [...head.node_ids, ...head.fact_ids]).filter((id) => !m.flagged.has(id));
    // 같은 근거로 이미 준비 중이면 "할 말 있음"을 또 띄웠다 거두지 않는다 (P3: 바로잡는 말에 queued가 깜빡임)
    const busy = m.cands.some((c) => (c.state === "preparing" || c.state === "ready" || c.state === "delivering") && [...c.nodeIds, ...c.factIds].some((x) => ids.includes(x)));
    if (!quiet(m) && m.roles.conflict && ids.length && !busy && !opts.handOnly && !echoesEarlier(m, u, ids)) {
      preId = crypto.randomUUID();
      const nodeIds = ids.filter((id) => m.ctx.nodes.has(id));
      const factIds = ids.filter((id) => m.ctx.facts.has(id));
      const evidence = evidenceFor(m.ctx, nodeIds, factIds).slice(0, 1);
      emit(m, { type: "queued", actionId: preId, kind: "conflict", preview: "확정된 것과 다른 말이 나온 것 같아요", why: conflictWhy(m, nodeIds), evidence });
    }
    onConflict(m, u, { ...head, said: "", against: "" }, preId, false, opts.handOnly);
  };
  try {
    // 출력 JSON은 짧아서 600이면 넉넉하다 (감시 다이어트, cost-design ②). 요약은 따로 캐시되는 시스템 블록
    let res: Awaited<ReturnType<typeof ask<typeof WatchOut>>>;
    try {
      res = await ask(m, "watch", { system: [WATCH_SYSTEM, m.ctx.text, ...(roll.summaryBlock ? [roll.summaryBlock] : [])], user, schema: WatchOut, maxTokens: 600, onText });
    } catch (e) {
      // 판단이 깨져도 미티를 부른 사람은 기다리지 않게: 부르는 꼴이면 그 말 그대로를 물음으로 대답한다
      if (opts.wake && !opts.handled && !m.answered.has(u.id) && !u.echo && (isVocative(u.text) || isLeadingCall(u.text)) && !m.ended) queueAnswer(m, { u, mode: "call", question: u.text });
      throw e;
    }
    const { out, stat } = res;
    record(m, stat);
    if (m.ended && !opts.force) return;
    m.watchLog.push({ uttId: u.id, conflict: out.conflict.found, ids: [...out.conflict.node_ids, ...out.conflict.fact_ids] });
    finalFound = out.conflict.found;
    applyWatch(m, u, out, opts, preId);
    if (!out.conflict.found && !u.echo && !opts.handled) void track(m, secondLook(m, u, opts.handOnly, opts.force)).catch((e) => fail(m, "second", e));
  } finally {
    if (preId && !m.cands.some((c) => c.actionId === preId)) emit(m, { type: "cancel", actionId: preId, reason: "stale", note: "watch 끝: 할 일 없음(이미 짚었거나 같은 근거로 준비 중)" });
    settleDraft(m, u.id, finalFound); // 판단이 깨져도 미리 띄운 draft는 거둔다
  }
}


export function applyWatch(m: Meeting, u: Utt, out: WatchResult, opts: WatchOpts, preId?: string) {
  // 강도 하에선 서두를 게 없으니(손만 듦) "해결됨"으로 거두지 않는다
  // 맞장구("음, 일단 들어보자")는 앞의 어긋남을 바로잡은 말이 아니다
  for (const id of m.intensity === "low" || isBackchannel(u.text) ? [] : out.resolved) {
    const c = m.cands.find((x) => x.actionId === id && (x.state === "preparing" || x.state === "ready"));
    if (c) cancel(m, c, "stale", "대화로 해결됨");
  }

  // 맞장구("음, 일단 들어보자")는 무엇과도 어긋날 수 없다 — watch가 앞 말 때문에 짚는 일이 있었다 (D2 채점)
  if (out.conflict.found && !u.echo && !isBackchannel(u.text)) {
    // 앞부분으로 먼저 시작했으면 설명만 채운다
    const started = m.cands.find((c) => c.uttId === u.id && c.kind === "conflict" && !c.said);
    if (started) {
      started.said = out.conflict.said;
      started.against = out.conflict.against;
    } else onConflict(m, u, out.conflict, preId, false, opts.handOnly);
  }

  // 합의 카드는 동의가 실제로 나온 줄("네", "좋아", "그렇게 하자"…)에서만 낸다. 제안하는 줄이면 들고 있다가
  // 다음 한두 마디에 동의가 나오면 그때 낸다 (watch가 제안 줄에서 미리 합의로 보는 일이 잦다)
  const pend = m.pendingCard;
  if (pend && u.id - pend.uttId > 2) m.pendingCard = undefined;
  if (out.agreement.found && out.agreement.to && !u.echo) {
    const same = m.cards.some((c) => c.title === out.agreement.title);
    if (!same) {
      const ev: Evidence[] = [...new Set([...out.agreement.utt_ids, u.id])]
        .map((id) => m.utts.find((x) => x.id === id))
        .filter((x): x is Utt => !!x)
        .map((x) => ({ label: `지금 회의 — ${x.speaker ?? "누군가"}`, quote: x.text }));
      const card: Card = { cardId: `card_${crypto.randomUUID().slice(0, 8)}`, title: out.agreement.title, from: out.agreement.from ?? undefined, to: out.agreement.to, evidence: ev };
      if (isAcceptance(u.text)) {
        m.pendingCard = undefined;
        issueCard(m, card, u);
      } else m.pendingCard = { card, uttId: u.id };
    }
  } else if (m.pendingCard && !u.echo && isAcceptance(u.text)) {
    const { card } = m.pendingCard;
    m.pendingCard = undefined;
    card.evidence.push({ label: `지금 회의 — ${u.speaker ?? "누군가"}`, quote: u.text });
    issueCard(m, card, u);
  }

  // 부름: 호출어가 있고 모델도 미티에게 한 말로 볼 때만 (3인칭 언급은 거른다)
  const called = opts.wake && !m.answered.has(u.id) && (out.call.addressed || isVocative(u.text));
  if (called && !opts.handled) {
    if (out.call.want === "question" && out.call.question) {
      queueAnswer(m, { u, mode: "call", question: out.call.question }); // 실패하면 대답 줄이 짧게라도 답한다
    } else if (out.call.want === "speak_pending" && !parseSettingsCommand(u.text, "high") && !parseSettingsCommand(u.text, "low")) {
      // "미티야 끼어들지 마"(이미 하라서 바뀔 게 없는 설정 명령)를 손든 걸 말하라는 뜻으로 읽지 않는다
      const raised = m.cands.find((c) => c.state === "raised");
      if (raised) deliver(m, raised, "respond");
    }
  }
}

// watch(빠른 모델)가 "어긋남 없음"이라 했어도, 확정 항목과 말이 많이 겹치면 verify 모델로 한 번 더 본다.
// 실제 받아쓰기 문장에서 watch가 가끔 놓치는 걸(S7 E2E·재생 평가) 줄이려는 것. 겹치는 게 없으면 부르지 않는다.
export const SECOND_LOOK_MIN = 0.35;
function secondLookTargets(m: Meeting, text: string): { id: string; line: string; score: number }[] {
  const items = [
    ...[...m.ctx.nodes.values()].filter(isConfirmed).map((n) => ({ id: n.id, line: `${n.title} — ${n.body}` })),
    ...[...m.ctx.facts.values()].map((f) => ({ id: f.id, line: f.text })),
  ];
  return items
    .filter((x) => !m.flagged.has(x.id))
    .map((x) => ({ ...x, score: overlap(text, x.line) }))
    .filter((x) => x.score >= SECOND_LOOK_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// 질문·다시 열자는 논의 중인지 (이 말과 바로 앞 세 마디)
function inReopenTalk(m: Meeting, u: Utt): boolean {
  return m.utts.filter((x) => x.id <= u.id && x.id > u.id - 4).some((x) => isTentative(x.text));
}

async function secondLook(m: Meeting, u: Utt, handOnly = false, force = false): Promise<void> {
  // 결정을 다시 여는 논의 중엔 다시 보지 않는다 (거기서 놓치는 것보다 잘못 끼어드는 게 더 나쁘다)
  if ((m.ended && !force) || inReopenTalk(m, u) || !canThink(m)) return;
  const targets = secondLookTargets(m, u.text);
  if (!targets.length) return;
  const roll = rolling(m, u.id);
  const r = await ask(m, "verify", {
    system: [SECOND_SYSTEM, m.ctx.text],
    user: `${roll.text}\n\n## 이번 발화\n${uttLine(u)}\n\n## 후보 항목\n${targets.map((t) => `- [${t.id}] ${t.line}`).join("\n")}`,
    maxTokens: 400,
  });
  record(m, r.stat);
  const vr = parseVerify(r.text);
  const log = m.watchLog.find((x) => x.uttId === u.id);
  if (log) log.second = vr.ok ? `OK ${vr.ids.join(",")}` : "NO";
  if (!vr.ok || (m.ended && !force)) return;
  const ids = vr.ids.filter((id) => targets.some((t) => t.id === id));
  if (!ids.length) return;
  onConflict(m, u, { found: true, node_ids: ids.filter((id) => m.ctx.nodes.has(id)), fact_ids: ids.filter((id) => m.ctx.facts.has(id)), said: "", against: "" }, undefined, true, handOnly);
}

function issueCard(m: Meeting, card: Card, u: Utt) {
  if (m.cards.some((c) => c.title === card.title)) return;
  m.cards.push(card);
  emit(m, { type: "change_card", ...card });
  scheduleChecklist(m);
  watchOwnerGap(m, card, u);
  watchFeedback(m, card, u);
}

// ── 피드백 (feedback, brain-design §2-2 #6) ────────────────────────
// 새 결정(바꾸는 게 아니라 처음 정함)이 제안부터 동의까지 3마디 안에, 반론 말 없이 정해졌고, 그 결정과 글이 겹치는 기록(의견·거절된 안·
// 질문)이나 자료 사실이 있을 때만 모델에 "걸리는 게 있나"를 묻는다. 근거가 붙은 질문이 오면 한 번 짚는다(예산 1). 없으면 아무것도 안 함.
const OBJECTION = /근데|하지만|그런데|글쎄|반대|걱정|아닌\s*것\s*같|별로|어렵|위험|괜찮을까|시간\s*되/;
const FEEDBACK_MIN_OVERLAP = 0.25;
// 바꾸는 결정이면(withAgreed) 합의된 결정도 넣는다 — 바뀌는 그 결정이 걸리는 기록 (새 결정마다 넣으면 오탐: 11/2 리허설 상황 2).
// 미티가 방금(3마디 안) 어긋남으로 짚은 근거는 빼서 되풀이하지 않는다 — 오래전에 짚었고 그 뒤 급히 정했으면 다시 물을 만하다
// (11/2 리허설 상황 3: #1에서 10/28 결정을 짚고 #6에서 급히 정함)
function feedbackTargets(m: Meeting, text: string, withAgreed = false, atId = Infinity): { id: string; line: string }[] {
  const justSaid = (id: string) => m.cands.some((c) => c.kind === "conflict" && c.state !== "dropped" && (c.nodeIds.includes(id) || c.factIds.includes(id)) && atId - c.uttId <= 3);
  const items = [
    ...[...m.ctx.nodes.values()].filter((n) => n.type !== "action" && !justSaid(n.id) && (withAgreed || !(n.type === "decision" && n.status === "agreed"))).map((n) => ({ id: n.id, title: n.title, line: `${n.title} — ${n.body}` })),
    ...[...m.ctx.facts.values()].filter((f) => !justSaid(f.id)).map((f) => ({ id: f.id, title: f.text, line: f.text })),
  ];
  // 카드 글이 길면 겹침 비율이 묽어진다 → 기록 제목이 카드에 얼마나 들어 있는지도 같이 본다
  return items
    .map((x) => ({ id: x.id, line: x.line, s: Math.max(overlap(text, x.line), overlap(x.title, text)) }))
    .filter((x) => x.s >= FEEDBACK_MIN_OVERLAP)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4);
}
// 바꾸는 결정(card.from)도 반론 없이 급하게 바꿨으면 본다 — 바뀌는 그 결정이 걸리는 기록이다
// (11/2 리허설 상황 3: "테스트 결과 보고 정하기"(10/28)를 "그냥 한 장으로"로 바꿨는데 0/3 — from이 있으면 아예 안 봤음)
function watchFeedback(m: Meeting, card: Card, u: Utt) {
  if (!m.roles.feedback || !canThink(m)) return;
  const quoted = m.utts.filter((x) => card.evidence.some((e) => e.quote === x.text));
  const firstId = Math.min(u.id, ...quoted.map((x) => x.id));
  if (u.id - firstId > 3) return;
  if (m.utts.some((x) => x.id >= firstId && x.id <= u.id && OBJECTION.test(x.text))) return;
  const targets = feedbackTargets(m, `${card.title} ${card.from ?? ""} ${card.to}`, !!card.from, u.id);
  if (!targets.length) return;
  void track(m, feedback(m, card, u, targets)).catch((e) => fail(m, "feedback", e));
}
async function feedback(m: Meeting, card: Card, u: Utt, targets: { id: string; line: string }[]): Promise<void> {
  const roll = rolling(m, u.id);
  const r = await ask(m, "verify", {
    system: [FEEDBACK_SYSTEM, m.ctx.text],
    user: `${roll.text}\n\n## 방금 정한 것\n${card.title} — ${card.from ? `전엔 "${card.from}"였는데 이번에 ` : ""}${card.to}\n\n## 관련 기록·자료\n${targets.map((t) => `- [${t.id}] ${t.line}`).join("\n")}`,
    maxTokens: 300,
  });
  record(m, r.stat);
  if (m.ended) return;
  const { lines, ids } = parseLines(r.text);
  const ok = ids.filter((id) => targets.some((t) => t.id === id));
  if (!lines.length || /^NONE\b/i.test(lines[0]) || !ok.length) return;
  const nodeIds = ok.filter((id) => m.ctx.nodes.has(id));
  const factIds = ok.filter((id) => m.ctx.facts.has(id));
  const c = newCandidate(m, u, "feedback", { sentences: [stripOpener(lines[0])], evidence: evidenceFor(m.ctx, nodeIds, factIds), nodeIds, factIds, verified: true, staleAfter: 1 });
  c.why = "정한 것과 걸리는 기록이 있어요";
  // 그 사이 반론이 나왔으면 그 사람을 두고 미티는 빠진다
  if (m.utts.some((x) => x.id > u.id && OBJECTION.test(x.text))) {
    c.state = "dropped";
    c.note = "반론이 나옴";
    return;
  }
  c.queued = !quiet(m) && chan(m, c.kind) === "voice";
  if (c.queued) emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: c.why, evidence: c.evidence.slice(0, 1) });
  markReady(m, c);
}

// ── 리서치 카드 (research, brain-design §2-2 #5) ─────────────────
// 팀원끼리 "그게 언제였지?"처럼 기억이 안 나는 걸 물었는데 다음 말에 답이 없거나 1.5초 조용하면, 기록·자료에서 찾아 소리 없이 카드로.
// 근거가 없으면 안 낸다. 1분에 1장. 미티를 부른 말은 대답 길이 따로 있다.
export const RESEARCH_CARD_GAP_MS = 60_000;
function checkResearch(m: Meeting, u: Utt) {
  const p = m.researchPending;
  if (p && u.id > p.uttId && !u.echo && !isBackchannel(u.text)) {
    m.researchPending = undefined;
    if (!looksLikeAnswer(u.text)) startResearch(m, p);
  }
  if (!m.roles.research || u.echo || hasWakeWord(u.text) || !isKnowledgeGap(u.text)) return;
  m.researchPending = { uttId: u.id, question: u.text };
}
function startResearch(m: Meeting, p: { uttId: number; question: string }) {
  if (m.ended || !canThink(m) || Date.now() - m.lastCardAt < RESEARCH_CARD_GAP_MS) return;
  const u = m.utts.find((x) => x.id === p.uttId);
  if (!u) return;
  m.lastCardAt = Date.now();
  void track(m, research(m, u, p.question)).catch((e) => fail(m, "research", e));
}
async function research(m: Meeting, u: Utt, question: string): Promise<void> {
  const roll = rolling(m, u.id);
  const { text, stat } = await ask(m, "speak", {
    system: [ANSWER_SYSTEM, m.ctx.text],
    user: `${roll.text}\n\n## 오늘 회의에서 합의한 것\n${m.cards.map((c) => `- ${c.title}`).join("\n") || "(아직 없음)"}\n\n## 팀원끼리 한 물음 (미티를 부른 건 아님 — 답은 화면 카드로만 보여 준다)\n${uttLine(u)}`,
    maxTokens: 600,
  });
  record(m, stat);
  if (m.ended) return;
  const { lines: all, ids } = parseLines(text);
  const web = splitWebQuery(all);
  if (web.query) return webResearch(m, u, web.query, "research"); // 기록·자료엔 없고 바깥 정보 — 웹에서 찾아 카드로
  const lines = web.lines;
  const nodeIds = ids.filter((id) => m.ctx.nodes.has(id));
  const factIds = ids.filter((id) => m.ctx.facts.has(id));
  const evidence = evidenceFor(m.ctx, nodeIds, factIds);
  // "기록엔 ~ 없어요"처럼 못 찾았다는 대답은 안 낸다 (11/2 리허설: 다이얼 9에서 "기록엔 전환율 숫자가 없어요"를 소리로 — "기록엔"을 못 걸렀음)
  if (!lines.length || !evidence.length || lines.some((l) => /(기록|자료)(에는|엔|에)[^.?!]*없/.test(l))) return;
  const c = newCandidate(m, u, "research", { sentences: lines, evidence, nodeIds, factIds, verified: true });
  // 찾는 사이 누가 답했으면 카드는 안 낸다 (RC2 채점: 1.5초 쉬고 "11월 2일이요"가 나옴)
  if (m.utts.some((x) => x.id > u.id && !x.echo && looksLikeAnswer(x.text))) {
    c.state = "dropped";
    c.note = "찾는 사이 답이 나옴";
    return;
  }
  m.found.push({ query: question, lines });
  const title = question.length > 40 ? `${question.slice(0, 39)}…` : question;
  const sources = [...new Set(evidence.map((e) => e.label))].slice(0, 2);
  emit(m, { type: "show", actionId: c.actionId, canvas: { kind: "text", title, lines: [...lines, ...sources.map((x) => `출처: ${x}`)] }, ttlMs: 60_000 });
  // 다이얼이 소리(8 이상)면 카드와 함께 한 문장 (11/2 리허설: 참여도 9인데 "지난달 전환율 2.3%"가 카드로만). 차례가 아니면 들고 있다가 다음 긴 침묵에
  const ch = chan(m, "research");
  c.state = "shown"; // 먼저 카드로 — 이 후보가 '준비 중'으로 남으면 meetyBusy가 자기 자신을 바쁘다고 본다
  c.t.delivered = Date.now();
  if (ch === "voice" && !meetyBusy(m) && latestRealId(m) - u.id <= 2) {
    c.sentences = [lines[0]];
    c.queued = true;
    emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: "기록에서 찾아봤어요", evidence: c.evidence.slice(0, 1) });
    return markReady(m, c);
  }
  if (ch === "voice") m.webHeld.push({ u, query: question, line: lines[0], evidence, at: Date.now(), web: false });
}

// ── 조용한 멤버 (quiet_member, brain-design §2-2 #4) — 코드만 ───────────
// 참여자 목록에 있는 사람이 다른 사람들 말 QUIET_AFTER마디 동안 한 마디도 안 했으면(회의 QUIET_MIN마디 넘은 뒤), 그 사람에게만 사설로.
// 화자를 모르는 받아쓰기(speaker 없음)에선 안 한다. 같은 사람에게 10분에 한 번.
export const QUIET = { after: 24, minUtts: 30, againMs: 600_000 };
function checkQuiet(m: Meeting, u: Utt) {
  if (!m.roles.quiet_member || chan(m, "quiet_member") === "off" || u.echo || m.participants.length < 3) return;
  const real = m.utts.filter((x) => !x.echo && !isBackchannel(x.text));
  if (real.length < QUIET.minUtts || !real.some((x) => x.speaker)) return;
  for (const p of m.participants) {
    if (p === u.speaker) continue;
    const lastIdx = real.map((x) => x.speaker).lastIndexOf(p);
    const since = real.length - 1 - lastIdx; // 그 사람 마지막 말 뒤(없으면 회의 처음부터) 다른 사람 말 수
    if (since < QUIET.after) continue;
    const at = m.quietNotified.get(p) ?? 0;
    if (Date.now() - at < QUIET.againMs) continue;
    m.quietNotified.set(p, Date.now());
    const c = newCandidate(m, u, "quiet_member", { sentences: [`${p}님, 지금 얘기에 덧붙일 생각이 있으면 편하게 말하거나 미티에게 적어 주세요.`], verified: true });
    c.state = "shown";
    c.t.delivered = Date.now();
    emit(m, { type: "private", actionId: c.actionId, to: p, kind: "quiet_member", text: c.sentences[0], evidence: [] });
  }
}

// ── 갈등 구조 제안 (structure, brain-design §2-2 #3) ────────────────────
// 최근 8마디에 맞서는 말 꼴(근데·아니·그래도…)이 두 사람 이상에게서 3번 넘게, 같은 논점(글 겹침)이면 모델이 두 입장을 한 줄씩 정리 →
// "두 입장을 한 줄씩 정리해 볼까요?" + 비교 카드(show compare). 판정은 안 한다. 격한 말이 보이면 참는다. 3분에 한 번.
export const STRUCTURE = { window: 8, minDisagree: 3, minOverlap: 0.15, againMs: 180_000 };
function checkStructure(m: Meeting, u: Utt) {
  if (!m.roles.structure || chan(m, "structure") === "off" || u.echo || m.ended || !canThink(m)) return;
  if (Date.now() - m.lastStructureAt < STRUCTURE.againMs) return;
  const recent = m.utts.filter((x) => !x.echo && !isBackchannel(x.text)).slice(-STRUCTURE.window);
  if (recent.some((x) => isHeated(x.text))) return;
  const dis = recent.filter((x) => isDisagreement(x.text));
  const speakers = new Set(recent.map((x) => x.speaker ?? "?"));
  if (dis.length < STRUCTURE.minDisagree || speakers.size < 2) return;
  // 같은 논점인지: 맞서는 말끼리 글이 겹치는지
  const pairs = dis.slice(1).map((x, i) => overlap(x.text, dis[i].text));
  if (Math.max(0, ...pairs) < STRUCTURE.minOverlap) return;
  m.lastStructureAt = Date.now();
  void track(m, structure(m, u, recent)).catch((e) => fail(m, "structure", e));
}
async function structure(m: Meeting, u: Utt, recent: Utt[]): Promise<void> {
  const r = await ask(m, "verify", { system: [STRUCTURE_SYSTEM, m.ctx.text], user: `## 최근 발화\n${recent.map(uttLine).join("\n")}`, maxTokens: 300 });
  record(m, r.stat);
  if (m.ended || /^\s*NONE\b/i.test(r.text)) return;
  let out: { topic: string; a_label: string; a: string; b_label: string; b: string };
  try {
    out = StructureOut.parse(JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)));
  } catch {
    return;
  }
  if (!out.a || !out.b) return;
  const c = newCandidate(m, u, "structure", { sentences: ["두 입장을 한 줄씩 정리해 볼까요?"], evidence: recent.slice(-3).map((x) => ({ label: `지금 회의 — ${x.speaker ?? "누군가"}`, quote: x.text })), verified: true, staleAfter: 3 });
  c.why = "같은 얘기가 맞서며 되풀이되고 있어요";
  emit(m, { type: "show", actionId: c.actionId, canvas: { kind: "compare", title: out.topic || "두 입장", aLabel: out.a_label || "A", bLabel: out.b_label || "B", rows: [{ label: "입장", a: out.a, b: out.b }] }, ttlMs: 120_000 });
  c.queued = !quiet(m) && chan(m, "structure") === "voice";
  if (c.queued) emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: c.why, evidence: c.evidence.slice(0, 1) });
  markReady(m, c);
}

// ── 제안·추천 (suggest, brain-design §2-2 #7) ───────────────────────────
// 아이디어를 찾는 말("…아이디어 뭐 없을까?") 뒤에 막힌 말("음… 글쎄요")이 오거나, 1.5초 + suggestWaitMs 동안 아무도 말이 없으면,
// 기록·자료에 근거해 1~2개를 두 번째 응답자로 거든다. 다이얼 5~7은 카드, 8부터 소리. 근거 없으면 안 낸다. 2분에 한 번.
export const SUGGEST_AGAIN_MS = 120_000;
function checkSuggest(m: Meeting, u: Utt) {
  const p = m.suggestPending;
  if (p && u.id > p.uttId && !u.echo) {
    m.suggestPending = undefined;
    // 다른 사람이 아이디어를 냈으면(막힌 말이 아니면) 미티는 빠진다
    if (isStall(u.text)) startSuggest(m, u);
  }
  if (!m.roles.suggest || chan(m, "suggest") === "off" || u.echo || hasWakeWord(u.text) || !isIdeaSeeking(u.text)) return;
  m.suggestPending = { uttId: u.id };
}
function startSuggest(m: Meeting, u: Utt) {
  if (m.ended || !canThink(m) || Date.now() - m.lastSuggestAt < SUGGEST_AGAIN_MS) return;
  m.lastSuggestAt = Date.now();
  void track(m, suggest(m, u)).catch((e) => fail(m, "suggest", e));
}
async function suggest(m: Meeting, u: Utt): Promise<void> {
  const roll = rolling(m, u.id);
  const r = await ask(m, "speak", { system: [SUGGEST_SYSTEM, m.ctx.text], user: `${roll.text}\n\n팀이 아이디어를 찾다가 막혔다. 거들 것 1~2개.`, maxTokens: 400 });
  record(m, r.stat);
  if (m.ended) return;
  const { lines, ids } = parseLines(r.text);
  if (!lines.length || /^NONE\b/i.test(lines[0])) return;
  const nodeIds = ids.filter((id) => m.ctx.nodes.has(id));
  const factIds = ids.filter((id) => m.ctx.facts.has(id));
  const evidence = evidenceFor(m.ctx, nodeIds, factIds);
  if (!evidence.length) return;
  // 그 사이 누가 아이디어를 냈으면 안 낸다
  if (m.utts.some((x) => x.id > u.id && !x.echo && !isStall(x.text))) return;
  const sentences = lines.map(stripOpener).filter(Boolean).slice(0, 2);
  const c = newCandidate(m, u, "suggest", { sentences, evidence, nodeIds, factIds, verified: true, staleAfter: 1 });
  c.why = "아이디어를 찾고 있어서 하나 거들게요";
  const sources = [...new Set(evidence.map((e) => e.label))].slice(0, 2);
  emit(m, { type: "show", actionId: c.actionId, canvas: { kind: "text", title: "미티의 제안", lines: [...sentences, ...sources.map((x) => `근거: ${x}`)] }, ttlMs: 90_000 });
  if (chan(m, "suggest") !== "voice") {
    c.state = "shown";
    c.t.delivered = Date.now();
    return;
  }
  c.queued = !quiet(m);
  if (c.queued) emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: c.why, evidence: c.evidence.slice(0, 1) });
  markReady(m, c);
}

// ── 역할 빈칸 (owner_gap, brain-design §2-2 #2) — 코드만 ─────────────
// 담당이 필요한 안건(기대 산출물에 "담당")의 합의 카드가 났는데 카드·근거 말에 담당이 없으면 후보를 만들고,
// 이어진 말에 사람 이름·"제가 할게요"가 나오면 조용히 거둔다. 담당 없이 다음 말로 넘어가면 "누가 맡을까요?" 한 번.
const OWNER_GAP_STALE = 3;
function needsOwner(m: Meeting, card: Card): boolean {
  const text = `${card.title} ${card.to}`;
  if (/담당/.test(card.title)) return true;
  return m.agenda.some((a) => a.expected.some((e) => /담당/.test(e)) && overlap(a.title, text) >= 0.5);
}
function namesOwner(m: Meeting, text: string): boolean {
  return isAssignment(text) || m.participants.some((p) => p.length >= 2 && text.includes(p));
}
function watchOwnerGap(m: Meeting, card: Card, u: Utt) {
  if (!m.roles.owner_gap || !needsOwner(m, card)) return;
  if (namesOwner(m, `${card.title} ${card.to} ${card.evidence.map((e) => e.quote ?? "").join(" ")}`)) return;
  const topic = card.title.split(/[:：]/)[0].trim() || card.title;
  const c = newCandidate(m, u, "owner_gap", { sentences: [`방금 정한 ${topic} 건은 누가 맡을까요?`], evidence: [{ label: `오늘 정함 — ${card.title}`, quote: card.to }], verified: true, staleAfter: OWNER_GAP_STALE });
  c.why = "정한 일에 담당이 아직 없어요";
  checkOwnerGaps(m);
}
// 새 발화마다: 담당이 나오면 거두고, 담당 없이 한 마디 넘어가면 준비 완료
function checkOwnerGaps(m: Meeting) {
  for (const c of m.cands) {
    if (c.kind !== "owner_gap" || c.state !== "preparing") continue;
    const after = m.utts.filter((x) => x.id > c.uttId && !x.echo && !isBackchannel(x.text));
    if (after.some((x) => namesOwner(m, x.text))) {
      c.state = "dropped";
      c.note = "담당이 나옴";
      continue;
    }
    if (!after.length) continue;
    c.queued = !quiet(m) && chan(m, c.kind) === "voice";
    if (c.queued) emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: c.why, evidence: c.evidence });
    markReady(m, c);
  }
}

// watch가 근거 id에 이 발화와 전혀 상관없는 결정을 섞는 일이 있다 → 말이 하나도 안 겹치는 id는 뺀다 (겹치는 게 하나라도 있을 때만)
// 어긋남의 근거로 쓸 id: 합의되지 않은 결정(제안·거절된 것)은 뺀다. 남은 게 확정된 것(합의된 결정·날짜가 잡힌 할 일·자료 사실)을
// 하나도 못 짚으면 없음. (E2E day2 10/30: 앞 회의에서 "제안"으로만 남은 "리허설 일요일"을 watch가 짚음 → queued 뒤 verify가 "확정 아님"으로 거둠)
function confirmedIds(m: Meeting, ids: string[]): string[] {
  const kept = ids.filter((id) => {
    const n = m.ctx.nodes.get(id);
    return n ? n.type !== "decision" || n.status === "agreed" : m.ctx.facts.has(id);
  });
  return kept.some((id) => {
    const n = m.ctx.nodes.get(id);
    return n ? isConfirmed(n) : m.ctx.facts.has(id);
  })
    ? kept
    : [];
}

// "왜" 카드 한 줄: 무엇과 어긋나 보이는지 (소리 전에 화면에 뜬다)
function conflictWhy(m: Meeting, nodeIds: string[]): string {
  const n = nodeIds.map((id) => m.ctx.nodes.get(id)).find((x) => x && isConfirmed(x));
  if (!n) return "기획 문서와 달라 보여요";
  return n.type === "action" ? "잡아 둔 일정과 달라 보여요" : "지난 회의에서 정한 것과 달라 보여요";
}

function lineOf(m: Meeting, id: string): string {
  const n = m.ctx.nodes.get(id);
  if (n) return `${n.title} ${n.body}`;
  return m.ctx.facts.get(id)?.text ?? "";
}

// 미리 만든 말은 근거 가운데 이번 말과 가장 많이 겹치는 것의 것으로 (watch가 같은 절의 다른 사실을 앞에 적는 일이 있었다:
// "젯슨 AGX 박스" 말에 "이름은 미티" 말을 꺼냄 — P2 채점 10/30)
function bestTemplate(m: Meeting, text: string, ids: string[]): string | undefined {
  const withTpl = ids.filter((x) => m.templates.has(x));
  return withTpl.reduce<string | undefined>((best, id) => (best === undefined || overlap(text, lineOf(m, id)) > overlap(text, lineOf(m, best)) ? id : best), undefined);
}

function pruneIds(m: Meeting, text: string, ids: string[]): string[] {
  const scored = ids.map((id) => ({ id, s: overlap(text, lineOf(m, id)) }));
  const best = Math.max(0, ...scored.map((x) => x.s));
  if (best === 0) return ids;
  // 가장 많이 겹치는 근거의 3분의 1도 안 겹치면 우연히 글자 두어 개가 같은 것 ("디스코드"의 "코드" 등)
  return scored.filter((x) => x.s >= best / 3).map((x) => x.id);
}

function newCandidate(m: Meeting, u: Utt, kind: ActionKind, fields: Partial<Candidate>): Candidate {
  const c: Candidate = {
    actionId: crypto.randomUUID(),
    kind,
    uttId: u.id,
    state: "preparing",
    said: "",
    against: "",
    nodeIds: [],
    factIds: [],
    sentences: [],
    evidence: [],
    verified: false,
    hold: false,
    queued: false,
    t: { final: u.receivedAt },
    ...fields,
  };
  m.cands.push(c);
  return c;
}

// preId: watch가 "found":true를 냈을 때 먼저 보낸 queued의 actionId (같은 걸로 이어 간다)
// verified: 두 번째로 보기처럼 이미 verify 모델이 맞다고 한 것 (다시 확인하지 않는다)
const ID_FIX_MIN = 0.1;
// 동의·마무리 말("오케이, 오늘은 여기까지")에 근거와 겹치는 글이 하나도 없으면 그 말이 아니라 앞 말을 다시 짚는 것
// (다이얼 2 N1: 손든 "녹음 병행" 어긋남을 마무리 말에서 다른 근거 id로 또 손듦)
function echoesEarlier(m: Meeting, u: Utt, ids: string[]): boolean {
  return (isAcceptance(u.text) || isEndPhrase(u.text)) && ids.every((id) => overlap(u.text, lineOf(m, id)) === 0);
}

function onConflict(m: Meeting, u: Utt, conflict: WatchResult["conflict"], preId?: string, verified = false, handOnly = false) {
  if (!m.roles.conflict) return;
  // 같은 결정을 또 짚지 않는다(이미 말했거나 손든 것은 근거에서 뺀다). 남은 근거가 없으면 안 한다.
  // (watch가 이미 짚은 결정을 같이 적는 일이 잦다 — 그걸로 새 어긋남까지 버리면 안 된다)
  let kept = pruneIds(m, u.text, confirmedIds(m, [...conflict.node_ids, ...conflict.fact_ids]).filter((id) => !m.flagged.has(id)));
  if (echoesEarlier(m, u, kept)) return;
  // watch가 적은 근거가 이번 말과 글자 하나 안 겹치면 id를 잘못 적었을 수 있다 → 확정된 것 가운데 가장 많이 겹치는 것으로 바꾼다
  // (P2: "젯슨 AGX 박스" 말에 자료의 맨 끝 사실 #52를 적음. 맞는 건 #46 "Jetson AGX 박스는 쓰지 않기로", 겹침 0.14)
  if (kept.length && kept.every((id) => overlap(u.text, lineOf(m, id)) === 0)) {
    const alt = [...[...m.ctx.nodes.values()].filter(isConfirmed).map((n) => n.id), ...m.ctx.facts.keys()]
      .filter((id) => !m.flagged.has(id))
      .map((id) => ({ id, s: overlap(u.text, lineOf(m, id)) }))
      .filter((x) => x.s >= ID_FIX_MIN)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map((x) => x.id);
    if (alt.length) kept = alt;
  }
  const nodeIds = kept.filter((id) => m.ctx.nodes.has(id));
  const factIds = kept.filter((id) => m.ctx.facts.has(id));
  const ids = [...nodeIds, ...factIds];
  if (!ids.length) return;
  // 같은 근거로 준비 중이거나, 방금(30초 안) 말했거나 손든 게 있으면 또 안 만든다 (묶음과 부름이 겹칠 때 둘 다 나오던 것)
  const recent = (c: Candidate) => (c.state === "raised" || c.state === "spoken") && !!c.t.delivered && Date.now() - c.t.delivered < 30_000;
  const busyWith = m.cands.some((c) => (c.state === "preparing" || c.state === "ready" || c.state === "delivering" || recent(c)) && [...c.nodeIds, ...c.factIds].some((x) => ids.includes(x)));
  if (busyWith) return;
  // 1:1에서 이 말에 이미 대답했으면(대답이 어긋남도 짚음) 또 안 만든다
  if (m.solo && m.cands.some((c) => c.uttId === u.id && c.kind === "answer")) return;
  // 같은 발화로 partial에서 이어 쓴 어긋남이 이미 있으면 final watch가 근거 id를 달리 적어도 또 안 만든다 (AV: 같은 말에 손들기 두 번)
  if (m.cands.some((c) => c.viaPartial && c.uttId === u.id && c.state !== "dropped")) return;

  // 묶음에서 나온 건 이미 몇 마디 지난 말이라 "주제 넘어감"으로 거두지 않고 확인 뒤 손든다
  const c = newCandidate(m, u, "conflict", { said: conflict.said, against: conflict.against, nodeIds, factIds, handOnly, ...(handOnly ? { staleAfter: 99 } : {}), ...(preId ? { actionId: preId, queued: true } : {}) });
  c.t.detect = Date.now();
  c.evidence = evidenceFor(m.ctx, nodeIds, factIds);
  const tplId = bestTemplate(m, u.text, ids);
  if (!quiet(m) && !preId && !handOnly) {
    c.queued = true;
    emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: tplId ? m.templates.get(tplId)! : (c.evidence[0]?.label ?? "확정된 것과 다른 말이 나왔어요"), why: conflictWhy(m, nodeIds), evidence: c.evidence.slice(0, 1) });
  }
  if (tplId) {
    // 빠른 길: 미리 만든 말로 바로 준비. 근거 확인은 뒤에서 하고, 아니라고 하면 말하기 전이면 거둔다
    c.sentences = [m.templates.get(tplId)!];
    c.t.template = true;
    // 이 말이나 바로 앞 몇 마디가 질문·다시 열자는 논의면, 그 논의 속 찬성·반대 말일 수 있다 → 확인을 기다린다
    // 안 끝난 말·무언가를 부정하는 말도 watch가 헷갈리기 쉬워서 확인을 기다린다.
    // 고른 근거가 이번 말과 글자 하나 안 겹치면 watch가 id를 잘못 적었을 수 있다 → 확인이 근거를 고쳐 줄 때까지 기다린다
    // (P2 채점: "젯슨 AGX 박스" 말에 근거로 "이름은 미티" 사실만 적어 그 말을 꺼냄)
    c.hold = inReopenTalk(m, u) || needsCheck(u.text) || overlap(u.text, lineOf(m, tplId)) === 0;
    // 확인 글은 말하기 전에 만든다 (먼저 말해 버리면 "미티가 이미 한 말"에 자기 말이 들어가 "이미 짚음"으로 버려진다)
    if (verified) c.verified = true;
    else void track(m, verifyInBackground(m, c)).catch((e) => fail(m, "verify", e));
    markReady(m, c);
  } else {
    void track(m, prepare(m, c)).catch((e) => {
      drop(m, c, "준비 실패");
      fail(m, "prepare", e);
    });
  }
}

function markReady(m: Meeting, c: Candidate) {
  c.state = "ready";
  c.t.ready = Date.now();
  voiceOut(m, { type: "prepare", actionId: c.actionId, kind: c.kind, sentences: c.kind === "conflict" ? conflictSpeech(m, c.sentences, c.respoken) : c.sentences });
  tryDeliver(m);
}

function drop(m: Meeting, c: Candidate, note: string) {
  const shown = c.queued;
  c.state = "dropped";
  c.note = note;
  if (shown) emit(m, { type: "cancel", actionId: c.actionId, reason: "stale", note });
}

function conflictPrompt(m: Meeting, c: Candidate): string {
  const roll = rolling(m, c.uttId);
  const target = m.utts.find((u) => u.id === c.uttId)!;
  return `${roll.text}\n\n## 방금 발화\n${uttLine(target)}\n\n## 미티가 본 어긋남\n발화: ${c.said || target.text}\n확정된 것: ${c.against || c.evidence.map((e) => e.label).join(" / ")}\n근거 id: ${[...c.nodeIds, ...c.factIds].join(", ")}`;
}

async function runVerify(m: Meeting, c: Candidate, after: string): Promise<ReturnType<typeof parseVerify>> {
  const t0 = Date.now();
  const r = await ask(m, "verify", { system: [VERIFY_SYSTEM, m.ctx.text], user: `${conflictPrompt(m, c)}\n\n## 그 뒤 대화\n${after}\n\n정말 끼어들어도 되는지 확인해라.`, maxTokens: 800 });
  record(m, r.stat);
  c.t.verifyMs = Date.now() - t0;
  return parseVerify(r.text);
}

function refineIds(m: Meeting, c: Candidate, ids: string[]) {
  const nodeIds = ids.filter((id) => m.ctx.nodes.has(id));
  const factIds = ids.filter((id) => m.ctx.facts.has(id));
  if (!nodeIds.length && !factIds.length) return;
  c.nodeIds = nodeIds;
  c.factIds = factIds;
  c.evidence = evidenceFor(m.ctx, nodeIds, factIds);
}

async function verifyInBackground(m: Meeting, c: Candidate): Promise<void> {
  const vr = await runVerify(m, c, "(아직 없음)");
  c.t.verifyOk = vr.ok;
  if (!vr.ok) {
    if (c.state === "ready" || c.state === "preparing") return drop(m, c, `확인에서 버림: ${vr.reason}`);
    if (c.state === "raised") return cancel(m, c, "stale", `확인에서 버림: ${vr.reason}`);
    c.t.lateNo = true;
    c.note = `말한 뒤 확인에서 아니라고 함: ${vr.reason}`;
    return;
  }
  if (c.state === "ready") {
    refineIds(m, c, vr.ids);
    // 확인이 근거를 좁혔는데 미리 고른 말이 빠진 근거 것이면, 아직 말하기 전이니 맞는 말로 바꾼다
    const ids = [...c.nodeIds, ...c.factIds];
    const tpl = c.t.template && bestTemplate(m, m.utts.find((u) => u.id === c.uttId)?.text ?? "", ids);
    if (tpl && m.templates.get(tpl) !== c.sentences[0]) {
      c.sentences = [m.templates.get(tpl)!];
      voiceOut(m, { type: "prepare", actionId: c.actionId, kind: c.kind, sentences: conflictSpeech(m, c.sentences) });
    }
  }
  c.verified = true;
  tryDeliver(m);
}

// 느린 길: 대사와 근거 확인을 같이 돌린다 (지연은 둘 중 긴 쪽)
async function prepare(m: Meeting, c: Candidate): Promise<void> {
  const base = conflictPrompt(m, c);
  const [sp, vr] = await Promise.all([
    ask(m, "speak", { system: [SPEAK_SYSTEM, m.ctx.text], user: `${base}\n\n끼어들 말을 1~2문장으로.`, maxTokens: 800 }).then((r) => {
      record(m, r.stat);
      return r;
    }),
    runVerify(m, c, "(아직 없음)"),
  ]);
  c.t.verifyOk = vr.ok;
  if (c.state !== "preparing") return; // 그 사이 취소됨
  if (!vr.ok) return drop(m, c, `확인에서 버림: ${vr.reason}`);
  refineIds(m, c, vr.ids);
  c.sentences = parseLines(sp.text)
    .lines.map(stripOpener)
    .filter(Boolean)
    .flatMap(splitSentences)
    .slice(0, 1); // 둘째 문장은 되묻는 말(conflictSpeech)
  if (!c.sentences.length || !c.evidence.length) return drop(m, c, "대사나 근거가 비었음");
  c.verified = true;
  markReady(m, c);
}

// ── 말하기 ─────────────────────────────────────────────────
// ── 마지막 관문: 소리·화면 글에 기록 id가 안 남게 (11/2 S6 리허설: 먼저 꺼낸 말에 "[n6]에서 …"가 그대로 소리로) ──
// 맥락에 있는 실제 id(결정 n12·자료 사실)와 id 꼴([n6]·(f3)·#52·UUID)을 뺀다. 뒤에 조사가 붙어 있으면("[n6]에서") 빼면 말이 깨지니
// 결정이면 "지난 회의", 자료면 "자료"로 바꾼다. 모델이 어디서 쓰든(대답·먼저 꺼내기·리서치·어긋남) 여기서 다 걸린다.
const ID_SHAPE = String.raw`(?:[nf]\d+|#\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function scrubIds(m: Pick<Meeting, "ctx">, text: string): string {
  if (!text) return text;
  const known = [...m.ctx.nodes.keys(), ...m.ctx.facts.keys()].filter((id) => id.length >= 2).sort((a, b) => b.length - a.length);
  const ID = known.length ? `(?:${known.map(reEsc).join("|")}|${ID_SHAPE})` : ID_SHAPE;
  const word = (id: string) => (m.ctx.facts.has(id) || /^f\d/.test(id) ? "자료" : "지난 회의");
  // 앞 낱말에 바로 붙은 괄호("문서(f3)에는")는 덧붙인 표시라 그냥 빼고, 띄어 쓴 자리에 조사가 이어지면("은 [n6]에서") 말을 바꿔 넣는다
  const group = new RegExp(String.raw`(\s*)[\[(（]\s*(${ID})(?:\s*[,·]\s*${ID})*\s*[\])）](?=([가-힣])?)`, "g");
  let s = text.replace(group, (_all, sp: string, first: string, next: string | undefined, at: number) => (next && (sp || at === 0) ? `${sp}${word(first)}` : ""));
  // 괄호 없이 쓴 실제 id ("n6에서") — 맥락에 있는 것만 (일반 글의 f1 같은 걸 잘못 지우지 않게)
  if (known.length) s = s.replace(new RegExp(String.raw`(^|[^A-Za-z0-9_-])(${known.map(reEsc).join("|")})(?![A-Za-z0-9_-])(?=([가-힣])?)`, "g"), (_all, pre: string, id: string, next?: string) => (next ? `${pre}${word(id)}` : pre));
  return s.replace(/\s{2,}/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
}
function scrubEvent(m: Meeting, ev: OutEvent): OutEvent {
  const f = (x: string) => scrubIds(m, x);
  // 문장 나누기가 먼저라 id를 빼면 "."만 남는 조각이 생긴다 → 앞 문장에 붙인다
  const fs = (xs: string[]) =>
    xs.map(f).reduce<string[]>((out, x) => {
      if (/[가-힣A-Za-z0-9]/.test(x)) out.push(x);
      else if (x && out.length) out[out.length - 1] += x.trim();
      return out;
    }, []);
  switch (ev.type) {
    case "speak":
      return { ...ev, text: f(ev.text), sentences: fs(ev.sentences) };
    case "prepare":
      return { ...ev, sentences: fs(ev.sentences) };
    case "queued":
    case "hand_raise":
      return { ...ev, preview: f(ev.preview) };
    case "private":
      return { ...ev, text: f(ev.text) };
    case "change_card":
      return { ...ev, title: f(ev.title), to: f(ev.to), ...(ev.from ? { from: f(ev.from) } : {}) };
    case "show":
      return ev.canvas.kind === "text" ? { ...ev, canvas: { ...ev.canvas, lines: ev.canvas.lines.map(f) } } : ev;
    default:
      return ev;
  }
}

// 부름·설정 대답은 기다리지 않고 바로 말한다.
// about: 무엇에 대한 대답인지 (부름에 대한 답은 그 질문 발화)
// 대답 글에 섞인 근거 id("(n26)", "#52")는 소리로 읽히면 안 된다 (Haiku 대답 실험에서 나옴)
const SPOKEN_ID = /\s*[(（]\s*(?:[nf]\d+|#\d+|[0-9a-f]{8}-[0-9a-f-]{27,})(?:\s*[,·]\s*(?:[nf]\d+|#\d+|[0-9a-f]{8}-[0-9a-f-]{27,}))*\s*[)）]/g;
export function stripSpokenIds(text: string): string {
  return text.replace(SPOKEN_ID, "");
}

function sayNow(m: Meeting, kind: ActionKind, sentences: string[], evidence: Evidence[], about?: Utt, actionId?: string) {
  if (kind === "answer") sentences = sentences.map(stripSpokenIds).filter(Boolean);
  const last = about ?? m.utts[m.utts.length - 1];
  const c = newCandidate(m, last ?? { id: 0, t0: 0, t1: 0, text: "", receivedAt: Date.now() }, kind, { sentences, evidence, verified: true, ...(actionId ? { actionId } : {}) });
  c.state = "ready";
  c.t.ready = Date.now();
  deliver(m, c, "ready");
}

function deliver(m: Meeting, c: Candidate, via: Timing["via"]) {
  // 말로 짚을 땐 여는 말을 차례로 앞에 붙이고 되묻는 말 하나로 맺는다 — 최대 2문장
  if (c.kind === "conflict") {
    c.sentences = conflictSpeech(m, c.sentences, c.respoken);
    m.conflictsSpoken++;
  }
  const cost = VOICE_COST[c.kind];
  const shadowed = m.shadow.has(c.kind as RoleKind);
  // 스스로 꺼내는 말은 예산의 문장 수까지 (부름 대답·설정 대답은 그대로)
  if (cost !== undefined && m.budget) c.sentences = c.sentences.slice(0, m.budget.maxSentences);
  c.t.delivered = Date.now();
  if (cost !== undefined && !shadowed) {
    m.voiceLedger.push({ at: c.t.delivered, cost, kind: c.kind });
    if (m.budget) emitBudget(m);
  }
  const text = c.sentences.join(" ");
  c.state = "spoken";
  c.t.via = via;
  m.meetyActedAtUtt = latestId(m);
  m.spoken.push({ actionId: c.actionId, text, at: Date.now() });
  // 먼저 꺼낸 제안(suggest)은 쿨다운을 안 건다 — 바로 뒤 어긋남이 손들기로 밀리던 것(P2). 제안끼리는 먼저 꺼내기 간격이 막는다
  if (cost !== undefined && !shadowed && c.kind !== "suggest") {
    c.prevConflictAt = m.lastConflictAt;
    m.lastConflictAt = Date.now();
  }
  if (c.kind === "conflict") for (const x of [...c.nodeIds, ...c.factIds]) m.flagged.add(x);
  // 스스로 꺼내는 말은 "왜" 카드를 먼저 보여 줄 시간(예고)을 준다. 손든 걸 수락했거나 부른 거면 바로
  const leadMs = cost !== undefined && via !== "respond" && !quiet(m) ? TIMING.leadMs[m.intensity === "low" ? "mid" : m.intensity] : undefined;
  // urgent(계약 1302725): 다이얼 5 이상의 확정 어긋남 — 화면이 짧은 틈에 바로 시작하고 "끼어들지 마"보다 먼저 받은 건 안 버린다 (시나리오 A)
  c.urgent = c.kind === "conflict" && m.participation >= URGENT_DIAL;
  voiceOut(m, { type: "speak", actionId: c.actionId, kind: c.kind, text, sentences: c.sentences, evidence: c.evidence, ...(leadMs ? { leadMs } : {}), ...(c.urgent ? { urgent: true as const } : {}) });
}

// "끼어들지 마"가 오면 화면은 아직 소리를 안 낸 지적을 버린다(client.ts) — 단 urgent는 안 버린다(계약 1302725).
// 그래서 urgent 없이(다이얼 5 밑) 방금(15초 안) 보낸 어긋남만 손들기로 다시 남긴다 — urgent까지 다시 들면 카드가 겹친다
const KEEP_AS_HAND_MS = 15_000;
const URGENT_DIAL = 5;
function keepConflictAsHand(m: Meeting) {
  for (const c of m.cands.filter((x) => x.kind === "conflict" && x.state === "spoken" && !x.urgent && x.t.delivered && Date.now() - x.t.delivered < KEEP_AS_HAND_MS && !x.respoken)) {
    const u = m.utts.find((x) => x.id === c.uttId) ?? m.utts[m.utts.length - 1];
    if (!u) continue;
    const h = newCandidate(m, u, "conflict", { sentences: c.sentences.map(stripOpener).filter(Boolean), evidence: c.evidence, nodeIds: c.nodeIds, factIds: c.factIds, verified: true, why: c.why });
    raise(m, h);
  }
}

// 어긋남 지적의 말 꼴 (10/31 S6: 2문장 8.9초~4문장 16초로 들쭉날쭉 → 고정): "여는 말, 언제 무엇으로 정했는지." + 되묻는 한 문장.
// 이번 차례(m.conflictsSpoken)로 여는 말·되묻는 말을 고르니, 미리 굽기(prepare)와 말하기(speak)의 글자가 같다.
// 다시 말하기(respoken)는 남은 문장 그대로(최대 2문장)에 여는 말만 붙인다
function conflictSpeech(m: Meeting, sentences: string[], respoken = false): string[] {
  const lines = sentences.flatMap(splitSentences).map(stripOpener).filter(Boolean);
  if (!lines.length) return [];
  const k = m.conflictsSpoken;
  const body = respoken ? lines.slice(0, 2) : [lines[0], CONFLICT_ASKS[k % CONFLICT_ASKS.length]];
  return [withOpener(OPENERS[k % OPENERS.length], body[0]), ...body.slice(1)];
}

function raise(m: Meeting, c: Candidate) {
  c.state = "raised";
  c.t.delivered = Date.now();
  m.meetyActedAtUtt = latestId(m);
  for (const x of [...c.nodeIds, ...c.factIds]) m.flagged.add(x);
  emit(m, { type: "hand_raise", actionId: c.actionId, kind: c.kind, preview: c.sentences.join(" "), evidence: c.evidence });
}

function cancel(m: Meeting, c: Candidate, reason: "barge_in" | "stale" | "dismissed", note?: string) {
  c.state = "cancelled";
  c.note = note ?? reason;
  emit(m, { type: "cancel", actionId: c.actionId, reason, note: c.note });
}

// 할 말을 만든 뒤 맞장구가 아닌 말이 STALE_AFTER마디 넘게 지나면 주제가 넘어간 것
function expireStale(m: Meeting) {
  for (const c of m.cands) {
    if ((c.state !== "ready" && c.state !== "preparing") || VOICE_COST[c.kind] === undefined) continue;
    if (m.utts.filter((u) => u.id > c.uttId && !isBackchannel(u.text)).length > (c.staleAfter ?? STALE_AFTER)) cancel(m, c, "stale", "주제가 넘어감");
  }
}

// 소리 슬롯은 하나: 준비된 스스로 꺼내는 말 가운데 우선순위가 가장 높은 것, 같으면 먼저 만든 것.
// 다이얼이 높으면(평평) 우선순위 대신 먼저 준비된 것부터
function frontReady(m: Meeting): Candidate | undefined {
  const ready = m.cands.filter((c) => c.state === "ready" && VOICE_COST[c.kind] !== undefined);
  if (m.profile.flatPriority) return ready.sort((a, b) => (a.t.ready ?? 0) - (b.t.ready ?? 0))[0];
  return ready.sort((a, b) => PRIORITY[b.kind as RoleKind] - PRIORITY[a.kind as RoleKind])[0];
}

// 이 역할을 지금 어느 채널로 내나 (다이얼 + 역할 덮어쓰기)
function chan(m: Meeting, kind: ActionKind): Channel {
  const c = channelOf(m.profile, m.roles, kind);
  return m.solo && !m.quietAsked && c === "hand" ? "voice" : c; // 1:1엔 손들 화면을 볼 다른 사람이 없다 — 소리로 (끼어들지 말라고 했으면 그대로)
}
// 강도 하(손만 듦) — 1:1에선 다이얼이 낮아도 소리로 말한다
function quiet(m: Meeting): boolean {
  return m.intensity === "low" && (!m.solo || m.quietAsked);
}

// 1:1 판단: 참석자가 한 명. 참석자 목록이 없을 때만 받아쓰기 화자로 — 모든 말에 이름이 붙었고 한 사람뿐인 채로 SOLO_MIN_UTTS마디
// (참석자가 여럿이면 화자로 1:1이라 하지 않는다: 회의 첫머리엔 한 사람만 말하기 쉽고, 등록 안 한 사람 말엔 이름이 없다)
const SOLO_MIN_UTTS = 3;
function updateSolo(m: Meeting, u: Utt) {
  if (m.mode === "presentation") return void (m.solo = false); // 발표는 청중에게 하는 말
  if (m.participants.length === 1) return void (m.solo = true);
  if (m.participants.length > 1) return void (m.solo = false);
  if (u.speaker) m.speakersSeen.add(u.speaker);
  m.solo = m.speakersSeen.size === 1 && m.utts.length >= SOLO_MIN_UTTS && m.utts.every((x) => x.speaker);
}

function filler(m: Meeting, u: Utt, text: string) {
  if (Date.now() - m.lastFillerAt < TIMING.fillerAgainMs) return;
  m.lastFillerAt = Date.now();
  m.fillerUtt = u.id;
  sayNow(m, "ack", [text], [], u);
}

function fastCall(m: Meeting, u: Utt) {
  if (isBareCall(u.text)) {
    m.awaitCall = u.id + 1;
    return filler(m, u, FILLER.what);
  }
  if (!canThink(m)) return sayNow(m, "answer", [NO_ANSWER_TEXT], [], u); // 쉬는 중이어도 부른 사람이 기다리지 않게
  // 받침말은 대답이 없는 첫 부름에만 — 이미 대답을 만들고 있으면 그 대답을 끊지 않게 안 한다
  if (!m.answering) {
    // 0.3초가 지나도 대답 글이 안 오기 시작했을 때만 — 첫 토큰이 왔으면 첫 문장이 곧 나와서, 받침말은 바로 뒤 대답과 겹쳐 들린다
    setTimeout(() => {
      if (m.ended || m.lastAnsweredUtt >= u.id || m.streamingFor >= u.id) return;
      // 기록을 찾아야 하는 물음이면 "기록 좀 볼게요."(찾는 중임을 말함), 아니면 1:1은 "음…" 같은 생각 소리, 여럿이면 받침말
      if (isRecordQuestion(u.text)) filler(m, u, FILLER.lookup);
      else if (isWebAsk(u.text)) filler(m, u, FILLER.web);
      else if (!(m.solo && backchannel(m, "think", u.id))) filler(m, u, FILLER.wait);
    }, TIMING.fillerMs);
  }
  queueAnswer(m, { u, mode: "call", question: u.text });
}
const NO_ANSWER_TEXT = "지금은 대답을 못 만들었어요. 잠시 뒤에 다시 물어봐 주세요.";

// ── 능동형 미티: 상태 메모 · 먼저 꺼내기 · 여는 말 · 뒤에서 찾기 · 맞장구 (10/31 기헌 결정) ──
// 역할 7개는 말 신호에 반응만 한다. 여기는 조용할 때·주제가 바뀔 때·몇 마디마다 미티가 스스로 "지금 꺼낼 게 있나"를 본다.
// 다이얼이 빈도·과감함을 정한다: 0~2 안 함, 3~4 드물게(카드로), 5~7 가끔(소리), 8~10 적극(소리, 아이디어도).
// 먼저 꺼내기를 볼 때: 진짜 말 every마디마다(다음 긴 침묵에), 주제가 바뀌면, quietMs 조용하면 — 다이얼이 정한다
interface Pace {
  quietMs: number;
  every: number;
  voice: boolean;
}
function pace(m: Meeting): Pace | null {
  const g = dialGate(m);
  if (!g || m.participation <= 2) return null; // 0~2는 안 함, 발표도 안 함(dialGate)
  const p = m.participation;
  return { quietMs: g.quietMs, every: p <= 4 ? 12 : p <= 7 ? 8 : 5, voice: g.voice };
}
const realCount = (m: Meeting) => m.utts.filter((x) => !x.echo && !isBackchannel(x.text)).length;

function stateBlock(m: Meeting): string[] {
  return m.stateText ? [`## 미티 메모 (지금 회의 상태 — 몇 마디마다 갱신)\n${m.stateText}`] : [];
}

// 해야 할 일 재료: 기록의 열린 할 일(담당·기한), 날짜가 적힌 자료 사실(마감·제출)
function todoMaterial(m: Meeting): string {
  const acts = [...m.ctx.nodes.values()].filter((n) => n.type === "action" && n.status !== "done" && n.status !== "rejected").slice(0, 8);
  const dated = [...m.ctx.facts.values()].filter((f) => /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\/\d{1,2}|마감|제출|기한/.test(f.text)).slice(0, 8);
  return [
    ...acts.map((n) => `- ${n.id}: 할 일 ${n.title}${n.owner ? ` (담당 ${n.owner})` : " (담당 없음)"}${n.due ? ` 기한 ${n.due}` : ""}`),
    ...dated.map((f) => `- ${f.id}: 자료 ${f.text.slice(0, 80)}`),
  ].join("\n") || "(없음)";
}

async function updateState(m: Meeting, why: string): Promise<void> {
  if (m.stateBusy || m.ended || !canThink(m)) return;
  m.stateBusy = true;
  const at = realCount(m);
  try {
    const recent = m.utts.filter((x) => !x.echo).slice(-12).map(uttLine).join("\n") || "(아직 아무도 말 안 함)";
    const agenda = m.agenda.map((a) => `- ${a.title}${a.expected.length ? ` (기대: ${a.expected.join(", ")})` : ""}`).join("\n") || "(없음)";
    const r = await ask(m, "summarize", {
      system: [STATE_SYSTEM, m.ctx.text],
      user: `## 이전 메모\n${m.stateText || "(없음)"}\n\n## 오늘 안건\n${agenda}\n\n## 오늘 합의 카드\n${m.cards.map((c) => `- ${c.title}`).join("\n") || "(없음)"}\n\n## 해야 할 일 재료\n${todoMaterial(m)}\n\n## 최근 발화 (${why})\n${recent}`,
      schema: StateOut,
      maxTokens: 1000,
    }, true);
    record(m, r.stat);
    const prevTopic = m.state?.topic ?? "";
    m.state = r.out;
    m.stateAtReal = at;
    m.stateText = [
      `주제: ${r.out.topic || "-"}`,
      `정한 것: ${r.out.decided.join(" / ") || "-"}`,
      `빈 것: ${r.out.open.join(" / ") || "-"}`,
      `할 일: ${r.out.todos.map((t) => `${t.text}${t.ids.length ? ` [${t.ids.join(",")}]` : ""}`).join(" / ") || "-"}`,
    ].join("\n");
    // 주제 경계: 다음 긴 침묵에 먼저 꺼내기를 본다
    if (prevTopic && r.out.topic && overlap(prevTopic, r.out.topic) < 0.3 && m.utts.length) m.planDue = "주제가 바뀜";
  } finally {
    m.stateBusy = false;
  }
}

// 같은 논쟁 되풀이: 두 사람이 번갈아 네 마디, 우기는 말("…다니까요")이 둘 넘거나 같은 사람 말끼리 겹침 — 침묵을 기다리지 않고 바로 먼저 꺼내기를 본다
// (11/2 S6 상황 3: 사람이 1.5초만 기다리면 긴 침묵이 없어 "두 안을 근거로 정리"를 못 함)
export const DEBATE_TRIGGER = "같은 논쟁이 되풀이됨 — 판정하지 말고 두 안을 기록·자료의 근거(숫자)로 나란히 놓아 보자고 할 때(IDEA)";
const INSIST = /(다|라)니까(요)?|그러니까|아니\s*(그게|요|라)|그래도/;
export const DEBATE = { againMs: 180_000 };
function debateLoop(m: Meeting): boolean {
  const r = m.utts.filter((x) => !x.echo && !isBackchannel(x.text)).slice(-4);
  if (r.length < 4) return false;
  const sp = r.map((x) => x.speaker ?? "?");
  if (new Set(sp).size !== 2 || sp[0] !== sp[2] || sp[1] !== sp[3]) return false;
  const insist = r.filter((x) => INSIST.test(x.text)).length;
  const same = Math.max(...[[0, 2], [1, 3]].flatMap(([a, b]) => [overlap(r[a].text, r[b].text), overlap(r[b].text, r[a].text)]));
  return insist >= 2 || same >= 0.2;
}

// 발화마다: 메모 갱신 차례면 갱신, 몇 마디 지났으면 다음 긴 침묵에 먼저 꺼내기를 본다
function agentTick(m: Meeting) {
  if (!TIMING.agent) return;
  if (pace(m) && Date.now() - m.debateAt > DEBATE.againMs && debateLoop(m)) {
    m.debateAt = Date.now();
    void track(m, plan(m, DEBATE_TRIGGER, latestId(m))).catch((e) => fail(m, "plan", e));
  }
  const n = realCount(m);
  if (n - m.stateAtReal >= TIMING.stateEvery) void track(m, updateState(m, `${n}마디째`)).catch((e) => fail(m, "plan", e));
  const pc = pace(m);
  if (pc && n - m.planAtReal >= pc.every && !m.planDue) m.planDue = `${pc.every}마디 지남`;
}

// 긴 침묵(1.5초): 볼 까닭(주제 바뀜·몇 마디)이 있으면 바로, 없으면 다이얼만큼 더 조용할 때 본다
function agentGap(m: Meeting, afterId: number, ms: number) {
  if (!TIMING.agent || m.ended) return;
  const pc = pace(m);
  if (!pc || ms < 1500 || afterId !== latestId(m)) return;
  if (m.planDue) {
    const why = m.planDue;
    m.planDue = "";
    return void track(m, plan(m, why, afterId)).catch((e) => fail(m, "plan", e));
  }
  setTimeout(() => {
    if (m.ended || latestId(m) !== afterId) return;
    void track(m, plan(m, `${Math.round(pc.quietMs / 1000)}초 조용함`, afterId)).catch((e) => fail(m, "plan", e));
  }, Math.max(0, pc.quietMs - 1500));
}

// 미티가 지금 말하거나 말하려는 게 있으면 먼저 꺼내지 않는다
function meetyBusy(m: Meeting): boolean {
  return m.answering || m.answerQ.length > 0 || m.cands.some((c) => c.state === "preparing" || c.state === "ready" || c.state === "delivering");
}

// ── 먼저 꺼내기: 정해진 때 Sonnet이 고른다 + 속생각 저장소 (docs/research/refs-2026-10-31/04-proactive-agents.md) ──
// 1차(PLAN_SYSTEM 한 번에 고르기)가 RF 71분에서 쓸 만한 말 10개를 냈고, 속생각(Haiku 8기준 점수)은 점수가 3.85~3.90에 몰려
// 거르지 못해 0개·비용 두 배였다 → 고르기는 Sonnet이 정해진 때에, 말 안 한 생각은 저장해 두고 다음에 다시 고를 수 있게.
// 다이얼 d 문(코드): 쿨다운 90 − 6d초(긴급은 무시), 최근 5분 미티 말 비중 < 0.03 + 0.012d(1:1은 0.5), 말할 틈(긴 침묵), 미티가 마지막에 말했으면 사람 말 한 번 듣기.
interface StoredThought {
  kind: string;
  text: string;
  at: number;
  uttId: number;
}
const THOUGHT_TTL_MS = 600_000;
const PLAN_RECENT = 12;
function dialGate(m: Meeting) {
  const d = m.participation;
  if (!TIMING.agent || d <= 0 || m.mode === "presentation") return null;
  return {
    coolMs: (90 - 6 * d) * 1000 * TIMING.paceScale,
    share: m.solo ? 0.5 : 0.03 + 0.012 * d, // 1:1은 대화라 미티 몫이 크다
    quietMs: (8 - 0.4 * d) * 1000 * TIMING.paceScale,
    voice: m.solo || d >= 5,
  };
}
// 최근 5분 말 가운데 미티 몫 (글자 수). 여는 말은 안 셈, 사람 말은 적어도 400자(1분쯤)로 쳐서 회의 첫머리에 흔들리지 않게
const SHARE_MIN_HUMAN = 400;
function meetyShare(m: Meeting): number {
  const since = Date.now() - 300_000;
  const meety = m.spoken.filter((x) => x.at >= since && !m.openingIds.has(x.actionId)).reduce((a, x) => a + x.text.length, 0);
  const human = m.utts.filter((x) => x.receivedAt >= since && !x.echo).reduce((a, x) => a + x.text.length, 0);
  return meety / (meety + Math.max(human, SHARE_MIN_HUMAN));
}
const THINK_KIND: Record<string, ThinkEvent["kind"]> = { IDEA: "idea", GAP: "gap", TODO: "todo", LOOKUP: "research", ASK: "question" };
function keepThought(m: Meeting, kind: string, text: string, uttId: number) {
  if (!text || m.thoughts.some((x) => overlap(x.text, text) >= 0.6) || m.proposed.some((x) => overlap(x.text, text) >= 0.5)) return;
  m.thoughts.push({ kind, text, at: Date.now(), uttId });
  emit(m, { type: "think", kind: THINK_KIND[kind] ?? "idea", text });
}

async function plan(m: Meeting, trigger: string, atId: number, opening = false): Promise<void> {
  const pc = pace(m);
  const log = (tag: string, text: string | null, note?: string) => void m.planLog.push({ uttId: atId, trigger, tag, text, ...(note ? { note } : {}) });
  const g = dialGate(m);
  if (!pc || !g || m.ended || m.planBusy || !canThink(m)) return;
  // 쿨다운 안엔 주제가 바뀔 때만 본다(긴급이면 그때 말함) — 판단을 아껴 비용 목표(능동형 끔 대비 +$0.3/시간)
  const cooling = !opening && Date.now() - m.lastProactiveAt < g.coolMs;
  if (!opening && (meetyBusy(m) || (cooling && trigger !== "주제가 바뀜"))) return;
  if (!opening && m.meetyActedAtUtt >= latestId(m)) return; // 미티가 마지막에 말했으면 사람 말을 한 번은 듣고
  const last = m.utts[m.utts.length - 1];
  if (!opening && last?.turn !== undefined && last.turn < TIMING.turnMin) return; // 말이 덜 끝났을 수 있음
  m.planBusy = true;
  m.planAtReal = realCount(m);
  const startId = latestRealId(m);
  try {
    // 요약 + 최근 12마디만 (굴러가는 층 전체를 넣으면 판단 38번이 $0.36 — 비용 목표 능동형 끔 대비 +$0.3/시간)
    const recentLines = m.utts.filter((x) => x.id <= atId && !x.echo).slice(-PLAN_RECENT).map(uttLine).join("\n");
    const meetySaid = m.spoken.slice(-3).map((x) => `- ${x.text}`).join("\n");
    const roll = { text: `${m.summary ? `## 지금까지 회의 요약\n${m.summary}\n\n` : ""}## 최근 발화\n${recentLines || "(아직 없음)"}${meetySaid ? `\n\n## 미티가 이미 한 말\n${meetySaid}` : ""}` };
    m.thoughts = m.thoughts.filter((x) => Date.now() - x.at < THOUGHT_TTL_MS);
    const done = m.proposed.slice(-8).map((x) => `- ${x.tag}: ${x.text}`).join("\n") || "(없음)";
    const kept = m.thoughts.map((x) => `- ${x.kind}: ${x.text}`).join("\n") || "(없음)";
    const found = m.found.slice(-4).map((x) => `- ${x.query} → ${x.lines.join(" ")}`).join("\n") || "(없음)";
    const r = await ask(m, "speak", {
      system: [PLAN_SYSTEM, m.ctx.text, ...stateBlock(m)],
      user: `${roll.text}\n\n## 미티가 이미 꺼낸 것\n${done}\n\n## 아까 떠올려 둔 생각 (아직 안 말함)\n${kept}\n\n## 아까 찾아본 것\n${found}\n\n## 지금\n참여도 ${m.participation}/10 · ${m.solo ? "1:1 회의(팀원 한 명)" : "여럿이 하는 회의"} · 까닭: ${trigger}${cooling ? " · 미티가 방금 먼저 꺼냈음(급한 것만)" : ""}`,
      maxTokens: 350,
    }, true);
    record(m, r.stat);
    const rows = r.text.split("\n").map((x) => x.trim()).filter(Boolean);
    // 보관: 지금은 안 꺼내지만 나중에 쓸 생각 (화면엔 think로)
    for (const row of rows.filter((x) => /^보관\s*[:：]/.test(x)).slice(0, 2)) {
      const mm = row.replace(/^보관\s*[:：]\s*/, "").match(/^(IDEA|GAP|TODO|ASK|LOOKUP)\s*[:：]\s*(.+)$/);
      if (mm) keepThought(m, mm[1], stripSpokenIds(mm[2].trim()), atId);
    }
    const body = rows.filter((x) => !/^보관\s*[:：]/.test(x));
    const urgent = /!/.test(body[0] ?? "");
    const tag = (body[0] ?? "NONE").replace(/[^A-Z]/g, "");
    const { lines, ids } = parseLines(body.slice(1).join("\n"));
    if (!/^(IDEA|GAP|TODO|ASK|LOOKUP)$/.test(tag) || !lines.length) return log("NONE", null);
    if (cooling && !urgent) return keepThought(m, tag, lines.join(" "), atId), log(tag, lines.join(" "), "쿨다운 — 보관");
    if (!opening && !urgent && meetyShare(m) >= g.share) return keepThought(m, tag, lines.join(" "), atId), log(tag, lines.join(" "), `미티 말 비중 넘음 (${(meetyShare(m) * 100).toFixed(0)}%) — 보관`);
    if (m.ended) return log(tag, lines.join(" "), "회의 끝");
    // 되풀이되는 논쟁은 생각하는 사이 한 마디 더 나와도 그대로 맞는 말이다 — 사람들이 쉬지 않고 맞서니 그 사이를 기다리면 못 한다
    const debate = trigger === DEBATE_TRIGGER;
    if (latestRealId(m) > startId + (debate ? 1 : 0) || (opening && m.firstPartialAt.size > 0)) return log(tag, lines.join(" "), "그 사이 사람이 말함 — 접음");
    if (!opening && meetyBusy(m)) return log(tag, lines.join(" "), "미티가 다른 말 하는 중 — 접음");
    const text = lines.map(stripSpokenIds).join(" ");
    if (m.proposed.some((x) => overlap(x.text, text) >= 0.5 || (ids.length > 0 && x.tag === tag && ids.every((i) => x.ids.includes(i))))) return log(tag, text, "이미 꺼낸 것 — 안 함");
    // 미티가 방금(2분 안) 한 말(어긋남 짚기·대답 포함)과 근거가 겹치거나 말이 많이 겹치면 안 꺼낸다 (A·P: 방금 짚은 어긋남을 되물음)
    const recent = m.cands.filter((c) => c.t.delivered && Date.now() - c.t.delivered < 120_000 && c.state !== "dropped");
    // 근거는 모두 겹칠 때만(새 근거가 없음) — 어긋남이 자료 하나를 짚은 뒤 두 안을 숫자로 나란히 놓는 말은 새 근거가 있다 (11/2 S6 상황 3: 0/3)
    if (recent.some((c) => (ids.length > 0 && ids.every((i) => c.nodeIds.includes(i) || c.factIds.includes(i))) || overlap(c.sentences.join(" "), text) >= 0.35)) return log(tag, text, "방금 한 말과 겹침 — 안 함");
    if (tag === "LOOKUP") {
      log(tag, text, "찾아봄");
      return void (await lookup(m, lines[0], startId, atId));
    }
    log(tag, text, urgent ? "긴급" : undefined);
    m.thoughts = m.thoughts.filter((x) => overlap(x.text, text) < 0.4); // 꺼낸 생각은 저장소에서 뺀다
    sayProactive(m, tag, capSpoken(lines.slice(0, 2).map(stripSpokenIds)), ids, opening);
  } finally {
    m.planBusy = false;
  }
}

const PROACTIVE_WHY: Record<string, string> = {
  IDEA: "아이디어가 하나 떠올라서요",
  GAP: "정하면서 빈 게 있어 보여서요",
  TODO: "해야 할 일이 있어서요",
  ASK: "흐름을 이어 보려고요",
  LOOKUP: "아까 그거 찾아봤어요",
};
function sayProactive(m: Meeting, tag: string, sentences: string[], ids: string[], opening = false) {
  const pc = dialGate(m);
  if (!pc || !sentences.length) return;
  const kind: ActionKind = tag === "LOOKUP" ? "research" : "suggest"; // 먼저 꺼낸 말은 suggest 하나로(찾아본 건 research) — why가 무엇인지 말한다
  const nodeIds = ids.filter((id) => m.ctx.nodes.has(id));
  const factIds = ids.filter((id) => m.ctx.facts.has(id));
  const evidence = evidenceFor(m.ctx, nodeIds, factIds);
  m.proposed.push({ text: sentences.join(" "), ids, tag });
  if (!opening) m.lastProactiveAt = Date.now(); // 여는 말은 간격에 안 셈 — 첫 막힘에 못 거드는 일(AG2)
  const u = m.utts[m.utts.length - 1] ?? { id: 0, t0: 0, t1: 0, text: "", receivedAt: Date.now() };
  // 1:1·여는 말: 기다릴 사람이 없다 — 바로 말한다(대답 줄이 비어 있을 때만 여기 온다)
  if (m.solo || opening) {
    const before = new Set(m.cands.map((c) => c.actionId));
    sayNow(m, kind, sentences.flatMap(splitSentences), evidence, u);
    if (opening) for (const c of m.cands) if (!before.has(c.actionId)) m.openingIds.add(c.actionId);
    return;
  }
  const c = newCandidate(m, u, kind, { sentences: sentences.flatMap(splitSentences), evidence, nodeIds, factIds, verified: true, staleAfter: 1 });
  c.why = PROACTIVE_WHY[tag];
  if (!pc.voice) {
    c.state = "shown";
    c.t.delivered = Date.now();
    emit(m, { type: "show", actionId: c.actionId, canvas: { kind: "text", title: "미티 생각", lines: sentences }, ttlMs: 90_000 });
    return;
  }
  c.queued = true;
  emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: c.why, evidence: c.evidence.slice(0, 1) });
  markReady(m, c);
}

// ── 웹에서 찾기 (11/1 기헌): 기록·자료에 없는 바깥 정보. Claude API 웹 검색 도구(서버 도구)를 붙여 한 번 부른다 ──
// 대답 줄을 막지 않게 늘 뒤에서. 결과는 출처(웹) 카드로, 부른 말이면 한 문장으로 답하고, 리서치·찾아보기는 다이얼이 소리면 한 문장.
// 웹 내용은 기록·결정으로 안 남긴다(m.found에도 안 넣음). 결과 속 지시문은 WEB_SYSTEM이 데이터로만 다룬다.
export const WEB = {
  on: process.env.LIVE_WEB !== "0",
  maxPerMeeting: Number(process.env.LIVE_WEB_MAX) || 10, // 회의당 부르는 횟수 상한 (검색 한 번 $0.01 + 토큰)
  maxUses: 1, // 한 번 부를 때 검색 횟수
  timeoutMs: 20_000,
  choice: { ...ROLE_MODELS.speak, hedgeMs: undefined } as ModelChoice, // 늦어도 한 번 더 보내지 않는다(검색 값이 두 번)
};
export const WEB_ACK = "한번 찾아볼게요.";
const WEB_DOMAIN = /\s*[(（][^()（）]*\b[a-z0-9-]+\.(?:com|net|org|kr|io|ai|co|me|ooo)\b[^()（）]*[)）]/gi;
export type WebVia = "call" | "research" | "lookup";
export interface WebLog {
  uttId: number;
  via: WebVia;
  query: string;
  ms?: number;
  searches: number;
  cost: number;
  sources: { title: string; url: string }[];
  reply: string | null;
  note?: string;
}
export const WEB_WAIT = "지금 찾고 있어요, 금방 알려 드릴게요.";
export const WEB_NUDGE = "그거 지금 찾아보고 있어요.";
interface WebOut {
  say: string[];
  sources: { title: string; url: string }[];
}
// 웹 검색 하나 (TTS 파이프라인처럼 이어지게, 11/2 기헌): 찾는 중에도 들고 있어서 같은 물음이 오면 붙고, 끝나면 붙은 부름에 대답한다
export interface WebJob {
  query: string;
  via: WebVia;
  u: Utt; // 찾기를 시작한 말
  done: boolean;
  out: WebOut | null; // 못 찾았거나 실패하면 null
  waiters: Utt[]; // 찾는 사이 같은 걸 물은 부름 — 결과가 나오면 그 대답으로
  nudged: boolean; // "그거 지금 찾아보고 있어요."를 이미 했음 (한 번만)
}
// 같은 걸 찾는(찾은) 검색 — 겹침 기준은 검색어끼리 0.6 (못 찾은 건 다시 찾을 수 있게 뺀다)
// 양쪽으로 본다 — 리서치가 "회의 AI 시장 규모 AI meeting assistant market size"로, 부름이 "회의 AI 시장 규모 2025"로 찾으면 한쪽 비율만으론 0.6이 안 된다 (11/2 S6 상황 5)
export function webJobFor(m: Meeting, query: string): WebJob | undefined {
  return m.webJobs.find((j) => Math.max(overlap(j.query, query), overlap(query, j.query)) >= 0.6 && (!j.done || j.out));
}
const webTitle = (query: string) => `웹에서 찾음 · ${query.length > 30 ? `${query.slice(0, 29)}…` : query}`;
const webEvidence = (out: WebOut): Evidence[] => out.sources.map((s) => ({ label: `웹 · ${s.title}`, loc: s.url }));
function webCard(m: Meeting, job: WebJob, actionId: string) {
  const out = job.out!;
  emit(m, { type: "show", actionId, canvas: { kind: "text", title: webTitle(job.query), lines: [...out.say, ...out.sources.map((s) => `출처(웹): ${s.title} — ${s.url}`)] }, ttlMs: 90_000 });
}
// 부름에 대답: 카드 + 한두 문장 (이미 끝난 결과로도, 찾는 중에 붙은 부름에도)
function webAnswer(m: Meeting, u: Utt, job: WebJob) {
  webCard(m, job, crypto.randomUUID());
  sayNow(m, "answer", job.out!.say.flatMap(splitSentences), webEvidence(job.out!), u);
}

async function webResearch(m: Meeting, u: Utt, query: string, via: WebVia): Promise<void> {
  const log = (e: Partial<WebLog>) => m.webLog.push({ uttId: u.id, via, query, searches: 0, cost: 0, sources: [], reply: null, ...e });
  const tell = (text: string) => {
    if (via === "call" && !m.ended) sayNow(m, "answer", [text], [], u);
  };
  // 같은 걸 찾는 중이거나 찾았으면 다시 안 찾는다. 부름이면: 찾는 중엔 그 검색에 붙고(대답은 결과가 나올 때), 끝났으면 그 결과로 바로
  const same = webJobFor(m, query);
  if (same && via === "call") {
    if (!same.done) {
      same.waiters.push(u);
      return void log({ note: `찾는 중인 검색에 붙음 (${same.via} · "${same.query}")` });
    }
    log({ reply: same.out!.say.join(" "), sources: same.out!.sources, note: `이미 찾은 결과로 (${same.via} · "${same.query}")` });
    return webAnswer(m, u, same);
  }
  if (same) return void log({ note: "같은 걸 이미 찾음" });
  if (!WEB.on || m.webOff) {
    log({ note: m.webOff ? `꺼짐 (${m.webOff})` : "꺼짐 (LIVE_WEB=0)" });
    return tell("지금은 웹 검색이 꺼져 있어요.");
  }
  if (m.webCalls >= WEB.maxPerMeeting) {
    log({ note: `회의당 상한 ${WEB.maxPerMeeting}회` });
    return tell("이번 회의에선 웹 검색을 다 써서 더 못 찾아요.");
  }
  const job: WebJob = { query, via, u, done: false, out: null, waiters: [], nudged: false };
  m.webJobs.push(job);
  m.webCalls++;
  emit(m, { type: "draft", uttId: u.id, kind: "research", state: "thinking", why: `웹에서 찾는 중 · ${query}` }); // 화면 "찾는 중" — 끝나면 dropped
  const t0 = Date.now();
  const recent = m.utts.filter((x) => !x.echo && x.id <= u.id).slice(-4).map(uttLine).join("\n");
  let r: CallResult<unknown> | undefined;
  let failed = "";
  try {
    r = await ask(m, "speak", {
      system: [WEB_SYSTEM],
      user: `## 최근 회의 (무엇을 찾는지 알아듣는 데만 쓴다)\n${recent || "(없음)"}\n\n## 찾을 것\n${query}`,
      maxTokens: 400,
      webSearch: { maxUses: WEB.maxUses },
      choice: WEB.choice,
      timeoutMs: WEB.timeoutMs,
      maxRetries: 0,
    }, true); // 회의 건강 상태엔 안 셈 — 웹이 안 돼도 회의 판단은 그대로
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number }).status;
    if ((status === 400 || status === 403) && /web.?search/i.test(msg)) m.webOff = msg.slice(0, 160); // 계정에서 꺼짐 — 콘솔에서 켜야 한다
    log({ ms: Date.now() - t0, note: `실패: ${msg.slice(0, 160)}` });
    fail(m, "web", e);
    failed = "웹 검색이 지금 안 돼요.";
  }
  let out: WebOut | null = null;
  if (r) {
    record(m, r.stat);
    const web = r.web ?? { searches: 0, sources: [] };
    // 괄호 속 사이트 주소("(money.luvpp.com)")는 소리로 읽히면 안 된다 — 출처는 카드가 보여 준다 (11/2 S6 상황 2)
    const say = capSpoken(parseLines(r.text).lines.map((l) => stripSpokenIds(l).replace(WEB_DOMAIN, "")).filter(Boolean)).slice(0, 2);
    const none = !say.length || /^NONE\b/i.test(say[0]) || !web.sources.length;
    if (!none) out = { say, sources: web.sources };
    log({ ms: Date.now() - t0, searches: web.searches, cost: r.stat.cost, sources: web.sources, reply: none ? null : say.join(" "), ...(web.error ? { note: `검색 도구 오류 ${web.error}` } : {}) });
  }
  job.done = true;
  job.out = out;
  emit(m, { type: "draft", uttId: u.id, kind: "research", state: "dropped", why: out ? "카드로" : "못 찾음" });
  if (m.ended) return;
  const entry = m.webLog[m.webLog.length - 1];
  // 부름(시작한 게 부름이거나 찾는 사이 붙은 부름): 그 부름의 대답으로 — 여럿이 붙었으면 가장 나중 부름에 한 번
  const caller = [...(via === "call" ? [u] : []), ...job.waiters].at(-1);
  if (caller) {
    if (job.waiters.length) entry.note = `${entry.note ? `${entry.note} · ` : ""}붙은 부름 ${job.waiters.length}개에 대답`;
    if (!out) return void sayNow(m, "answer", [failed || "웹에서 마땅한 걸 못 찾았어요."], [], caller);
    return webAnswer(m, caller, job);
  }
  if (!out) return;
  // 리서치: 찾는 사이 팀원이 답했으면 안 낸다 (research와 같은 규칙)
  if (via === "research" && m.utts.some((x) => x.id > u.id && !x.echo && looksLikeAnswer(x.text))) return void (entry.note = "찾는 사이 답이 나옴");
  const ch = chan(m, "research");
  const voice = ch === "voice" && !meetyBusy(m) && latestRealId(m) - u.id <= 2; // 새 후보를 만들기 전에 본다(그 후보도 '준비 중'이라)
  const c = newCandidate(m, u, "research", { sentences: [`찾아봤는데요, ${out.say[0]}`], evidence: webEvidence(out), verified: true, staleAfter: 2 });
  c.why = "웹에서 찾아봤어요";
  webCard(m, job, c.actionId);
  if (voice) {
    entry.note = "카드 + 한 문장";
    c.queued = true;
    emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: c.why, evidence: c.evidence.slice(0, 1) });
    return markReady(m, c);
  }
  c.state = "shown";
  c.t.delivered = Date.now();
  if (ch !== "voice") return void (entry.note = `카드만 (다이얼 ${m.participation})`);
  // 소리 채널인데 지금은 말할 차례가 아님(미티가 말하는 중·대화가 넘어감) → 들고 있다가 다음 긴 침묵에 (webHeldTick)
  entry.note = `카드 + 들고 있음 (${meetyBusy(m) ? "미티가 다른 말 하는 중" : "대화가 넘어감"})`;
  m.webHeld.push({ u, query, line: out.say[0], evidence: webEvidence(out), at: Date.now(), web: true });
}

interface Held {
  u: Utt; // 찾기를 시작한 말
  query: string;
  line: string; // 말할 한 문장 (앞에 "아까 그거 찾아봤는데요, "를 붙인다)
  evidence: Evidence[];
  at: number;
  web: boolean; // 웹 결과(웹 로그에 남김) · 아니면 기록·자료에서 찾은 것
}
// "아 그거요, …"로 시작하는 대답 글을 "아까 그거 찾아봤는데요, " 뒤에 붙일 때 앞머리를 뗀다
const stripOpenerLead = (s: string) => s.replace(/^(아\s*그거요|아\s*그거|음…?|네)\s*[,.]?\s*/, "");
// 긴 침묵마다 (onGap): 들고 있는 웹 결과를 말할 차례면 "아까 그거 찾아봤는데요, …" — 주제가 넘어갔으면 버린다.
// 스스로 찾는 중인데 팀이 같은 물음을 다시 하고 조용하면 한 번만 "그거 지금 찾아보고 있어요."
export const WEB_HOLD = { maxMs: 120_000, maxUtts: 8 };
function webGapTick(m: Meeting, afterId: number, ms: number) {
  if (m.ended || ms < 800 || afterId !== latestId(m) || meetyBusy(m) || chan(m, "research") !== "voice") return;
  const latest = latestRealId(m);
  const last = m.utts.find((x) => x.id === afterId);
  if (ms >= 1500 && last && !last.echo && !hasWakeWord(last.text)) {
    const job = m.webJobs.find((j) => !j.done && j.via !== "call" && !j.nudged && last.id > j.u.id && (overlap(j.u.text, last.text) >= 0.5 || overlap(j.query, last.text) >= 0.5));
    if (job) {
      job.nudged = true;
      m.webLog.push({ uttId: last.id, via: job.via, query: job.query, searches: 0, cost: 0, sources: [], reply: null, note: "같은 물음이 다시 나옴 — 찾는 중이라고 한 번" });
      return sayNow(m, "ack", [WEB_NUDGE], [], last);
    }
  }
  while (m.webHeld.length) {
    const h = m.webHeld.shift()!;
    const since = m.utts.filter((x) => !x.echo && x.id > h.u.id).slice(-3);
    const near = (a: string, b: string) => Math.max(overlap(a, b), overlap(b, a)) >= 0.2; // 짧은 말끼리라 양쪽으로 본다
    const onTopic = latest - h.u.id <= 2 || since.some((x) => near(h.query, x.text) || near(h.u.text, x.text));
    const note = (n: string) => h.web && m.webLog.push({ uttId: afterId, via: "research", query: h.query, searches: 0, cost: 0, sources: [], reply: null, note: n });
    if (Date.now() - h.at > WEB_HOLD.maxMs || latest - h.u.id > WEB_HOLD.maxUtts || !onTopic) {
      note("들고 있던 결과 — 주제가 넘어가서 버림");
      continue;
    }
    note("들고 있던 결과 — 지금 말함");
    const c = newCandidate(m, last ?? h.u, "research", { sentences: [`아까 그거 찾아봤는데요, ${stripOpenerLead(h.line)}`], evidence: h.evidence, verified: true, staleAfter: 1 });
    c.why = "웹에서 찾아봤어요";
    c.queued = true;
    emit(m, { type: "queued", actionId: c.actionId, kind: c.kind, preview: c.sentences[0], why: c.why, evidence: c.evidence.slice(0, 1) });
    return markReady(m, c);
  }
}

// 뒤에서 찾아보기: 우리 기록·자료에서. 바깥 정보면 "웹: " 줄을 내고 웹에서 (webResearch)
async function lookup(m: Meeting, query: string, startId: number, atId: number): Promise<void> {
  const u: Utt = m.utts.find((x) => x.id === atId) ?? { id: atId, t0: 0, t1: 0, text: query, receivedAt: Date.now() };
  const roll = rolling(m, atId);
  const r = await ask(m, "speak", {
    system: [ANSWER_SYSTEM, m.ctx.text, ...stateBlock(m)],
    user: `${roll.text}\n\n## 질문 (미티가 스스로 찾아보는 것 — 기록·자료에 없으면 NONE 한 줄, 바깥 정보면 "웹: " 줄)\n${query}`,
    maxTokens: 300,
  }, true);
  record(m, r.stat);
  const { lines: all, ids } = parseLines(r.text);
  const web = splitWebQuery(all);
  if (web.query) return webResearch(m, u, web.query, "lookup");
  const lines = web.lines;
  if (!lines.length || /^NONE\b/i.test(lines[0]) || !ids.length || m.ended) return;
  // 리서치가 2분 안에 같은 걸 찾아 말했으면(카드·소리) 또 꺼내지 않는다 (11/2 리허설 상황 2: 2.3%를 두 번)
  const said = m.cands.filter((c) => c.kind === "research" && c.state !== "dropped" && Date.now() - c.t.final < 120_000);
  if (said.some((c) => overlap(lines[0], c.sentences.join(" ")) >= 0.35 || ids.some((i) => c.nodeIds.includes(i) || c.factIds.includes(i) || c.evidence.some((e) => e.nodeId === i)))) return void m.planLog.push({ uttId: atId, trigger: "찾아보기", tag: "LOOKUP", text: lines[0], note: "리서치가 방금 같은 걸 냄 — 안 함" });
  m.found.push({ query, lines });
  // 대화가 그사이 크게 안 넘어갔으면 바로 꺼낸다. 넘어갔으면 생각으로 보관 — 다음 먼저 꺼내기가 고를 수 있게
  if (latestRealId(m) - startId > 1 || meetyBusy(m)) return keepThought(m, "LOOKUP", `아까 그거 찾아봤는데요, ${lines[0]}`, atId);
  sayProactive(m, "LOOKUP", [`아까 그거 찾아봤는데요, ${lines[0]}`, ...lines.slice(1, 2)], ids);
  void u;
}

// 회의 열기: 화면이 붙으면 상태 메모를 만들고 첫 말 — 안건이 있으면 안건으로, 없으면 열린 할 일·다가오는 마감으로
async function openMeeting(m: Meeting): Promise<void> {
  // 누가 말을 시작했으면(partial이 왔으면) 열지 않는다 — final은 말 끝에야 와서 그 전엔 모른다 (S6: 여는 말이 사람 말에 4초 만에 끊김)
  const talking = () => m.utts.length > 0 || m.firstPartialAt.size > 0;
  if (!pace(m) || m.mode === "presentation" || talking() || m.ended) return;
  await updateState(m, "회의 시작 전");
  if (talking()) return;
  await plan(m, "회의 시작 — 오늘 할 것을 짚으며 연다(안건이 있으면 안건으로, 없으면 열린 할 일·다가오는 마감으로). \"오늘 X랑 Y 정해야 할 것 같은데, 어디부터 할까요?\"처럼 ASK나 TODO로", 0, true);
}

// 맞장구·생각 소리: 사람이 말하는 도중엔 안 낸다(S2 71분 재 보니 쉼 중앙 0.69초, 쉰 뒤 0.8초 안에 다시 말하는 게 63~91% —
// 쉼마다 치면 말을 끊는다). 말이 끝난 뒤 대답 앞의 여는 소리로만: 1:1 부름 대답이 0.3초 안에 안 나오면 받침말 대신 "음…".
function backchannel(m: Meeting, kind: BackchannelKind, uttId: number) {
  if (Date.now() - m.lastBackchannelAt < TIMING.backchannelAgainMs) return false;
  const ts = BACKCHANNEL_KINDS[kind];
  m.lastBackchannelAt = Date.now();
  voiceOut(m, { type: "backchannel", kind, text: ts[Math.floor(Math.random() * ts.length)], uttId });
  return true;
}

// ── 대답 줄 ────────────────────────────────────────────────
// 부름·1:1·2인칭 대답은 한 줄로 세워 하나씩 만든다 → speak가 말한 순서대로 나간다(화면은 speak를 받은 차례로 튼다, S6 d14c949).
// 대답을 만드는 동안 들어온 재촉("대답해야지"·"어떻게 생각해?")은 그 대답에 합친다. 줄에 쌓인 건 한 번에:
// 부름이 있으면 내용 있는 부름들을 한 질문으로, 1:1 말만 있으면 마지막 말에만(앞 말은 이미 지나감).
type AnswerMode = "call" | "solo" | "group";
interface AnswerJob {
  u: Utt;
  mode: AnswerMode;
  question: string;
  waited?: boolean; // 말 끝이 애매해서 한 번 기다렸음
}
interface PreAnswer {
  text: string; // 미리 본 안정 글자
  mode: AnswerMode;
  n: number;
  gen?: Promise<Generated>;
}
interface Generated {
  text: string;
  actionId: string;
  firstSpoken: boolean; // splitSpeak: 첫 문장은 이미 말함
}

function queueAnswer(m: Meeting, job: AnswerJob) {
  // 1:1에서 말 끝 확률(turn)이 애매하면 바로 대답하지 않고 조금 더 기다린다 — 그 사이 이어 말하면 이 말엔 대답 안 함 (글 3: "다 말한 거야?")
  if (job.mode === "solo" && job.u.turn !== undefined && job.u.turn < TIMING.turnMin && !job.waited) {
    setTimeout(() => {
      if (m.ended || latestRealId(m) > job.u.id) return void m.soloLog.push({ uttId: job.u.id, reply: "(말이 이어짐 — 안 대답)" });
      queueAnswer(m, { ...job, waited: true });
    }, TIMING.turnWaitMs);
    return;
  }
  // 대답을 만드는 중이거나 방금(3초 안) 대답했으면 재촉은 그 대답이 받는다 (대답을 다 듣기 전에 또 부르는 일이 잦다)
  const recent = Date.now() - m.lastAnswerAt < TIMING.nudgeMergeMs;
  if (job.mode === "call" && isNudge(job.u.text) && (m.answering || recent || m.answerQ.some((j) => j.mode === "call"))) {
    m.soloLog.push({ uttId: job.u.id, reply: "(재촉 — 만드는 대답에 합침)" });
    return;
  }
  m.answerQ.push(job);
  if (!m.answering) void track(m, answerWorker(m)).catch((e) => fail(m, "answer", e));
}

async function answerWorker(m: Meeting) {
  m.answering = true;
  try {
    while (m.answerQ.length && !m.ended) {
      const jobs = m.answerQ.splice(0);
      const calls = jobs.filter((j) => j.mode === "call");
      let job: AnswerJob;
      if (calls.length) {
        const asked = calls.filter((j) => !isNudge(j.u.text)).map((j) => j.question);
        job = { u: calls[calls.length - 1].u, mode: "call", question: asked.length ? asked.join(" / 그리고 ") : calls[calls.length - 1].question };
      } else job = jobs[jobs.length - 1];
      try {
        await runAnswer(m, job, calls.length === 1 && jobs.length === 1);
      } catch (e) {
        fail(m, "answer", e);
        if (job.mode === "call" && !m.ended) {
          m.lastAnsweredUtt = Math.max(m.lastAnsweredUtt, job.u.id); // 사과도 대답 — 받침말이 그 뒤에 나오지 않게
          sayNow(m, "answer", [NO_ANSWER_TEXT], [], job.u);
        }
      }
    }
  } finally {
    m.answering = false;
  }
}

// partial 안정 글자로 대답 미리 만들기 (기헌 하이브리드 아이디어): 부르는 꼴이거나 1:1이면, 말이 끝나기 전에 시작해 둔다.
// final이 오면 앞부분이 같고 final의 거의 전부(85%)를 덮을 때만 그 대답을 쓴다 — 아니면 버리고 final로 다시.
const PRE_MIN = 6;
const PRE_COVER = 0.85;
const PRE_CAUGHT_UP = 4; // 말한 글자 − 안정 글자
export function onPreAnswer(m: Meeting, id: number, text: string, stable = 0) {
  if (!m.firstPartialAt.has(id)) m.firstPartialAt.set(id, Date.now());
  const long = TIMING.preAnswerLong && m.solo && Date.now() - m.firstPartialAt.get(id)! >= TIMING.preAnswerLongMs;
  if (!(TIMING.preAnswer || long) || m.ended || id <= latestId(m) || !canThink(m)) return;
  const t = cleanText(text.slice(0, stable));
  if (t.length < PRE_MIN) return;
  // 안정 글자가 말한 데까지 거의 따라왔을 때만(쉼 = 말이 끝났을 수 있는 때) — 말하는 도중에 시작하면 물음이 뒤에 와서 버리게 된다(WV 13번 시작 3번 버림)
  if (cleanText(text).length - t.length > PRE_CAUGHT_UP) return;
  const call = hasWakeWord(t) && (isVocative(t) || isLeadingCall(t));
  const mode: AnswerMode | null = call ? "call" : m.solo && !hasWakeWord(t) ? "solo" : null;
  if (!mode || isBareCall(t) || parseSettingsCommand(t, "high") || parseSettingsCommand(t, "low") || isBackchannel(t)) return;
  const prev = m.preAnswers.get(id);
  if (prev && (prev.n >= 3 || t.length < prev.text.length * 1.2)) return; // 한 마디에 세 번까지, 늘었을 때만 다시
  const u: Utt = { id, t0: 0, t1: 0, text: t, receivedAt: Date.now() };
  const pre: PreAnswer = { text: t, mode, n: (prev?.n ?? 0) + 1 };
  pre.gen = generate(m, { u, mode, question: t }, false);
  pre.gen.catch(() => {});
  m.preAnswers.set(id, pre);
  m.partialLog.push({ uttId: id, stable, reason: `대답 미리 시작(${mode})` });
}

function covers(seen: string, final: string): boolean {
  const norm = (x: string) => [...x.replace(/[\s\p{P}]/gu, "")];
  const a = norm(seen);
  const b = norm(final);
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k >= a.length * PREFIX_SAME && a.length >= b.length * PRE_COVER;
}

// 대답 글 만들기. live면 첫 줄이 끝나는 대로 prepare(또는 splitSpeak면 첫 문장 speak)를 보낸다
// 첫 구: 쉼표·물음표 뒤, 또는 10자 넘은 뒤 어절 경계까지 (첫 토큰 뒤 바로 TTS로 — 글 1 "TTFT가 지연의 절반 이상")
const PHRASE_MIN = 10;
export function firstPhrase(text: string): string | null {
  const t = text.trimStart();
  const punct = t.slice(3).search(/[,，?!.]\s/);
  if (punct >= 0) return t.slice(0, 3 + punct + 1).trim();
  if (t.length < PHRASE_MIN + 4) return null;
  const sp = t.indexOf(" ", PHRASE_MIN);
  return sp > 0 && sp < t.length - 1 ? t.slice(0, sp).trim() : null;
}

async function generate(m: Meeting, job: AnswerJob, live: boolean): Promise<Generated> {
  const { u, mode, question } = job;
  const roll = rolling(m, u.id);
  const g: Generated = { text: "", actionId: crypto.randomUUID(), firstSpoken: false };
  const cards = `## 오늘 회의에서 합의한 것\n${m.cards.map((c) => `- ${c.title}${c.from ? ` (전엔 ${c.from})` : ""}`).join("\n") || "(아직 없음)"}`;
  const note = mode === "group" ? "\n\n(지금은 여럿이 하는 회의다. 미티가 방금 말한 뒤에 나온 말이라 미티에게 묻는 말일 수 있다. 다른 팀원에게 한 말이면 NONE.)" : "";
  // 팀 바깥 사실을 묻는 말이면(업계 평균·다른 AI 서비스 …) 짐작하지 말고 웹 줄로 가라고 한 번 더 — 11/2 리허설 2/3이 출처 없이 짐작으로 답함
  const outside = isWebAsk(u.text) && !isRecordQuestion(u.text);
  const hint = outside ? `\n\n(팀 바깥 사실을 묻는 말로 보인다 — 기록·자료에 답이 없으면 짐작하지 말고 "한번 찾아볼게요." + "웹: " 줄로)` : "";
  const user = mode === "call" ? `${roll.text}\n\n${cards}\n\n## 질문\n${u.speaker ?? "팀원"}: ${question}${hint}` : `${roll.text}\n\n${cards}\n\n## 방금 한 말\n${u.speaker ?? "팀원"}: ${u.text}${note}${hint}`;
  let firstDone = false;
  let phraseLen = 0; // phraseSpeak: 첫 줄에서 이미 말한 앞부분 길이
  const onText = (soFar: string) => {
    if (!live) return;
    if (soFar) m.streamingFor = Math.max(m.streamingFor, u.id);
    if (firstDone) return;
    const nl = soFar.indexOf("\n");
    // 첫 구 흘리기(LIVE_PHRASE_SPEAK=1, 부름만): 첫 줄이 다 오기 전에 쉼표·어절 경계(10자 넘게)에서 그 앞부분을 먼저 speak
    if (nl < 0) {
      if (TIMING.phraseSpeak && TIMING.splitSpeak && mode === "call" && !phraseLen && !m.ended) {
        const head = firstPhrase(soFar);
        if (head && !/^(NONE|근거|웹\s*[:：])/.test(head) && !isWebFiller(head)) {
          phraseLen = head.length;
          g.firstSpoken = true;
          sayNow(m, "answer", [stripSpokenIds(head)], [], u, g.actionId);
          m.lastAnsweredUtt = Math.max(m.lastAnsweredUtt, u.id);
        }
      }
      return;
    }
    firstDone = true;
    const first = stripSpokenIds(soFar.slice(phraseLen, nl).trim());
    if (phraseLen) {
      if (first) sayNow(m, "answer", [first], [], u); // 첫 줄 나머지
      return;
    }
    // "한번 찾아볼게요."는 흘려 말하지 않는다 — 다음 줄(웹: 검색어)을 봐야 받침말·찾는 중인 검색과 겹치는지 안다 (runAnswer가 고른다)
    if (!first || /^(NONE|근거|웹\s*[:：])/.test(first) || isWebFiller(first) || m.ended) return;
    if (TIMING.splitSpeak && mode === "call") {
      g.firstSpoken = true;
      sayNow(m, "answer", splitSentences(first), [], u, g.actionId);
      m.lastAnsweredUtt = Math.max(m.lastAnsweredUtt, u.id);
    } else voiceOut(m, { type: "prepare", actionId: g.actionId, kind: "answer", sentences: splitSentences(first) });
  };
  // 빠른 첫 문장(LIVE_FAST_FIRST=1, 부름만): 첫 문장은 Haiku가 같은 대답 프롬프트로(문장이 끝나는 게 Sonnet보다 약 0.5초 빠름 —
  // scripts/live-latency.ts), 나머지는 Sonnet이 그 첫 문장을 받아 이어서. 짧게 줄인 프롬프트는 사실이 틀려서 안 쓴다
  // 바깥 사실 물음은 빠른 첫 문장(Haiku)을 안 쓴다 — Haiku가 첫 줄을 짐작으로 말해 버린다("대부분은 부를 때만 답하는 편이에요")
  if (TIMING.fastFirst && live && mode === "call" && TIMING.splitSpeak && !ANSWER_MODEL && !outside) {
    // 첫 문장만 쓰면 되니 잘려도 받는다 (안 그러면 max_tokens에 잘린 대답이 오류로 "대답을 못 만들었어요"가 됨)
    const h = await ask(m, "speak", { system: [ANSWER_SYSTEM, m.ctx.text, ...stateBlock(m)], user, maxTokens: 200, onText, choice: ROLE_MODELS.watch, allowTruncated: true }); // 120은 자기소개 한 줄(100자 안쪽)이 잘렸다
    record(m, h.stat);
    const first = parseLines(h.text);
    if (!g.firstSpoken || !first.lines.length) {
      // 줄바꿈이 안 왔으면 max_tokens에 잘린 것 — 마지막 문장 끝까지만 (11/1 자기소개: "목소리 지문은 이 컴"에서 끊긴 채 읽힘). 한 문장도 못 끝냈으면 아래 보통 대답으로
      g.text = h.text.includes("\n") ? h.text : h.text.replace(/[^.?!]*$/, "");
      if (g.text.trim() || g.firstSpoken) return g;
    } else if (splitWebQuery(first.lines).query) {
      g.text = h.text; // "한번 찾아볼게요." + 웹 줄 — 나머지는 웹에서 찾아 말한다
      return g;
    } else {
      const rest = await ask(m, "speak", {
        system: [ANSWER_SYSTEM, m.ctx.text, ...stateBlock(m)],
        user: `${user}\n\n## 미티가 방금 한 첫 문장\n${first.lines[0]}\n(이어서 할 말이 있으면 한 문장만 — 같은 말 되풀이 금지. 없으면 NONE 한 줄. 마지막 줄 "근거: ")`,
        maxTokens: 200,
      });
      record(m, rest.stat);
      const more = parseLines(rest.text);
      const tail = more.lines.length && !/^NONE\b/i.test(more.lines[0]) ? more.lines : [];
      g.text = [first.lines[0], ...tail, `근거: ${[...new Set([...first.ids, ...more.ids])].join(", ")}`].join("\n");
      return g;
    }
  }
  const { text, stat } = await ask(m, "speak", {
    system: [mode === "call" ? ANSWER_SYSTEM : SOLO_SYSTEM, m.ctx.text, ...stateBlock(m)],
    user,
    maxTokens: 400,
    onText,
    ...(ANSWER_MODEL ? { choice: ANSWER_MODEL } : {}),
  });
  record(m, stat);
  g.text = text;
  return g;
}

async function runAnswer(m: Meeting, job: AnswerJob, single: boolean) {
  const { u, mode } = job;
  const pre = m.preAnswers.get(u.id);
  m.preAnswers.delete(u.id);
  let g: Generated | undefined;
  if (pre?.gen && single && pre.mode === mode && covers(pre.text, u.text)) {
    g = await pre.gen.catch(() => undefined);
    m.partialLog.push({ uttId: u.id, stable: pre.text.length, reason: g ? "대답 미리 씀" : "대답 미리 실패 — 다시" });
  } else if (pre) m.partialLog.push({ uttId: u.id, stable: pre.text.length, reason: "대답 미리 버림(final이 다름)" });
  g ??= await generate(m, job, true);
  if (m.ended) return;
  const { lines: all, ids } = parseLines(g.text);
  const web = splitWebQuery(all);
  // 웹에서 찾을 거면 먼저 "한번 찾아볼게요."만 말하고(대답 줄을 막지 않게) 찾는 건 뒤에서 — 결과는 카드와 한 문장으로
  // 받침말이 이미 나갔으면 "한번 찾아볼게요."는 빼고(두 번 들림), 안 나갔으면 그게 첫 말.
  // 같은 걸 찾는 중이면 "지금 찾고 있어요, 금방 알려 드릴게요."(받침말이 나갔으면 생략), 이미 찾았으면 받침 없이 바로 그 결과 (webResearch가 말함)
  const wj = web.query ? webJobFor(m, web.query) : undefined; // webResearch가 새 검색을 만들기 전에 본다
  const noAck = web.lines.filter((l) => !(web.query ? isWebFiller(l) : isWebAck(l)));
  const canSearch = WEB.on && !m.webOff && m.webCalls < WEB.maxPerMeeting; // 못 찾을 거면 "한번 찾아볼게요." 없이 안내만
  const lines = g.firstSpoken
    ? web.query && !web.lines.length ? [WEB_ACK] : web.lines
    : wj
      ? wj.done || m.fillerUtt === u.id ? noAck : [WEB_WAIT, ...noAck]
      : m.fillerUtt !== u.id && canSearch ? (web.query ? (noAck.length ? noAck : [WEB_ACK]) : web.lines) : noAck;
  // 웹 검색은 이 대답 줄을 말한 뒤에 시작한다(finally) — 꺼짐·상한 안내나 이미 찾은 결과가 "한번 찾아볼게요."보다 먼저 들리지 않게
  try {
    const none = !lines.length || /^NONE\b/i.test(lines[0]);
    if (mode !== "call") {
      m.soloLog.push({ uttId: u.id, reply: none ? null : lines.join(" ") });
      if (none || latestRealId(m) > u.id) return; // 그 사이 다음 말을 했으면 지난 말엔 대답 안 함
      // 같은 말로 어긋남 후보가 있으면 그게 대답이다(미리 만든 말이라 더 빠름) — 말하거나 버려질 때까지 기다렸다가,
      // 말했으면 접고 버려졌으면 대답한다 (B: 발표 중 어긋남을 대답이 가로챔 / S2: 확인이 어긋남을 버리자 아무 말도 안 함)
      const conf = () => m.cands.filter((c) => c.uttId === u.id && c.kind === "conflict" && c.state !== "dropped");
      for (const t0 = Date.now(); conf().some((c) => c.state === "preparing" || c.state === "ready") && Date.now() - t0 < SOLO_WAIT_MS; ) await sleep(50);
      if (conf().length || m.ended || latestRealId(m) > u.id) return;
    } else if (none) return;
    // 대화는 짧게 — 두 줄까지, 합쳐 SPOKEN_MAX자 안쪽(한 줄에 세 문장을 몰아 쓰는 일이 있다, AG1). splitSpeak로 첫 줄을 이미 말했으면 나머지만
    // 짧은 말엔 한 문장 (글 3 · 기헌: 대답이 길다)
    const maxLines = cleanText(u.text).replace(/(?:미티|미띠|밋티)(?:야|아)?/g, "").trim().length < SHORT_ASK ? 1 : SOLO_MAX_SENTENCES;
    const say = capSpoken(lines.slice(0, maxLines)).slice(g.firstSpoken ? 1 : 0).flatMap(splitSentences);
    m.lastAnsweredUtt = Math.max(m.lastAnsweredUtt, u.id);
    m.lastAnswerAt = Date.now();
    const ev = evidenceFor(m.ctx, ids.filter((id) => m.ctx.nodes.has(id)), ids.filter((id) => m.ctx.facts.has(id)));
    // 흘려 말한 첫 문장은 근거 줄이 오기 전에 나가 근거가 비어 있다 — 다 받은 뒤 채워 둔다 (회의 뒤 한 줄 요약 바로잡기가 본다)
    const first = g.firstSpoken ? m.cands.find((c) => c.actionId === g.actionId) : undefined;
    if (first && !first.evidence.length) first.evidence = ev;
    if (say.length) sayNow(m, "answer", say, ev, u, g.firstSpoken ? undefined : g.actionId);
  } finally {
    if (web.query) void track(m, webResearch(m, u, web.query, "call")).catch((e) => fail(m, "web", e));
  }
}
// 줄(모델이 쓴 단위)을 앞에서부터 SPOKEN_MAX자까지. 첫 줄이 너무 길면 문장 끝(요·다.·?)에서 자른다
const SPOKEN_MAX = 110;
export function capSpoken(lines: string[]): string[] {
  const out: string[] = [];
  let n = 0;
  for (const l of lines) {
    if (n + l.length <= SPOKEN_MAX) {
      out.push(l);
      n += l.length;
      continue;
    }
    if (!out.length) {
      const cut = [...l.slice(0, SPOKEN_MAX).matchAll(/[요다][.!?]|[?!]/g)].pop();
      out.push(cut ? l.slice(0, cut.index! + cut[0].length) : l);
    }
    break;
  }
  return out;
}
const SOLO_MAX_SENTENCES = 2;
const SHORT_ASK = 12; // 호출어 빼고 이보다 짧은 말엔 한 줄만 // 모델이 한 줄에 한 문장씩 쓴다 — 줄로 자른다(splitSentences는 "팀원마다 " 같은 데서도 끊는다)
const SOLO_WAIT_MS = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


export function budgetState(m: Meeting): { used: number; limit: number; windowMin: number } {
  const windowMin = m.budget?.windowMin ?? 10;
  return { used: usedBudget(m.voiceLedger, Date.now(), windowMin), limit: m.budget?.voicePer10Min ?? Infinity, windowMin };
}

function emitBudget(m: Meeting) {
  emit(m, { type: "budget", ...budgetState(m) });
}

// 예산이 남았는지 (그림자 모드 역할은 예산을 안 쓴다)
function canSpend(m: Meeting, c: Candidate): boolean {
  return m.shadow.has(c.kind as RoleKind) || voiceAllowed(c.kind, budgetState(m).used, m.budget);
}

// 말할 만큼 끊겼다고 볼 gap 길이: 강도 기준, 단 마지막 말이 안 끝난 것 같으면 1500
function neededGap(m: Meeting): number {
  if (quiet(m)) return Infinity;
  const last = latestReal(m);
  return last && isUnfinished(last.text) ? 1500 : GAP_MS[m.intensity === "low" ? "mid" : m.intensity];
}

function silentEnough(m: Meeting): boolean {
  if (quiet(m)) return false;
  const g = m.lastGap;
  return !!g && g.afterId >= latestRealId(m) && g.ms >= neededGap(m) && Date.now() - g.at < GAP_FRESH_MS && m.lastSpeechAt < g.at;
}

// 대사가 준비됐거나 확인이 끝났을 때: 강도 하면(확인 뒤) 손들기, 아니면 이미 충분히 조용할 때 바로 말하기
function tryDeliver(m: Meeting) {
  const c = frontReady(m);
  if (!c || (c.hold && !c.verified)) return;
  if (quiet(m) || chan(m, c.kind) === "hand" || c.handOnly) {
    if (c.verified) raise(m, c);
    return;
  }
  if (silentEnough(m)) void speakFront(m, "ready");
}

// 확장: 화면이 음성 서버 speech_start를 넘겨주면, 그 뒤로는 침묵이 끝난 걸로 본다
export function onSpeechStart(m: Meeting) {
  m.lastSpeechAt = Date.now();
}

// gap은 같은 after_id의 final보다 먼저 올 수 있다 → 기억해 두고, final 뒤 대사가 준비되면 tryDeliver가 "이미 조용했다"로 본다
export function onGap(m: Meeting, afterId: number, ms: number) {
  if (m.ended) return;
  m.lastGap = { afterId, ms, at: Date.now() };
  m.lastSpeechAt = 0;
  webGapTick(m, afterId, ms);
  // 제안: 아이디어를 찾는 말 뒤 1.5초 + suggestWaitMs 동안 아무도 말이 없으면 거든다
  const sp = m.suggestPending;
  if (sp && sp.uttId === afterId && ms >= 1500 && afterId === latestId(m)) {
    setTimeout(() => {
      if (m.ended || m.suggestPending !== sp || latestId(m) !== sp.uttId) return;
      m.suggestPending = undefined;
      const u = m.utts.find((x) => x.id === sp.uttId);
      if (u) startSuggest(m, u);
    }, TIMING.suggestWaitMs);
  }
  // 묶음 판단: 긴 침묵이면 모은 걸 본다
  if (ms >= 1500 && m.batch.length && afterId >= m.batch[m.batch.length - 1].id) flushBatch(m);
  // 물음 뒤 1.5초 조용하면, 아는 사람이 답할 틈을 1.5초 더 준 뒤(약 3초) 찾아본다. 그 사이 말이 나오면 checkResearch가 처리
  const rp = m.researchPending;
  if (rp && rp.uttId === afterId && ms >= 1500 && afterId === latestId(m)) {
    setTimeout(() => {
      if (m.ended || m.researchPending !== rp || latestId(m) !== rp.uttId) return;
      m.researchPending = undefined;
      startResearch(m, rp);
    }, TIMING.researchWaitMs);
  }
  agentGap(m, afterId, ms);
  if (afterId < latestRealId(m)) return;
  if (quiet(m)) return;
  if (ms < neededGap(m)) return;
  void speakFront(m, "gap");
}

// 대기열 맨 앞 후보를 말한다. 만든 뒤 대화가 더 있었으면 그 대화로 한 번 더 확인한다.
async function speakFront(m: Meeting, via: "gap" | "ready"): Promise<void> {
  const c = frontReady(m);
  if (!c || (c.hold && !c.verified)) return;
  // 손들기 채널이거나, 방금 짚었거나, 팀이 켠 상한을 다 썼으면 말하지 않고 (확인 뒤) 손만 든다 — 채널 사다리 소리 → 손들기
  if (chan(m, c.kind) === "hand" || c.handOnly || Date.now() - m.lastConflictAt < TIMING.cooldownMs * m.profile.cooldownScale || !canSpend(m, c)) {
    if (c.verified) raise(m, c);
    return;
  }
  const newer = m.utts.filter((u) => u.id > c.uttId && !u.echo && !isBackchannel(u.text));
  // 어긋남이 아닌 역할(담당 묻기·피드백)은 감지기가 이어진 말을 보고 스스로 거둔다 → 다시 확인하지 않는다
  if (!newer.length || c.kind !== "conflict") return deliver(m, c, via);
  c.state = "delivering";
  try {
    const out = await track(m, runVerify(m, c, newer.map(uttLine).join("\n")));
    if (c.state !== "delivering") return;
    if (!out.ok) return cancel(m, c, "stale", `다시 확인에서 버림: ${out.reason}`);
    c.verified = true;
    if (latestRealId(m) !== newer[newer.length - 1].id) {
      c.state = "ready"; // 확인하는 사이 또 누가 말함 → 다음 gap에
      return;
    }
    deliver(m, c, via);
  } catch (e) {
    c.state = "ready";
    fail(m, "verify", e);
  }
}

// 미티가 말하다 끊김 (/barge {id, playedMs}). 누가 끊었는지는 같은 id의 utterance.barge로 나중에 온다 (계약 BargeVerdict — 끊는 0.35초엔 목소리 지문이 없다).
//   member·unsure → 끊김 인정 (못 한 문장은 cancel.rest로 자막 이어쓰기)
//   other, 또는 bargeWaitMs 안에 그 id의 말이 안 옴(기침·잡음·빈 받아쓰기) → 재생 2초 미만이었으면 다음 침묵에 남은 문장을 한 번 더 말한다
export const RESPEAK_UNDER_MS = 2000;
const MS_PER_CHAR = 160; // 미티 말 빠르기 (채점 스크립트와 같은 값)
// 끊긴 말 고르기: 화면이 지금 틀던 actionId를 주면 그것(계약 제안 BargeReq.actionId). 없으면 화면 줄을 흉내 —
// 보낸 차례대로 줄 서서 하나씩 튼다(각 글자 수 × MS_PER_CHAR)고 보고 지금 틀고 있을 말. "가장 최근에 보낸 말"로 고르면
// urgent를 말하던 중 끊겨도 그 뒤에 보낸 ack를 끊은 걸로 쳐서 다시 말하기·playedMs가 엉뚱한 말에 붙었다(S6)
function cutCandidate(m: Meeting, actionId?: string): Candidate | undefined {
  if (actionId) return m.cands.find((c) => c.actionId === actionId && c.state === "spoken");
  const recent = m.cands.filter((c) => c.state === "spoken" && c.t.delivered && Date.now() - c.t.delivered < 30_000).sort((a, b) => a.t.delivered! - b.t.delivered!);
  let end = 0;
  let playing: Candidate | undefined;
  for (const c of recent) {
    const start = Math.max(c.t.delivered!, end);
    end = start + c.sentences.join("").length * MS_PER_CHAR;
    if (start <= Date.now()) playing = c; // 지금보다 먼저 시작했을 말 가운데 가장 나중 것
  }
  return playing;
}

export function onBarge(m: Meeting, playedMs?: number, bargeId?: number, actionId?: string) {
  m.lastSpeechAt = Date.now(); // 사람이 말을 시작했다 → 다음 gap 전엔 조용하지 않다
  const last = cutCandidate(m, actionId);
  if (!last) return;
  // 재생된 만큼의 문장은 뺀다 (재생 시간을 모르면 전부 남은 걸로)
  let chars = (playedMs ?? 0) / MS_PER_CHAR;
  const rest = last.sentences.filter((x) => (chars -= x.length) < 0);
  const canRespeak = playedMs !== undefined && playedMs < RESPEAK_UNDER_MS && VOICE_COST[last.kind] !== undefined && !last.respoken && rest.length > 0;
  last.state = "cancelled";
  last.note = canRespeak ? "끊김 — 누가 끊었는지 보고 다시 말할지 정함" : "barge_in";
  emit(m, { type: "cancel", actionId: last.actionId, reason: "barge_in", note: last.note, ...(rest.length ? { rest } : {}) });
  if (!canRespeak) return;
  clearTimeout(m.pendingBarge?.timer);
  const pb: NonNullable<Meeting["pendingBarge"]> = { cand: last, rest, bargeId };
  // 끊은 말이 안 오면(기침·잡음) 남이 끊은 것과 같게 본다
  pb.timer = setTimeout(() => {
    if (m.pendingBarge !== pb || m.ended) return;
    m.pendingBarge = undefined;
    respeak(m, pb.cand, pb.rest, "끊은 말이 안 옴(잡음)");
  }, TIMING.bargeWaitMs);
  m.pendingBarge = pb;
}

// 끊은 말(utterance.barge)이 오면 판정대로
function settleBarge(m: Meeting, id: number, verdict: UtteranceReq["barge"]) {
  const pb = m.pendingBarge;
  if (!pb) return;
  // /barge가 id 없이 왔으면 끊은 뒤 처음 온 말로 판정한다
  if (pb.bargeId !== undefined && pb.bargeId !== id) return;
  clearTimeout(pb.timer);
  m.pendingBarge = undefined;
  if (verdict === "other") respeak(m, pb.cand, pb.rest, "등록 안 된 목소리가 끊음");
  else pb.cand.note = `끊김 인정 (${verdict ?? "판정 없음"})`;
}

// 남은 문장을 새 후보로 (한 번만). 쓴 예산·쿨다운은 돌려준다. 다음 침묵에 끊고 들어온 말까지 보고 다시 확인한다
function respeak(m: Meeting, last: Candidate, rest: string[], why: string) {
  const i = m.voiceLedger.findIndex((x) => x.at === last.t.delivered);
  if (i >= 0) m.voiceLedger.splice(i, 1);
  m.lastConflictAt = last.prevConflictAt ?? 0;
  const u = m.utts.find((x) => x.id === last.uttId) ?? m.utts[m.utts.length - 1];
  const sentences = rest.map(stripOpener).filter(Boolean);
  if (!u || !sentences.length) return;
  const again = newCandidate(m, u, last.kind, { said: last.said, against: last.against, nodeIds: last.nodeIds, factIds: last.factIds, sentences, evidence: last.evidence, verified: true, respoken: true, staleAfter: (last.staleAfter ?? STALE_AFTER) + 2 });
  again.why = last.why;
  again.note = why;
  for (const x of [...last.nodeIds, ...last.factIds]) m.flagged.delete(x);
  again.queued = true;
  emit(m, { type: "queued", actionId: again.actionId, kind: again.kind, preview: again.sentences[0] ?? "", why: again.why, evidence: again.evidence.slice(0, 1) });
  markReady(m, again);
}

// 손든 것을 화면에서 수락하면 같은 actionId로 말한다
export function onRespond(m: Meeting, actionId: string, accept: boolean): boolean {
  const c = m.cands.find((x) => x.actionId === actionId && x.state === "raised");
  if (!c) return false;
  if (accept) deliver(m, c, "respond");
  else cancel(m, c, "dismissed");
  return true;
}

// 다이얼을 바꾼다: 채널·강도·쿨다운·리듬이 같이 바뀐다. 손들기 채널이 된 준비된 말은 손으로 내린다
function applyDial(m: Meeting, participation: number, intensity?: Intensity) {
  m.profile = profileOf(participation);
  m.participation = m.profile.participation;
  m.intensity = intensity ?? m.profile.intensity;
  m.roles = resolveRoles(m.profile, m.rolesOverride);
  if (m.profile.rhythm !== "batch") flushBatch(m);
  for (const c of m.cands.filter((x) => x.state === "ready" && VOICE_COST[x.kind] !== undefined && x.verified)) if (quiet(m) || chan(m, c.kind) === "hand") raise(m, c);
}

// 말로 하는 설정("끼어들지 마"·"적극적으로")은 강도로 오고, 다이얼도 그 강도의 값으로 옮긴다 (low 2 · mid 5 · high 7)
function setIntensity(m: Meeting, intensity: Intensity, by: string) {
  m.quietAsked = intensity === "low";
  applyDial(m, INTENSITY_DIAL[intensity], intensity);
  emit(m, { type: "settings", intensity, by, participation: m.participation });
}

// 화면 슬라이더로 다이얼을 바꿈. 올리는 건(더 끼어들게) 강도 올리기처럼 confirmed + 회의 열쇠가 있어야 한다 (S9 V5)
export function onParticipation(m: Meeting, participation: number, confirmed: boolean, opts: { token?: string; by?: string } = {}): { applied: boolean; needConfirm: boolean } {
  const by = opts.by ?? "screen";
  const p = Math.max(0, Math.min(10, Math.round(participation)));
  if (p > m.participation && !(confirmed && opts.token === m.controlToken)) {
    emit(m, { type: "settings", intensity: m.intensity, by, participation: m.participation, pendingConfirm: profileOf(p).intensity });
    return { applied: false, needConfirm: true };
  }
  if (p !== m.participation) {
    applyDial(m, p);
    emit(m, { type: "settings", intensity: m.intensity, by, participation: m.participation });
  }
  return { applied: true, needConfirm: false };
}

// 화면에서 바꿈. 올리는 건 confirmed=true와 화면만 아는 controlToken이 같이 있어야 한다 (S9 V5)
export function onSettings(m: Meeting, intensity: Intensity, confirmed: boolean, opts: { token?: string; by?: string } = {}): { applied: boolean; needConfirm: boolean } {
  const by = opts.by ?? "screen";
  const order: Intensity[] = ["low", "mid", "high"];
  const up = order.indexOf(intensity) > order.indexOf(m.intensity);
  if (up && !(confirmed && opts.token === m.controlToken)) {
    emit(m, { type: "settings", intensity: m.intensity, by, pendingConfirm: intensity });
    return { applied: false, needConfirm: true };
  }
  if (intensity !== m.intensity) setIntensity(m, intensity, by);
  return { applied: true, needConfirm: false };
}

// ── 1분 요약 ───────────────────────────────────────────────
function maybeSummarize(m: Meeting) {
  if (m.summarizing || !m.utts.length) return;
  const nowT = m.utts[m.utts.length - 1].t1;
  if (nowT - m.lastSummaryT < (m.health.budgetHit ? 180 : 60) || !canThink(m)) return;
  // 한 번에 많이 넘기면 요약이 길어져 잘린다 → 40마디씩
  const toSummarize = splitRecent(
    m.utts.filter((u) => !u.echo),
    m.summarizedUpTo,
  ).toSummarize.slice(0, 40);
  if (!toSummarize.length) return;
  m.summarizing = true;
  void track(
    m,
    ask(m, "summarize", {
      system: [SUMMARY_SYSTEM],
      user: `## 이전 요약\n${m.summary || "(없음)"}\n\n## 그 뒤 발화\n${toSummarize.map(uttLine).join("\n")}`,
      maxTokens: 1000,
      allowTruncated: true,
    }),
  )
    .then(({ text, stat }) => {
      record(m, stat);
      m.summary = text.trim();
      m.summarizedUpTo = toSummarize[toSummarize.length - 1].id;
      m.lastSummaryT = nowT;
    })
    .catch((e) => fail(m, "summarize", e))
    .finally(() => (m.summarizing = false));
}

// ── 체크리스트 (회의 중에도, 끝에도) ─────────────────────────
// 손든 항목은 넣지 않는다 (화면이 따로 보여준다)
export function scheduleChecklist(m: Meeting, delayMs = TIMING.checklistDelayMs) {
  if (!m.agenda.some((a) => a.expected.length) || m.ended) return;
  clearTimeout(m.checklistTimer);
  m.checklistTimer = setTimeout(() => {
    if (m.checklistRunning || m.ended) return;
    m.checklistRunning = true;
    void track(m, buildChecklist(m))
      .then((items) => {
        if (!m.ended) emit(m, { type: "checklist", items, final: false });
      })
      .catch((e) => fail(m, "checklist", e))
      .finally(() => (m.checklistRunning = false));
  }, delayMs);
}

export async function buildChecklist(m: Meeting): Promise<ChecklistItem[]> {
  const pairs = m.agenda.flatMap((a) => a.expected.map((e) => ({ agenda: a.title, expected: e })));
  if (!pairs.length) return [];
  const transcript = m.utts
    .filter((u) => !u.echo)
    .map(uttLine)
    .join("\n");
  const { out, stat } = await ask(m, "summarize", {
    system: [CHECKLIST_SYSTEM],
    user: `## 안건 × 나와야 할 것\n${pairs.map((p, i) => `${i + 1}. ${p.agenda} — ${p.expected}`).join("\n")}\n\n## 녹취\n${transcript}`,
    schema: ChecklistOut,
    strict: true,
    maxTokens: 2000,
  });
  record(m, stat);
  return pairs.map((p, i) => {
    // 번호로 먼저 찾고(모델이 문구를 조금 바꿔 적는 일이 있다), 없으면 문구로
    const hit = out.items.find((x) => x.n === i + 1) ?? out.items.find((x) => x.agenda === p.agenda && x.expected === p.expected);
    const ev: Evidence[] = (hit?.utt_ids ?? [])
      .map((id) => m.utts.find((u) => u.id === id))
      .filter((u): u is Utt => !!u)
      .map((u) => ({ label: `지금 회의 — ${u.speaker ?? "누군가"}`, quote: u.text }));
    return { agenda: p.agenda, expected: p.expected, status: hit?.status ?? "open", note: hit?.note || undefined, evidence: ev };
  });
}

// ── 회의 끝 ───────────────────────────────────────────────
export function endMeeting(m: Meeting): Promise<EndMeetingRes> {
  if (!m.ending) {
    flushBatch(m); // 모아 둔 말도 합의 카드·체크리스트에 들어가게 (묶음은 회의가 끝나도 끝까지 본다)
    m.ended = true;
    clearTimeout(m.checklistTimer);
    m.ending = finish(m);
  }
  return m.ending;
}

async function finish(m: Meeting): Promise<EndMeetingRes> {
  await m.chain;
  for (let i = 0; i < 100 && m.busy > 0; i++) await new Promise((r) => setTimeout(r, 100));

  let items: ChecklistItem[] = [];
  try {
    items = await buildChecklist(m);
  } catch (e) {
    fail(m, "checklist", e);
    items = m.agenda.flatMap((a) => a.expected.map((e) => ({ agenda: a.title, expected: e, status: "open" as const, note: "확인하지 못했어요", evidence: [] })));
  }
  m.checklist = items;

  // 녹취 전체를 기존 정리 파이프라인으로. 발화 배열을 그대로 넘긴다 — 글을 다시 줄로 나누지 않으니
  // 한 발화 속 "이름:"이 다른 사람 말이 되지 않는다 (S9 V4). 미티의 말은 넣지 않는다(화자 "미티"가 팀원으로 잡히지 않게).
  try {
    const utts = m.utts.map((u, i) => ({ idx: i + 1, speaker: u.speaker?.trim() || "?", text: u.text }));
    if (utts.length) {
      const transcript = utts.map((u) => `${u.speaker}: ${u.text}`).join("\n");
      const s = createSessionFromUtterances(m.spaceId, m.title, seoulDate(m.startedAt), transcript, utts);
      m.sessionId = s.id;
      saveLiveRecord(s.id, liveRecordFrom(m, items)); // 회의 뒤 정리 화면·다음 회의 준비가 읽는다 (S10)
      if (process.env.LIVE_AUTO_PROCESS !== "0") void processSession(s.id).then(() => fixOneLine(m, s.id)).catch((e) => fail(m, "process", e));
    }
  } catch (e) {
    fail(m, "createSession", e);
  }
  // 말로 회의를 끝내면 화면은 /end 응답을 못 받으니, 끝 체크리스트에 정리 회의 번호를 붙인다 (계약 확장)
  emit(m, { type: "checklist", items, final: true, ...(m.sessionId ? { sessionId: m.sessionId } : {}) } as AgentEvent);
  return { sessionId: m.sessionId, items };
}

// 회의 날짜는 한국 시간으로 (11/2 새벽 1시 반 회의가 UTC로 "11. 1."이 됨)
export function seoulDate(ms: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(ms));
}

// 정리가 끝난 뒤 한 줄 요약이 미티가 기록으로 답한 지난 결정을 "못 정함"으로 썼으면 바로잡는다 (정리 파이프라인은 사람 말만 읽는다).
// 부름 대답 가운데 지난 기록·자료가 근거인 것만 준다 — 웹에서 찾은 건 기록이 아니라 안 준다.
export async function fixOneLine(m: Meeting, sessionId: string): Promise<void> {
  const answers = m.cands.filter((c) => c.kind === "answer" && c.state !== "dropped" && c.evidence.some((e) => e.nodeId || e.docId) && !c.evidence.some((e) => e.label.startsWith("웹 ·")));
  if (!answers.length) return;
  const row = getDb().prepare(`SELECT topics_json FROM sessions WHERE id = ?`).get(sessionId) as { topics_json: string | null } | undefined;
  const cur = row?.topics_json ? (JSON.parse(row.topics_json) as { topics?: string[]; one_line?: string }) : null;
  if (!cur?.one_line) return;
  const qa = answers.map((c) => `- ${uttLine(m.utts.find((u) => u.id === c.uttId) ?? { id: c.uttId, t0: 0, t1: 0, text: "", receivedAt: 0 })} → 미티: ${c.sentences.join(" ")} (근거: ${c.evidence.map((e) => e.label).slice(0, 2).join(" / ")})`).join("\n");
  const transcript = m.utts.filter((u) => !u.echo).map((u) => `${u.speaker ?? "?"}: ${u.text}`).join("\n");
  // Sonnet(verify) — Haiku는 셋에 한 번 틀린 요약을 OK로 넘겼다 (scripts/live-oneline-check.ts)
  const r = await call("verify", { system: [ONE_LINE_FIX_SYSTEM], user: `## 녹취\n${transcript}\n\n## 지금 한 줄 요약\n${cur.one_line}\n\n## 미티가 기록에서 찾아 답한 것\n${qa}`, maxTokens: 300 });
  record(m, r.stat);
  const line = r.text.trim().split("\n")[0].trim().replace(/^[^:：]{0,15}요약\s*[:：]\s*/, ""); // "고친 한 줄 요약: …" 머리를 뗀다
  if (!line || /^OK\b/i.test(line)) return;
  getDb().prepare(`UPDATE sessions SET topics_json = ? WHERE id = ?`).run(JSON.stringify({ ...cur, one_line: line }), sessionId);
  m.oneLineFix = { from: cur.one_line, to: line };
}

// 디버그용 상태 (화면은 쓰지 않는다)
export function snapshot(m: Meeting) {
  const byRole: Record<string, { n: number; avgMs: number; avgFirstMs: number; maxMs: number; hedged: number; cost: number; cacheRead: number; input: number }> = {};
  for (const s of m.stats) {
    const r = (byRole[s.role] ??= { n: 0, avgMs: 0, avgFirstMs: 0, maxMs: 0, hedged: 0, cost: 0, cacheRead: 0, input: 0 });
    r.maxMs = Math.max(r.maxMs, s.ms);
    if (s.hedged) r.hedged++;
    r.avgMs = (r.avgMs * r.n + s.ms) / (r.n + 1);
    r.avgFirstMs = (r.avgFirstMs * r.n + (s.firstTokenMs ?? s.ms)) / (r.n + 1);
    r.n++;
    r.cost += s.cost;
    r.cacheRead += s.cacheRead;
    r.input += s.input;
  }
  return {
    id: m.id,
    intensity: m.intensity,
    busy: m.busy,
    ended: m.ended,
    sessionId: m.sessionId ?? null,
    utts: m.utts.length,
    templates: m.templates.size,
    templateStats: m.templateStats ?? null,
    participation: m.participation,
    profile: m.profile,
    cands: m.cands.map(({ actionId, kind, uttId, state, said, against, nodeIds, factIds, sentences, note, t }) => ({ actionId, kind, uttId, state, said, against, nodeIds, factIds, sentences, note, t })),
    shadowLog: m.shadowLog,
    budget: budgetState(m),
    roles: m.roles,
    cards: m.cards,
    byRole,
    cost: m.stats.reduce((a, s) => a + s.cost, 0),
    tokenLog: m.tokenLog,
    watchLog: m.watchLog,
    echoLog: m.echoLog,
    webLog: m.webLog,
    oneLineFix: m.oneLineFix,
    partialLog: m.partialLog,
    solo: m.solo,
    soloLog: m.soloLog,
    planLog: m.planLog,
    state: m.state,
    health: m.health,
    stats: m.stats,
    errors: m.errors,
    summary: m.summary,
  };
}
