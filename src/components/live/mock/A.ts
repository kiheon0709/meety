// 시나리오 A — 회의 4 (docs/agent/scenarios/A-meeting.md). 근거 문장은 seed 녹취(data/transcripts/03-pricing.md) 그대로.
import type { ChecklistItem, Evidence } from "@/lib/live/contract";
import type { MockScenario, MockStep } from "./types";

const E_WEB: Evidence = {
  label: "10/10 회의 3 — 입구는 웹 중심, 디스코드 봇은 2단계",
  quote: "기헌: 그래. 입구는 웹 중심으로 가고 봇은 2단계. 지호 의견은 남겨두고.",
  nodeId: "decision-entry-web",
};
const E_JIHO: Evidence = {
  label: "10/10 회의 3 — 지호 의견 (남겨 둠)",
  quote: "지호: 웹 먼저 가는 건 이해하는데, 봇 없으면 \"회의록 아무도 안 읽음\" 문제는 안 풀려요.",
  nodeId: "claim-jiho-bot",
};
const E_REC: Evidence = {
  label: "10/10 회의 3 — 브라우저 녹음과 녹취 붙여넣기 함께 지원",
  quote: "기헌: 오 그럼 붙여넣기만 하기로 한 거 다시 바꾸자. 브라우저 녹음 더하기 붙여넣기로.",
  nodeId: "decision-input-both",
};

const ck = (agenda: string, expected: string, status: ChecklistItem["status"], note?: string, quote?: string): ChecklistItem => ({
  agenda,
  expected,
  status,
  note,
  evidence: quote ? [{ label: "오늘 회의", quote }] : [],
});
const VIDEO = ck("시연 영상 구성", "장면 순서 확정", "done", "회의 장면 → 정리 화면 순서", "기헌: 좋아. 그 순서로 가자.");
const DISCORD = ck("디스코드 연동 범위", "이번에 만들 범위 결정", "done", "이번엔 알림만, 봇은 2단계 유지", "기헌: 그래, 그걸로 하자.");
const REH_DATE = ck("리허설", "날짜", "done", "일요일 저녁", "태은: 리허설은 일요일 저녁에 한 번 해요.");
const REH_OWNER = ck("리허설", "담당자", "no_owner", "누가 준비할지 안 정했어요");

const steps: MockStep[] = [
  { wait: 900 },
  { say: { speaker: "기헌", text: "오늘 안건 세 개. 시연 영상 구성, 디스코드 연동 범위, 리허설." } },
  { gap: 800 },
  { say: { speaker: "태은", text: "영상은 회의하는 장면 먼저 보여주고, 그다음에 끝나고 정리된 화면 순서로 가요." } },
  { gap: 300 },
  { say: { speaker: "기헌", text: "좋아. 그 순서로 가자." } },
  { gap: 300 },
  { wait: 500 },
  {
    agent: {
      type: "change_card",
      cardId: "c-video",
      title: "시연 영상 구성",
      to: "회의 장면 → 정리 화면 순서",
      evidence: [{ label: "오늘 회의", quote: "태은: 영상은 회의하는 장면 먼저 보여주고, 그다음에 끝나고 정리된 화면 순서로 가요." }, { label: "오늘 회의", quote: "기헌: 좋아. 그 순서로 가자." }],
    },
  },
  { agent: { type: "checklist", items: [VIDEO] } },
  // 조용한 멤버 사설: 지호 화면(?me=지호)에만 뜨고 회의실 큰 화면엔 안 뜬다 (콘티 회의 3-3)
  { agent: { type: "private", actionId: "p-jiho", to: "지호", kind: "quiet_member", text: "지호 님은 어떻게 생각하세요? 말로 하기 어려우면 여기 적어 주셔도 돼요.", evidence: [] } },
  { wait: 900 },
  { say: { speaker: "준영", text: "디스코드는 이번에 봇까지 만들어서 입구를 아예 디스코드로 하죠. 그게 임팩트 있어요." } },
  { agent: { type: "queued", actionId: "a-discord", kind: "conflict", preview: "10/10에 정한 '입구는 웹 중심, 봇은 2단계'와 달라요" } },
  { agent: { type: "latency", role: "watch", ms: 420, firstTokenMs: 380 } },
  { gap: 300 },
  {
    speak: {
      type: "speak",
      actionId: "a-discord",
      kind: "conflict",
      text: "",
      sentences: [
        "잠깐만요, 10월 10일 회의에서 입구는 웹 중심으로 하고 디스코드 봇은 2단계로 미루기로 정했어요.",
        "이번에 봇을 입구로 만들면 그 결정을 다시 여는 거예요.",
        "그때 지호 님이 봇이 없으면 회의록을 안 읽는다는 의견도 남겨 두셨어요.",
      ],
      evidence: [E_WEB, E_JIHO],
    },
  },
  { agent: { type: "latency", role: "speak", ms: 910, firstTokenMs: 640 } },
  { wait: 500 },
  { say: { speaker: "기헌", text: "아 맞다, 고마워. 근데 지금 회의 중이니까 미티야 끼어들지 마." } },
  { wait: 300 },
  { agent: { type: "settings", intensity: "low", by: "기헌" } },
  { speak: { type: "speak", actionId: "a-ack", kind: "ack", text: "알겠어요, 이제 화면에 손만 들게요.", sentences: ["알겠어요, 이제 화면에 손만 들게요."], evidence: [] } },
  { wait: 900 },
  { say: { speaker: "지호", text: "그럼 봇은 알림만 보내는 걸로 하고, 2단계는 그대로 두죠." } },
  { gap: 300 },
  { say: { speaker: "기헌", text: "그래, 그걸로 하자." } },
  { gap: 300 },
  { wait: 500 },
  {
    agent: {
      type: "change_card",
      cardId: "c-discord",
      title: "디스코드 연동 범위",
      from: "봇까지 만들어 입구를 디스코드로 (준영 제안)",
      to: "이번엔 알림만, 봇은 2단계 유지",
      evidence: [{ label: "오늘 회의", quote: "지호: 그럼 봇은 알림만 보내는 걸로 하고, 2단계는 그대로 두죠." }, E_WEB],
    },
  },
  { agent: { type: "checklist", items: [VIDEO, DISCORD] } },
  { wait: 900 },
  { say: { speaker: "준영", text: "녹음은 그냥 붙여넣기만 받죠. 브라우저 녹음은 빼고요." } },
  { wait: 300 },
  { agent: { type: "latency", role: "watch", ms: 390, firstTokenMs: 350 } },
  {
    agent: {
      type: "hand_raise",
      actionId: "a-rec",
      kind: "conflict",
      preview: "'브라우저 녹음과 붙여넣기 함께 지원'으로 정해 둔 것과 달라요",
      evidence: [E_REC],
    },
  },
  { gap: 800 },
  { say: { speaker: "태은", text: "리허설은 일요일 저녁에 한 번 해요." } },
  { gap: 300 },
  { agent: { type: "checklist", items: [VIDEO, DISCORD, REH_DATE] } },
  { say: { speaker: "기헌", text: "오케이. 오늘은 여기까지." } },
  { gap: 1500 },
  { wait: 800 },
  { end: true },
];

export const A: MockScenario = {
  key: "A",
  meetingId: "demo-a",
  setup: {
    spaceId: "",
    spaceName: "심화프로젝트랩 5조 · 미티",
    title: "회의 4 — 대회 준비",
    participants: ["기헌", "준영", "태은", "지호"],
    intensity: "high",
    agenda: [
      { title: "시연 영상 구성", expected: ["장면 순서 확정"] },
      { title: "디스코드 연동 범위", expected: ["이번에 만들 범위 결정"] },
      { title: "리허설", expected: ["날짜", "담당자"] },
    ],
  },
  steps,
  onAccept: {
    "a-rec": {
      type: "speak",
      actionId: "a-rec",
      kind: "conflict",
      text: "",
      sentences: ["10월 10일 회의에서 브라우저 녹음과 녹취 붙여넣기를 함께 지원하기로 바꿨어요.", "붙여넣기만 받으면 그 결정을 되돌리는 거예요."],
      evidence: [E_REC],
    },
  },
  final: { type: "checklist", items: [VIDEO, DISCORD, REH_DATE, REH_OWNER] },
};
