import type { AgentEvent, VoiceEvent } from "@/lib/live/contract";
import type { AgentEventX, MeetingSetup } from "../state";

// 목업 대본 한 줄. say는 계약 VoiceEvent(speech_start → partial… → speech_end → final)로 풀어서 재생한다.
export type MockStep =
  | { wait: number }
  | { say: { speaker: string; text: string } }
  | { voice: VoiceEvent }
  | { gap: 300 | 800 | 1500 } // 300부터 이 값까지 차례로 gap 이벤트
  | { agent: AgentEventX }
  // 미티가 말한다: speak 이벤트를 보내고 목업 목소리가 끝날 때까지 기다린다.
  // bargeAfterMs가 있으면 그만큼 말한 뒤 사람이 끼어든다 (barge_in → cancel)
  | { speak: Extract<AgentEvent, { type: "speak" }>; bargeAfterMs?: number }
  | { end: true }; // 회의 끝 버튼을 누른 것처럼

export interface MockScenario {
  key: "A" | "B";
  meetingId: string;
  setup: MeetingSetup;
  steps: MockStep[];
  // 손든 항목을 [말해줘]로 수락하면 두뇌가 보낼 speak, [괜찮아]면 cancel
  onAccept: Record<string, Extract<AgentEvent, { type: "speak" }>>;
  // 회의 끝에 두뇌가 보낼 체크리스트
  final: Extract<AgentEvent, { type: "checklist" }>;
}
