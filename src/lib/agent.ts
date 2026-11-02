import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { NODE_STATUSES, NODE_TYPES } from "./types";
import type { HeadNode } from "./types";
import type { ParsedUtterance } from "./transcript";
import { annotateDates } from "./date";

export const MODEL = "claude-opus-5-5";

// $/MTok, 모델별 (2026-10 공식 단가표). 캐시 쓰기는 입력의 1.25배.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  ms: number;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    model: a.model,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cost_usd: Math.round((a.cost_usd + b.cost_usd) * 10000) / 10000,
    ms: a.ms + b.ms,
  };
}

function toUsage(u: Anthropic.Usage, ms: number, model: string = MODEL): Usage {
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const PRICE = PRICES[model] ?? PRICES[MODEL];
  const cost =
    (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + cr * PRICE.cacheRead + cw * PRICE.cacheWrite) /
    1_000_000;
  return {
    model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: cr,
    cache_creation_input_tokens: cw,
    cost_usd: Math.round(cost * 10000) / 10000,
    ms,
  };
}

let _client: Anthropic | null = null;
function client() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// ---------- 변화 추출 ----------

const NodeOut = z.object({
  type: z.enum(NODE_TYPES),
  title: z.string(),
  body: z.string(),
  topic: z.string(),
  owner: z.string().nullable(),
  status: z.string(),
  due: z.string().nullable(), // action 기한 YYYY-MM-DD. 발화에 날짜가 있을 때만
});

const PatchOut = z.object({
  title: z.string().nullable(),
  body: z.string().nullable(),
  topic: z.string().nullable(),
  owner: z.string().nullable(),
  status: z.string().nullable(),
  due: z.string().nullable(),
  reject_reason: z.string().nullable(),
});

const ChangeOut = z.object({
  op: z.enum(["add", "update", "supersede", "withdraw"]),
  node_id: z.string().nullable(),
  node: NodeOut.nullable(),
  patch: PatchOut.nullable(),
  source_idxs: z.array(z.number()),
  reason: z.string(),
});

const CommitOut = z.object({
  message: z.string(),
  needs_review: z.boolean(),
  review_reason: z.string().nullable(),
  // 이 커밋이 녹취를 맞게 읽었다는 확신. 0~1. 낮으면 저장 단계가 "한 번 봐주세요"로 돌린다.
  confidence: z.number(),
  changes: z.array(ChangeOut),
});

const ExtractOut = z.object({ commits: z.array(CommitOut) });
export type AgentCommit = z.infer<typeof CommitOut>;
export type AgentChange = z.infer<typeof ChangeOut>;

const statusTable = NODE_TYPES.map((t) => `- ${t}: ${NODE_STATUSES[t].join(" / ")}`).join("\n");

const EXTRACT_SYSTEM = `너는 팀의 "맥락 저장소"를 관리하는 에이전트다. 회의록 요약기가 아니라 **diff 생성기**다.
입력으로 (1) 현재 맥락 상태(HEAD: 노드 목록)와 (2) 새 회의 전사본을 받는다.
출력은 "이 회의로 맥락이 어떻게 바뀌었나"를 커밋 목록으로 표현한 것이다. 요약하지 말고, 바뀐 것만 낸다.

## 노드
맥락의 최소 단위. 타입과 허용 상태:
${statusTable}
- decision: 팀이 정한 것. 참석자들이 동의하면 agreed. **한 사람이 제안만 했거나 다른 사람 반응이 없으면 proposed로 둔다** — 이건 확인을 요청할 일이 아니라 상태로 표현할 일이다.
- claim: 한 사람의 의견. owner에 화자 이름. 결정의 근거, 반대 의견, 버려진 대안도 claim이다.
- question: 아직 안 정한 안건. 정해지면 resolved로 update하고, 그 답은 decision으로 add한다.
- action: 할 일. owner에 담당자. 끝나면 done. due는 발화에 기한이 나오면 YYYY-MM-DD로("이번 주 금요일까지"는 회의 일시로 계산), 안 나오면 null. "다음 회의까지"는 null.
- 날짜: 발화 끝의 [일요일 = 11/1(일)] 같은 표시는 회의 날짜로 미리 계산해 둔 것이다. 날짜를 쓸 땐 이 표시를 쓰고, title·body에는 **원문 표현을 남긴 채** 괄호로 붙인다("일요일(11/1) 저녁"). 표시에 없는 날짜를 스스로 계산해 넣지 마라.
- assumption: 결정이 기대고 있는 가정. 반증되면 broken.
- fact: 객관적 데이터·조사 결과. 누구의 생각이 아닌 것.

## 변경(change) 종류
- add: 새 노드. HEAD에 같은 내용의 노드가 없을 때만.
- update: 기존 노드의 상태나 내용을 바꿈. patch에 바뀌는 필드만 넣고 나머지는 null. 상태 전이(question→resolved, action→done, assumption→broken, claim→adopted/rejected)에 쓴다. claim을 rejected로 바꿀 땐 reject_reason을 채운다.
- supersede: **결정이 뒤집힐 때**. 기존 결정 node_id를 지정하고, node에 새 결정을 넣는다. 결정의 실질이 바뀌는 건 절대 update로 처리하지 말고 supersede로 해라. 그래야 "A → B" 히스토리가 남는다.
- withdraw: 결정을 철회하고 대체 결정이 없을 때.

## 최우선 규칙
1. **이미 있는 노드를 먼저 찾아라.** HEAD에 같은 주제·같은 내용의 노드가 있으면 그 id로 update/supersede 한다. 새로 만드는 건 정말 없을 때만. 중복 노드를 만드는 것이 가장 큰 실패다.
2. 모든 변경에 source_idxs(근거 발화 번호)를 1개 이상 넣는다. 근거 발화가 없는 변경은 내지 마라.
3. 같은 전사본 안에서 새로 만든 노드는 id가 없으므로 참조할 수 없다. 한 회의 안에서 생겼다가 바뀐 것은 최종 상태 하나로만 add 한다.
4. 잡담, 인사, 진행 멘트는 노드가 아니다.
5. 한 커밋 = 의미 있는 변화 한 덩어리 (예: "타깃을 대학생에서 직장인으로 변경"에 supersede + 관련 claim add + assumption broken이 함께 들어감). 커밋은 논의된 순서대로.
6. 커밋 message는 비개발자가 읽는 한 줄: "무엇이 왜 바뀌었나". 예: "인터뷰 결과 광고 모델이 안 먹혀서 타깃을 직장인으로 변경". git 용어 쓰지 마라.
7. topic은 짧은 명사구(예: "타깃", "가격", "출시 일정"). HEAD에 이미 있는 topic 이름을 재사용해라.
8. title은 40자 이내 한 줄, body는 1~2문장으로 내용과 이유. 발화를 그대로 복사하지 말고 정리해서 써라.
9. owner: claim과 action은 화자/담당자 이름. 팀이 합의한 decision은 null.
10. HEAD 노드에 review_pending: true 가 붙어 있으면 지난 회의에서 나왔지만 아직 사람이 확인하지 않은 것이다. 그래도 현재 맥락으로 취급해서 그 id로 update/supersede 해라. 다시 add 하지 마라.
11. message·reason·review_reason·body·reject_reason은 팀원이 읽는 글이다. 노드 id(n12 같은 것)나 영어 상태값(agreed, superseded 등)을 쓰지 말고 우리말로 써라. 예: "이미 합의한 승인 방식 결정을 바꾸는 변경이에요."

## 판단 게이트 (needs_review) — 딱 두 경우만
needs_review=true 는 팀원에게 "한 번 봐주세요"를 보내는 것이다. 반대가 없으면 기한 뒤 그대로 확정되므로, 정말 사람이 봐야 할 때만 써라.
1. 이미 agreed 상태인 결정을 supersede 또는 withdraw 할 때 (같이 정한 걸 바꾸는 것)
2. 참석자 간 반대가 남은 채로 끝났는데 한쪽을 agreed 결정으로 기록할 때
그 외는 전부 needs_review=false. 특히:
- 한 사람 의견만 나온 결정은 게이트가 아니라 **proposed 상태의 decision**으로 저장한다.
- 새 의견·안건·할 일·사실 추가, 안건 해결, 할 일 완료, 명확한 합의는 그냥 반영한다.
review_reason은 팀원이 읽는 한 문장: 무엇을 바꾸는 건지, 누가 어떤 우려를 남겼는지.

## confidence
커밋마다 네가 녹취를 맞게 읽었다는 확신을 0~1로 적어라. 발화가 끊겼거나, 대명사가 많아 무엇을 가리키는지 애매하거나, 화자가 뒤섞여 보이면 낮게(0.5 이하). 평범하게 또렷한 대화면 0.8 이상.`;

export async function extractCommits(input: {
  head: ReturnType<typeof import("./head").compactHead>;
  utterances: ParsedUtterance[];
  sessionTitle: string;
  heldAt: string;
  commentsFrom?: number; // 이 번호부터는 회의 사이에 남긴 댓글
}): Promise<{ commits: AgentCommit[]; usage: Usage }> {
  const transcript = input.utterances.map((u) => `[${u.idx}] ${u.speaker}: ${annotateDates(u.text, input.heldAt)}`).join("\n");
  const note = input.commentsFrom ? `\n\n(참고: [${input.commentsFrom}]번부터는 회의 사이에 팀원이 화면에 남긴 댓글이다. 회의 발화와 똑같이 근거로 쓸 수 있다.)` : "";
  const user = `## 현재 맥락 상태 (HEAD)
${input.head.length ? JSON.stringify(input.head, null, 1) : "(비어 있음 — 첫 회의)"}

## 새 회의 전사본
제목: ${input.sessionTitle}
일시: ${input.heldAt}

${transcript}${note}

위 전사본으로 맥락이 어떻게 바뀌었는지 커밋 목록으로 출력해라.`;

  const t0 = Date.now();
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "high", format: zodOutputFormat(ExtractOut) },
    system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const ms = Date.now() - t0;
  if (res.stop_reason === "refusal") throw new Error("모델이 응답을 거부했습니다");
  if (res.stop_reason === "max_tokens") throw new Error("출력이 max_tokens에 잘렸습니다");
  if (!res.parsed_output) throw new Error("구조화 출력 파싱 실패");
  return { commits: res.parsed_output.commits, usage: toUsage(res.usage, ms) };
}

// ---------- "갈피에게 말하기" — 팀원 한 명의 한 줄을 업데이트로 ----------

const TellOut = z.object({
  understood: z.string(), // 갈피가 이해한 바를 팀원에게 되말하는 한 문장
  commits: z.array(CommitOut), // 보통 0 또는 1개
});

const TELL_SYSTEM = `${EXTRACT_SYSTEM}

## 지금 입력은 회의가 아니다
팀원 한 명이 회의 밖에서 미티에게 한 줄로 말한 것이다. 예: "로고는 지호가 맡기로 했어", "가격 안건은 무료로 가기로 하고 닫자", "내 할 일 끝냈어".
- 전사본은 한 줄뿐이고 번호는 [1]이다. 모든 변경의 source_idxs는 [1].
- 말한 사람 이름이 주어진다. "내", "나"는 그 사람이다.
- 가리키는 항목을 HEAD에서 찾아 그 id로 update/supersede 해라. 찾을 수 없고 새 내용이면 add.
- 한 사람의 전언으로 팀 결정을 뒤집는 것이면 게이트 규칙대로 needs_review=true.
- 무슨 뜻인지 모르겠거나 맥락과 관계없는 말이면 commits를 비우고 understood에 왜 못 알아들었는지 쓴다.
- understood는 "~로 이해했어요" 꼴의 한 문장. 해요체.`;

export async function interpretTell(input: {
  head: ReturnType<typeof import("./head").compactHead>;
  speaker: string;
  text: string;
  focus?: { id: string; title: string } | null;
}): Promise<{ understood: string; commits: AgentCommit[]; usage: Usage }> {
  const t0 = Date.now();
  const res = await client().messages.parse({
    model: "claude-sonnet-5-5",
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(TellOut) },
    system: [{ type: "text", text: TELL_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `## 현재 맥락 상태 (HEAD)\n${JSON.stringify(input.head, null, 1)}\n\n## 말한 사람\n${input.speaker}${input.focus ? `\n\n## 지금 보고 있던 항목\n${input.focus.id}: ${input.focus.title}` : ""}\n\n## 한 말\n[1] ${input.speaker}: ${input.text}`,
      },
    ],
  });
  const u = toUsage(res.usage, Date.now() - t0, "claude-sonnet-5-5");
  const out = res.parsed_output ?? { understood: "무슨 뜻인지 못 알아들었어요.", commits: [] };
  return { ...out, usage: u };
}

// ---------- "고쳐주세요" — 틀린 정리를 팀원의 한 줄로 바로잡아 다시 정리 ----------

const FIX_SYSTEM = `${EXTRACT_SYSTEM}

## 지금 입력은 "다시 정리"다
네가 전에 만든 업데이트 하나가 틀렸다고 팀원이 알려줬다. 그 업데이트는 이미 되돌려졌고(HEAD에서 빠짐), 같은 근거 발화와 팀원의 지적을 보고 **올바른 업데이트를 새로** 만든다.
- 발화 번호는 주어진 그대로 쓴다. 마지막 번호는 팀원의 지적이다(이것도 근거로 쓸 수 있다).
- 팀원의 지적이 맞다고 보고 따르되, 발화에 없는 내용을 지어내지 마라.
- 지적이 "이건 아예 없던 일이야" 류면 commits를 비워라(되돌린 채로 둔다).
- understood는 "~로 다시 정리했어요" 꼴의 한 문장. 해요체.`;

export async function interpretFix(input: {
  head: ReturnType<typeof import("./head").compactHead>;
  speaker: string;
  correction: string;
  original: string; // 원래 업데이트 설명
  utterances: ParsedUtterance[];
}): Promise<{ understood: string; commits: AgentCommit[]; usage: Usage }> {
  const t0 = Date.now();
  const transcript = input.utterances.map((u) => `[${u.idx}] ${u.speaker}: ${u.text}`).join("\n");
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "medium", format: zodOutputFormat(TellOut) },
    system: [{ type: "text", text: FIX_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `## 현재 맥락 상태 (HEAD, 틀린 업데이트는 이미 빠짐)\n${JSON.stringify(input.head, null, 1)}\n\n## 되돌린 업데이트\n${input.original}\n\n## 근거 발화 + 팀원의 지적\n${transcript}\n\n올바른 업데이트를 새로 만들어라.` }],
  });
  const u = toUsage(res.usage, Date.now() - t0);
  const out = res.parsed_output ?? { understood: "어떻게 고쳐야 할지 못 알아들었어요.", commits: [] };
  return { ...out, usage: u };
}

// ---------- "갈피에게 물어보기" — 현재 상태 + 발화 근거로 답 ----------

const AnswerOut = z.object({
  answer: z.string(), // 마크다운 없이 2~5문장. 해요체
  node_ids: z.array(z.string()), // 답의 근거가 된 항목 id (최대 3)
  source_idxs: z.array(z.number()), // 답의 근거가 된 발화 번호 (최대 3)
  confident: z.boolean(), // 맥락에 답이 있는가
});

const ANSWER_SYSTEM = `너는 팀의 맥락 저장소를 아는 "서기"다. 팀원이 묻는 말에 **저장된 맥락과 발화만으로** 답한다.
- 답은 해요체, 2~5문장, 마크다운 없이. 먼저 결론, 다음에 언제·왜 그렇게 됐는지.
- 결정이 바뀐 이력(supersedes)이 있으면 "처음엔 A였다가 ○월 ○일 B로 바뀌었어요" 식으로 길을 말해라.
- 누구 의견이었는지(owner)를 밝혀라.
- 맥락에 없는 건 지어내지 말고 "기록에 없어요"라고 해라(confident=false).
- node_ids엔 답의 근거가 된 항목 id를 최대 3개, source_idxs엔 근거 발화 번호를 최대 3개. 노드 id나 영어 상태값을 answer 본문에 쓰지 마라.`;

export async function answerQuestion(input: {
  spaceName: string;
  question: string;
  nodes: object[];
  utterances: ParsedUtterance[];
}): Promise<{ answer: string; node_ids: string[]; source_idxs: number[]; confident: boolean; usage: Usage }> {
  const t0 = Date.now();
  const transcript = input.utterances.map((u) => `[${u.idx}] ${u.speaker}: ${u.text}`).join("\n");
  const res = await client().messages.parse({
    model: "claude-sonnet-5-5",
    max_tokens: 2000,
    output_config: { format: zodOutputFormat(AnswerOut) },
    system: ANSWER_SYSTEM,
    messages: [{ role: "user", content: `프로젝트: ${input.spaceName}\n오늘: ${new Date().toISOString().slice(0, 10)}\n\n## 맥락 (대체된 항목 포함)\n${JSON.stringify(input.nodes, null, 1)}\n\n## 관련 발화\n${transcript || "(없음)"}\n\n## 질문\n${input.question}` }],
  });
  const u = toUsage(res.usage, Date.now() - t0, "claude-sonnet-5-5");
  const out = res.parsed_output ?? { answer: "답을 만들지 못했어요.", node_ids: [], source_idxs: [], confident: false };
  return { ...out, usage: u };
}

// ---------- ① 주제 파악 (가벼운 모델) ----------

const TopicsOut = z.object({
  topics: z.array(z.string()),
  participants: z.array(z.string()),
  one_line: z.string(),
});

export async function extractTopics(utterances: ParsedUtterance[]): Promise<{ topics: string[]; participants: string[]; one_line: string; usage: Usage }> {
  const transcript = utterances.map((u) => `${u.speaker}: ${u.text}`).join("\n");
  const t0 = Date.now();
  const res = await client().messages.parse({
    model: "claude-haiku-5-5",
    max_tokens: 2000,
    output_config: { format: zodOutputFormat(TopicsOut) },
    system: "회의 녹취를 읽고 (1) 다룬 주제를 짧은 명사구 3~8개로, (2) 참석자 이름을, (3) 이 회의를 한 줄로 요약해 출력한다. 한국어. 주제는 '가격', '출시 일정'처럼 2~6글자.",
    messages: [{ role: "user", content: transcript }],
  });
  const u = toUsage(res.usage, Date.now() - t0, "claude-haiku-5-5");
  const out = res.parsed_output ?? { topics: [], participants: [], one_line: "" };
  return { ...out, usage: u };
}

// ---------- ③ 자기검증 (중간 모델) ----------

const VerifyOut = z.object({
  drops: z.array(z.object({ commit: z.number(), change: z.number(), reason: z.string() })),
  review_overrides: z.array(z.object({ commit: z.number(), needs_review: z.boolean(), reason: z.string() })),
});

const VERIFY_SYSTEM = `너는 다른 에이전트가 녹취에서 뽑은 "맥락 변경 목록"을 검수한다. 네 일은 버리는 것뿐이다. 새로 만들지 마라.
버려야 하는 변경 (drops):
- 근거 발화(source_idxs)가 실제로 그 변경을 뒷받침하지 않는 것. 단 발화 끝의 [일요일 = 11/1(일)] 같은 표시는 회의 날짜로 계산한 것이라 근거로 친다 — "일요일" 발화에 "11/1"을 붙인 제목은 뒷받침되는 것이다
- HEAD에 이미 같은 내용의 노드가 있는데 또 add 하는 것 (중복)
- 잡담·진행 멘트·"네", "좋아요" 같은 걸 의견(claim)으로 만든 것
- 결정을 뒤집는 게 아닌데 supersede 한 것, 또는 뒤집는데 update로 내용만 바꾼 것은 버리지 말고 그대로 둔다 (고칠 수 없으므로)
needs_review 재판정 (review_overrides): 게이트는 두 경우뿐이다 — (1) 이미 합의된 결정을 대체·철회, (2) 반대가 남은 채 한쪽을 합의된 결정으로 기록. 이 둘인데 false면 true로, 이 둘이 아닌데 true면 false로 바꾼다. 한 사람 의견만 있는 결정은 게이트가 아니다(제안 상태로 저장되면 됨). 확신 없으면 건드리지 마라.
commit/change 번호는 0부터. review_overrides의 reason은 팀원이 읽는 한 문장이다. 노드 id나 영어 상태값 없이 우리말로.`;

export async function verifyCommits(input: { head: ReturnType<typeof import("./head").compactHead>; utterances: ParsedUtterance[]; commits: AgentCommit[]; heldAt?: string }): Promise<{ commits: AgentCommit[]; dropped: string[]; usage: Usage }> {
  const transcript = input.utterances.map((u) => `[${u.idx}] ${u.speaker}: ${input.heldAt ? annotateDates(u.text, input.heldAt) : u.text}`).join("\n");
  const t0 = Date.now();
  const res = await client().messages.parse({
    model: "claude-sonnet-5-5",
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(VerifyOut) },
    system: VERIFY_SYSTEM,
    messages: [
      {
        role: "user",
        content: `## HEAD\n${JSON.stringify(input.head)}\n\n## 녹취\n${transcript}\n\n## 검수할 변경 목록\n${JSON.stringify(input.commits.map((c, ci) => ({ commit: ci, message: c.message, needs_review: c.needs_review, changes: c.changes.map((ch, i) => ({ change: i, op: ch.op, node_id: ch.node_id, title: ch.node?.title ?? ch.patch?.title ?? null, status: ch.node?.status ?? ch.patch?.status ?? null, source_idxs: ch.source_idxs })) })))}`,
      },
    ],
  });
  const u = toUsage(res.usage, Date.now() - t0, "claude-sonnet-5-5");
  const out = res.parsed_output ?? { drops: [], review_overrides: [] };
  const dropped: string[] = [];
  const dropSet = new Set(out.drops.map((d) => `${d.commit}:${d.change}`));
  const commits = input.commits
    .map((c, ci) => {
      const changes = c.changes.filter((ch, i) => {
        const hit = dropSet.has(`${ci}:${i}`);
        if (hit) dropped.push(`${ch.op} ${ch.node?.title ?? ch.node_id ?? ""} — ${out.drops.find((d) => d.commit === ci && d.change === i)?.reason}`);
        return !hit;
      });
      const ov = out.review_overrides.find((o) => o.commit === ci);
      return { ...c, changes, needs_review: ov ? ov.needs_review : c.needs_review, review_reason: ov && ov.needs_review ? ov.reason : c.review_reason };
    })
    .filter((c) => c.changes.length > 0);
  return { commits, dropped, usage: u };
}

// ---------- 회의 전 브리핑 ----------

const BRIEF_SYSTEM = `너는 팀의 맥락 저장소에서 "다음 회의 시작 전 브리핑"을 쓰는 에이전트다.
회의 시작할 때 모두가 같은 그림을 갖도록, 아래 구조로 한국어 마크다운을 쓴다. 비개발자 말투, 간결하게.

## 지난번까지 정한 것
주제별로 현재 유효한 결정만. 한 줄씩. 최근에 바뀐 결정은 "(전엔 X였음)" 꼬리표.

## 아직 안 정한 것
열린 안건. 왜 안 정해졌는지 한 줄.

## 엇갈리는 의견
합의 안 된 채 남아 있는 반대 의견·우려가 있으면. 누구 의견인지 명시. 없으면 섹션 생략.

## 이번에 확인할 것
열린 할 일(담당자). 기한(due)이 오늘보다 지난 것은 맨 위에 "(기한 지남 ○월 ○일)"을 붙여라. 깨진 전제가 있다면 그것에 기대던 결정.

지난 회의 커밋 메시지는 "최근에 바뀐 것"을 파악하는 데만 써라. 없는 내용을 지어내지 마라.`;

export async function generateBriefing(input: {
  head: HeadNode[];
  recentCommitMessages: string[];
  spaceName: string;
}): Promise<{ content: string; usage: Usage }> {
  const nodes = input.head.map((n) => ({
    id: n.id,
    type: n.type,
    status: n.status,
    topic: n.topic,
    title: n.title,
    body: n.body,
    owner: n.owner ?? undefined,
    due: n.due ?? undefined,
    supersedes: n.supersedes ?? undefined,
    reject_reason: n.reject_reason ?? undefined,
  }));
  const user = `프로젝트: ${input.spaceName}
오늘: ${new Date().toISOString().slice(0, 10)}

## 현재 맥락 (대체·철회된 노드 포함, supersedes로 이전 버전 추적 가능)
${JSON.stringify(nodes, null, 1)}

## 지난 회의에서 바뀐 것 (커밋 메시지)
${input.recentCommitMessages.length ? input.recentCommitMessages.map((m) => `- ${m}`).join("\n") : "(없음)"}

브리핑을 써라.`;

  const t0 = Date.now();
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    system: BRIEF_SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const ms = Date.now() - t0;
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { content: text, usage: toUsage(res.usage, ms) };
}
