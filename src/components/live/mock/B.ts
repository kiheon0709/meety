// 시나리오 B — 발표 중 시연 (docs/agent/scenarios/B-presentation.md). 근거는 기획 문서 B-plan.md.
import type { Evidence } from "@/lib/live/contract";
import type { MockScenario, MockStep } from "./types";

const E_LEVELS: Evidence = {
  label: "기획 문서 — 끼어들기 강도",
  quote: "세 단계다. 상: 말이 0.3초만 끊겨도 바로 말한다. 중: 0.8초 이상 끊기면 말한다. 하: 먼저 말하지 않고 화면에 손만 든다.",
  docId: "B-plan.md",
  loc: "끼어들기 강도",
};
const E_LOCAL: Evidence = {
  label: "기획 문서 — 기록과 권한",
  quote: "기존 기록은 읽기만 한다. 미티가 바꾸고 싶은 건 \"제안\"으로 남기고 사람이 확인한다.",
  docId: "B-plan.md",
  loc: "기록과 권한",
};

const steps: MockStep[] = [
  { wait: 900 },
  { say: { speaker: "기헌", text: "안녕하세요, 5조입니다. 저희가 만든 건 회의 중에 같이 앉아 있는 AI 팀원, 미티예요." } },
  { gap: 300 },
  { say: { speaker: "기헌", text: "팀이 지금까지 정한 걸 전부 기억하고 있다가, 회의 중에 어긋나는 순간 말해 줍니다." } },
  { gap: 300 },
  { say: { speaker: "기헌", text: "끼어드는 강도는 다섯 단계로 조절할 수 있고요." } },
  { agent: { type: "queued", actionId: "b-levels", kind: "conflict", preview: "기획 문서에는 강도가 세 단계예요" } },
  { gap: 300 },
  {
    speak: {
      type: "speak",
      actionId: "b-levels",
      kind: "conflict",
      text: "",
      sentences: ["잠깐만요, 기획 문서에는 끼어들기 강도가 상·중·하 세 단계로 되어 있어요."],
      evidence: [E_LEVELS],
    },
  },
  { agent: { type: "latency", role: "speak", ms: 860, firstTokenMs: 610 } },
  { wait: 500 },
  { say: { speaker: "기헌", text: "아 맞아요, 세 단계죠. 고마워. 근데 발표 중이니까 끼어들지 마." } },
  { wait: 300 },
  { agent: { type: "settings", intensity: "low", by: "기헌" } },
  { speak: { type: "speak", actionId: "b-ack", kind: "ack", text: "알겠어요, 화면에 손만 들게요.", sentences: ["알겠어요, 화면에 손만 들게요."], evidence: [] } },
  { wait: 900 },
  { say: { speaker: "기헌", text: "회의가 끝나면 미티가 팀 기록을 바로 고쳐 둡니다." } },
  { wait: 300 },
  { agent: { type: "hand_raise", actionId: "b-local", kind: "conflict", preview: "기획엔 '기록은 읽기만 하고, 바꿀 건 제안으로 남겨 사람이 확인한다'고 되어 있어요", evidence: [E_LOCAL] } },
  { gap: 800 },
  { say: { speaker: "기헌", text: "이상입니다." } },
  { gap: 1500 },
  { wait: 800 },
  { end: true },
];

export const B: MockScenario = {
  key: "B",
  meetingId: "demo-b",
  setup: {
    spaceId: "",
    spaceName: "심화프로젝트랩 5조 · 미티",
    title: "대회 발표",
    participants: ["기헌"],
    intensity: "high",
    agenda: [{ title: "발표", expected: [] }],
    docIds: ["B-plan.md"],
  },
  steps,
  onAccept: {
    "b-local": {
      type: "speak",
      actionId: "b-local",
      kind: "conflict",
      text: "",
      sentences: ["기획 문서에는 미티가 기록을 바로 고치지 않고, 제안으로 남겨서 사람이 확인한다고 되어 있어요."],
      evidence: [E_LOCAL],
    },
  },
  final: { type: "checklist", items: [] },
};
