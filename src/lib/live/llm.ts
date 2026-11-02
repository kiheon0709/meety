// 역할 하나로 모델을 부르는 라우터. 어떤 모델인지는 models.ts가 정한다.
// 매 호출의 첫 토큰 시간·전체 시간·토큰·비용을 남긴다.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { ModelRole } from "./contract";
import { costOf, PROVIDER_ENV, ROLE_LIMITS, ROLE_MODELS, type ModelChoice } from "./models";

export interface CallInput<T extends z.ZodType> {
  // 고정 층: 역할 지시 + 회의 맥락 묶음. 마지막 블록에 캐시를 건다.
  system: string[];
  // 굴러가는 층: 최근 발화·요약·이번 발화
  user: string;
  // 있으면 출력 JSON을 이 모양으로 읽는다. strict면 API 구조화 출력(느림, 첫 토큰 +1초 안팎),
  // 아니면 글로 받은 JSON을 직접 읽는다(회의 중 판단용).
  schema?: T;
  strict?: boolean;
  maxTokens?: number;
  // 이 부름만 역할 표와 다른 모델로 (부름 대답 빠르기 실험 — LIVE_ANSWER_MODEL)
  choice?: ModelChoice;
  // 글이 흘러오는 동안 지금까지 받은 전체 글로 불린다 (앞부분만 보고 먼저 움직일 때)
  onText?: (soFar: string) => void;
  // max_tokens에서 잘려도 받은 데까지 쓴다 (요약처럼 잘려도 쓸모 있는 글)
  allowTruncated?: boolean;
  // 이 호출만 시간 상한을 바꾼다 (회의 시작 때 미리 만드는 말처럼 긴 것)
  timeoutMs?: number;
  // 이 호출만 다시 보내기 횟수를 바꾼다 (늦은 판단을 다시 볼 땐 0 — 한 번에 끝내고 다음 수로)
  maxRetries?: number;
  // Claude API 웹 검색 도구(서버 도구)를 붙인다. maxUses = 이 요청 안에서 검색할 수 있는 횟수
  webSearch?: { maxUses: number };
}

// 웹 검색을 붙인 호출의 결과: 실제로 한 검색 수(비용), 출처(인용한 것 먼저, 없으면 결과 앞쪽), 검색 도구 오류 코드
export interface WebResult {
  searches: number;
  sources: { title: string; url: string }[];
  error?: string;
}
// 검색 한 번 $10/1000 (토큰 값과 따로)
export const WEB_SEARCH_COST = 0.01;
// 동적 거르기가 없는 기본판 — 거르기(20260209)는 코드 실행이 끼어 회의 중엔 느리다. Haiku·Sonnet 5.5 다 된다
export const WEB_SEARCH_TOOL = "web_search_20250305" as const;

// ── 장애 분류 ───────────────────────────────────────────────
export type FailKind = "no_key" | "auth" | "rate_limit" | "overloaded" | "timeout" | "network" | "bad_output" | "other";

export class NoKeyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NoKeyError";
  }
}

// 모델 호출 실패를 회의가 어떻게 버틸지 정할 수 있게 나눈다. retryAfterMs는 429일 때 서버가 알려 준 값.
export function classifyError(e: unknown): { kind: FailKind; retryAfterMs?: number } {
  if (e instanceof NoKeyError) return { kind: "no_key" };
  const err = e as { status?: number; name?: string; headers?: { get?: (k: string) => string | null } | Record<string, string> };
  const header = (k: string) => {
    const h = err?.headers;
    if (!h) return null;
    return typeof (h as { get?: unknown }).get === "function" ? (h as { get: (k: string) => string | null }).get(k) : ((h as Record<string, string>)[k] ?? null);
  };
  const status = err?.status;
  if (e instanceof Anthropic.APIConnectionTimeoutError || err?.name === "APIConnectionTimeoutError" || /timed? ?out/i.test(String((e as Error)?.message ?? ""))) return { kind: "timeout" };
  if (e instanceof Anthropic.APIConnectionError || err?.name === "APIConnectionError") return { kind: "network" };
  if (status === 401 || status === 403) return { kind: "auth" };
  if (status === 429) {
    const ra = Number(header("retry-after"));
    return { kind: "rate_limit", retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined };
  }
  if (status === 529 || status === 503 || (typeof status === "number" && status >= 500)) return { kind: "overloaded" };
  if (/구조화 출력|JSON|max_tokens/.test(String((e as Error)?.message ?? ""))) return { kind: "bad_output" };
  return { kind: "other" };
}

export interface CallStat {
  role: ModelRole;
  model: string;
  ms: number;
  firstTokenMs?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hedged?: boolean; // 늦어서 한 번 더 보냈음 (진 쪽 비용은 빠져 있음)
}

export interface CallResult<T> {
  text: string;
  out: T;
  stat: CallStat;
  web?: WebResult;
}

export type LlmFn = <T extends z.ZodType>(role: ModelRole, input: CallInput<T>) => Promise<CallResult<z.infer<T>>>;

// 글 속 첫 JSON 객체를 꺼낸다 (```json 울타리나 앞뒤 말이 붙어도)
export function parseJsonText<T extends z.ZodType>(text: string, schema: T): z.infer<T> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`JSON이 없음: ${text.slice(0, 80)}`);
  // 줄바꿈 같은 제어 문자는 JSON 문자열 안에서 깨진다 → 빈칸으로 (문자열 밖이면 원래 빈칸이라 그대로 같다)
  const raw = text.slice(start, end + 1).replace(/[\u0000-\u001f]+/g, " ");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — 받은 글: ${text.slice(0, 300)}`);
  }
  const r = schema.safeParse(parsed);
  if (!r.success) throw new Error(`JSON 모양이 다름: ${r.error.message.slice(0, 200)}`);
  return r.data;
}

// ── 회사별 연결부 ──────────────────────────────────────────
type Adapter = <T extends z.ZodType>(choice: ModelChoice, role: ModelRole, input: CallInput<T>) => Promise<CallResult<z.infer<T>>>;

let _anthropic: Anthropic | null = null;
const anthropicAdapter: Adapter = async (choice, role, input) => {
  if (!_anthropic) _anthropic = new Anthropic();
  const t0 = Date.now();
  let firstTokenMs: number | undefined;
  // 시스템 블록마다 캐시 지점 (최대 4개 가운데 3개까지): 고정 층(지시문·맥락) 뒤, 그리고 1분마다 바뀌는 요약 뒤.
  // 요약이 바뀌어도 고정 층까지는 캐시를 읽는다 (cost-design ③)
  const system = input.system.map((text, i) => ({
    type: "text" as const,
    text,
    ...(i >= input.system.length - 3 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const params = {
    model: choice.model,
    max_tokens: input.maxTokens ?? 1000,
    output_config: { ...(input.schema && input.strict ? { format: zodOutputFormat(input.schema) } : {}), ...(choice.effort ? { effort: choice.effort } : {}) },
    ...(choice.thinkingOff ? { thinking: { type: choice.thinkingOff } } : {}),
    system,
    messages: [{ role: "user" as const, content: input.user }],
    ...(input.webSearch ? { tools: [{ type: WEB_SEARCH_TOOL, name: "web_search" as const, max_uses: input.webSearch.maxUses }] } : {}),
  };
  type Stream = ReturnType<Anthropic["messages"]["stream"]>;
  type Final = Anthropic.Message & { parsed_output?: unknown };
  // 첫 토큰이 hedgeMs 안에 안 오면(API 지연 꼬리) 같은 요청을 하나 더 보내고 먼저 끝난 쪽을 쓴다. 진 쪽은 끊는다.
  const runs: Stream[] = [];
  let leader: Stream | null = null;
  let hedged = false;
  const msg = await new Promise<Final>((resolve, reject) => {
    let settled = false;
    let live = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const launch = () => {
      live++;
      const lim = ROLE_LIMITS[role];
      const st = _anthropic!.messages.stream(params, { timeout: input.timeoutMs ?? lim.timeoutMs, maxRetries: input.maxRetries ?? lim.maxRetries });
      runs.push(st);
      st.on("text", (_delta, snapshot) => {
        if (leader && leader !== st) return; // 먼저 말을 시작한 쪽만 따른다
        leader = st;
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - t0;
        input.onText?.(snapshot);
      });
      st.finalMessage().then(
        (m) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          for (const r of runs) if (r !== st) r.abort();
          resolve(m);
        },
        (e) => {
          live--;
          if (settled || live > 0) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    };
    if (choice.hedgeMs && !input.webSearch) // 웹 검색은 한 번 더 보내면 검색 값도 두 번 — 안 한다
      timer = setTimeout(() => {
        if (settled || firstTokenMs !== undefined) return;
        hedged = true;
        launch();
      }, choice.hedgeMs);
    launch();
  });
  const ms = Date.now() - t0;
  if (msg.stop_reason === "refusal") throw new Error(`${role}: 모델이 응답을 거부했습니다`);
  if (msg.stop_reason === "max_tokens" && !input.allowTruncated) throw new Error(`${role}: 출력이 max_tokens에 잘렸습니다`);
  // 웹 검색을 했으면 마지막 검색 결과 뒤의 글만 답이다 (앞의 "찾아볼게요" 같은 말은 버린다)
  const lastResult = msg.content.map((b) => b.type).lastIndexOf("web_search_tool_result");
  const text = msg.content
    .slice(lastResult + 1)
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const web = input.webSearch ? webResultOf(msg) : undefined;
  let out: unknown = text;
  if (input.schema) out = input.strict ? msg.parsed_output : parseJsonText(text, input.schema);
  if (out == null) throw new Error(`${role}: 구조화 출력 파싱 실패`);
  const u = {
    input: msg.usage.input_tokens,
    output: msg.usage.output_tokens,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
    cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
  };
  const cost = costOf(choice.model, u) + (web ? web.searches * WEB_SEARCH_COST : 0);
  return { text, out: out as z.infer<NonNullable<typeof input.schema>>, stat: { role, model: choice.model, ms, firstTokenMs, hedged, ...u, cost }, ...(web ? { web } : {}) };
};

export function webResultOf(msg: Pick<Anthropic.Message, "content" | "usage">): WebResult {
  const seen = new Map<string, string>();
  let error: string | undefined;
  for (const b of msg.content)
    if (b.type === "text") for (const c of b.citations ?? []) if (c.type === "web_search_result_location" && !seen.has(c.url)) seen.set(c.url, c.title ?? c.url);
  const results: { title: string; url: string }[] = [];
  for (const b of msg.content)
    if (b.type === "web_search_tool_result") {
      if (Array.isArray(b.content)) results.push(...b.content.map((r) => ({ title: r.title, url: r.url })));
      else error = b.content.error_code;
    }
  const cited = [...seen].map(([url, title]) => ({ title, url }));
  const rest = results.filter((r) => !seen.has(r.url));
  return { searches: msg.usage.server_tool_use?.web_search_requests ?? 0, sources: [...cited, ...rest].slice(0, 3), ...(error ? { error } : {}) };
}

// OpenAI 호환(Cerebras·Groq·로컬 MLX)·Google은 아직 빈 어댑터. 키를 넣고 models.ts를 바꾸면 여기를 채운다.
const notYet = (name: string): Adapter => async (choice) => {
  throw new Error(`${name} 연결부는 아직 없습니다 (${choice.model}). models.ts에서 anthropic 모델로 바꾸세요.`);
};

const ADAPTERS: Record<ModelChoice["provider"], Adapter> = {
  anthropic: anthropicAdapter,
  openai: notYet("OpenAI 호환"),
  google: notYet("Google"),
};

export function hasKey(choice: ModelChoice): boolean {
  return !!process.env[PROVIDER_ENV[choice.provider].key];
}

// 시험에서 가짜 모델로 갈아 끼울 수 있게 한 겹 둔다.
let override: LlmFn | null = null;
// 회의를 열 때 모델을 쓸 수 있는지 (가짜를 끼웠으면 늘 된다)
export function llmReady(): boolean {
  return !!override || hasKey(ROLE_MODELS.watch);
}

export function setLlm(fn: LlmFn | null) {
  override = fn;
}

// 바꿔 끼운 것 없이 실제 모델을 부른다 (캐시 같은 겹을 씌울 때 안쪽에서 쓴다)
export const direct: LlmFn = async (role, input) => {
  const choice = input.choice ?? ROLE_MODELS[role];
  if (!hasKey(choice)) throw new NoKeyError(`${PROVIDER_ENV[choice.provider].key}가 없어서 ${role} 역할(${choice.model})을 쓸 수 없습니다`);
  return ADAPTERS[choice.provider](choice, role, input);
};

export const call: LlmFn = async (role, input) => (override ? override(role, input) : direct(role, input));

// 대략적인 토큰 수 (로그용). 한글은 글자당 1토큰 남짓.
export function roughTokens(s: string): number {
  let n = 0;
  for (const ch of s) n += /[가-힣]/.test(ch) ? 1 : 0.3;
  return Math.round(n);
}
