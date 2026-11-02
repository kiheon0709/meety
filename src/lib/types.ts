export const NODE_TYPES = [
  "decision",
  "claim",
  "question",
  "action",
  "assumption",
  "fact",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// 타입별 허용 상태. 에이전트 출력도 이 안에서만 나와야 한다.
export const NODE_STATUSES: Record<NodeType, readonly string[]> = {
  decision: ["proposed", "agreed", "superseded", "withdrawn"],
  claim: ["open", "adopted", "rejected"],
  question: ["open", "resolved"],
  action: ["open", "done"],
  assumption: ["active", "broken"],
  fact: ["active"],
};

export const TYPE_LABEL: Record<NodeType, string> = {
  decision: "결정",
  claim: "의견",
  question: "안건",
  action: "할 일",
  assumption: "전제",
  fact: "사실",
};

export const STATUS_LABEL: Record<string, string> = {
  proposed: "제안됨",
  agreed: "합의됨",
  superseded: "바뀜",
  withdrawn: "철회됨",
  open: "열림",
  adopted: "채택됨",
  rejected: "기각됨",
  resolved: "해결됨",
  done: "완료",
  active: "유효",
  broken: "깨짐",
};

export type ApprovalMode = "any" | "deciders" | "count";
export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  any: "누구나 한 명",
  deciders: "팀장만",
  count: "여러 명 동의",
};

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

export interface Space {
  id: string;
  name: string;
  next_node_seq: number;
  approval_mode: ApprovalMode;
  approval_count: number;
  // 확인 대기 업데이트가 반대 없이 자동 확정되기까지의 시간. 0이면 자동 확정 안 함.
  review_hours: number;
  // 디스코드 incoming webhook URL. 있으면 갈피가 달라진 점·브리핑·판단 필요를 채널에 올린다.
  discord_webhook: string | null;
  is_demo: number;
  created_at: string;
}

export interface Member {
  id: string;
  space_id: string;
  user_id: string | null;
  name: string;
  role: "owner" | "member";
  is_decider: number;
  color: string;
  created_at: string;
}

export type SessionStatus = "pending" | "processing" | "done" | "error";
export type SessionKind = "meeting" | "discussion";
// 에이전트 파이프라인 단계. 화면이 폴링해서 보여준다.
export type Stage = "queued" | "topics" | "extract" | "verify" | "save" | "briefing" | "done" | "error";
export const STAGES: { key: Stage; label: string }[] = [
  { key: "topics", label: "무슨 얘기를 했는지 파악" },
  { key: "extract", label: "지난 회의와 견줘서 달라진 점 추출" },
  { key: "verify", label: "중복·근거 없는 변경 걸러내기" },
  { key: "save", label: "맥락에 반영하고 한 번 봐야 할 것 표시" },
  { key: "briefing", label: "다음 회의 브리핑 갱신" },
];

export interface Session {
  id: string;
  space_id: string;
  title: string;
  held_at: string;
  participants: string;
  transcript: string;
  status: SessionStatus;
  kind: SessionKind;
  stage: Stage | null;
  stage_detail: string | null;
  topics_json: string | null;
  error: string | null;
  usage_json: string | null;
  // 미티와 한 회의의 기록(LiveRecord JSON). 녹음·붙여넣기 회의는 null
  live_json?: string | null;
  created_at: string;
}

// 미티와 한 회의의 기록 — 회의 끝에 두뇌가 세션에 같이 남긴다 (docs/architecture/uiux-redesign.md §8).
// 회의 뒤 정리 화면(안건 체크·미티가 한 일)과 다음 회의 준비의 기본값이 이걸 읽는다.
export interface LiveRecord {
  agenda: { title: string; expected: string[] }[];
  checklist: { agenda: string; expected: string; status: "done" | "open" | "no_owner"; note?: string; quote?: string }[];
  participants: string[];
  host?: string;
  mode?: string;
  participation?: number;
  roles?: Record<string, boolean>;
  docIds?: string[];
  meety: { kind: string; channel: "speak" | "hand" | "card" | "private"; text: string; to?: string; evidence?: { label: string; quote?: string }[] }[];
}

// 근거 조각 종류 (knowledge-design §1-3). 지금 넣는 것: utterance·doc_chunk·page. 나머지는 연동이 생기면.
export type SourceKind = "utterance" | "doc_chunk" | "page" | "calendar_event" | "issue" | "message";

// 회의 발화 (kind = utterance). 자료 조각은 DocSource.
export interface Source {
  id: number;
  session_id: string;
  idx: number;
  speaker: string;
  text: string;
  created_at: string | null;
  kind?: SourceKind;
  space_id?: string | null;
}

// 자료 조각: 문서의 절·쪽, 노션 페이지의 절. 사실(DocFact)은 이 조각에서 뽑는다.
export interface DocSource {
  id: number;
  kind: Exclude<SourceKind, "utterance">;
  session_id: null;
  speaker: "";
  space_id: string;
  doc_id: string;
  idx: number;
  loc: string;
  text: string;
  external_id: string | null;
  external_url: string | null;
  content_hash: string;
  at: string | null;
  gone: number;
  created_at: string | null;
}

// 자료 한 덩어리 (docs 테이블)
export type DocKind = "doc" | "page" | "calendar" | "issues" | "channel";
export interface DocRow {
  space_id: string;
  id: string;
  kind: DocKind;
  connector: string; // upload | folder | notion | gcal | github | slack | discord
  external_id: string | null;
  external_url: string | null;
  title: string;
  role: "base" | "ref" | "archive";
  as_of: string | null;
  version: string | null;
  fetched_at: string;
  acl_json: string | null;
  status: "active" | "stale" | "gone";
}

export interface NodeFields {
  type: NodeType;
  title: string;
  body: string;
  topic: string;
  owner: string | null;
  status: string;
  // 할 일 기한 (YYYY-MM-DD). 발화에 날짜가 있을 때만.
  due?: string | null;
}

export type NodePatch = Partial<
  Pick<NodeFields, "title" | "body" | "topic" | "owner" | "status" | "due">
> & { reject_reason?: string | null };

// Commit 안의 변경 한 건. source_ids는 전역 Source.id (세션 idx → id 변환 후 저장).
export type Change =
  | { op: "add"; node_id: string; node: NodeFields; source_ids: number[]; reason: string }
  | { op: "update"; node_id: string; before: NodePatch; after: NodePatch; source_ids: number[]; reason: string }
  | { op: "supersede"; node_id: string; new_node_id: string; node: NodeFields; source_ids: number[]; reason: string }
  | { op: "withdraw"; node_id: string; source_ids: number[]; reason: string };

export type CommitStatus = "applied" | "pending" | "rejected";

export interface Commit {
  id: string;
  space_id: string;
  session_id: string;
  seq: number;
  message: string;
  status: CommitStatus;
  needs_review: number;
  review_reason: string | null;
  reverted: number;
  changes_json: string;
  author_member_id: string | null;
  // 확인 대기 업데이트가 반대 없이 자동 확정되는 시각(ISO). null이면 자동 확정 없음.
  review_deadline: string | null;
  created_at: string;
}

export interface CommitWithChanges extends Omit<Commit, "changes_json"> {
  changes: Change[];
}

export interface Approval {
  id: string;
  commit_id: string;
  member_id: string;
  vote: "approve" | "reject";
  note: string | null;
  created_at: string;
}

export interface Comment {
  id: string;
  space_id: string;
  node_id: string;
  member_id: string;
  source_id: number | null;
  text: string;
  // 이 댓글을 발화로 읽어 간 회의 처리(session id). null이면 아직 갈피가 안 읽음.
  consumed_by: string | null;
  created_at: string;
}

// HEAD 투영. commits 재생으로만 만들어진다.
export interface HeadNode extends NodeFields {
  id: string;
  space_id: string;
  source_ids: number[];
  superseded_by: string | null;
  supersedes: string | null;
  reject_reason: string | null;
  created_commit_id: string;
  updated_commit_id: string;
  sort_order: number;
  // 이 노드를 만들거나 바꾼 커밋 중 확인 대기 중인 것이 있으면 1.
  review_pending: number;
}

// 갈피(에이전트)와 사람이 한 일의 기록. 홈 피드와 알림의 원천.
export const EVENT_KINDS = ["read", "applied", "asked", "dropped", "briefing", "todo", "due", "settled", "voted", "manual", "reverted", "error"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AgentEvent {
  id: string;
  space_id: string;
  kind: EventKind;
  actor: string; // 'agent' 또는 member id
  ref_type: "session" | "commit" | "node" | "briefing" | null;
  ref_id: string | null;
  title: string;
  detail: string | null;
  created_at: string;
}

export interface Notification {
  id: string;
  space_id: string;
  member_id: string;
  event_id: string;
  read_at: string | null;
  created_at: string;
}
