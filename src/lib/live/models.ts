// 역할 → (회사, 모델) 매핑. 모델을 바꾸려면 이 표의 한 줄만 고친다.
import type { ModelRole } from "./contract";

export type Provider = "anthropic" | "openai" | "google";

export interface ModelChoice {
  provider: Provider;
  model: string;
  // 회의 중엔 빨라야 해서 생각(thinking)을 끈다. 끄는 방법이 모델마다 다르다:
  // Haiku 5.5는 "disabled", Sonnet 5.5는 "disabled"를 받지 않아 "between_tools".
  thinkingOff?: "disabled" | "between_tools";
  effort?: "low" | "medium" | "high";
  // 첫 토큰이 이 시간(ms) 안에 안 오면 같은 요청을 하나 더 보낸다 (지연 꼬리 자르기)
  hedgeMs?: number;
}

const HAIKU: ModelChoice = { provider: "anthropic", model: "claude-haiku-5-5", thinkingOff: "disabled", effort: "low", hedgeMs: 1300 };
const SONNET: ModelChoice = { provider: "anthropic", model: "claude-sonnet-5-5", thinkingOff: "between_tools", effort: "low", hedgeMs: 1800 };

export const ROLE_MODELS: Record<ModelRole, ModelChoice> = {
  watch: HAIKU,
  speak: SONNET,
  verify: SONNET,
  summarize: HAIKU,
  extract: HAIKU,
};

// 회의 중엔 오래 기다릴 수 없다: 역할별 한 번 부를 때 시간 상한과 SDK 자체 재시도 횟수.
// (SDK 기본은 10분·2회라, 그대로 두면 장애 때 회의가 멈춘 것처럼 보인다)
export const ROLE_LIMITS: Record<ModelRole, { timeoutMs: number; maxRetries: number }> = {
  watch: { timeoutMs: 8_000, maxRetries: 1 },
  speak: { timeoutMs: 20_000, maxRetries: 1 },
  verify: { timeoutMs: 10_000, maxRetries: 1 },
  summarize: { timeoutMs: 20_000, maxRetries: 1 },
  extract: { timeoutMs: 60_000, maxRetries: 2 },
};

// 회사별 키 환경변수. 키가 없으면 그 회사 모델은 쓰지 않는다.
// openai: OpenAI 호환 서버(Cerebras·Groq·로컬 MLX 서버)도 같은 형식이라 BASE_URL만 바꿔 쓴다.
export const PROVIDER_ENV: Record<Provider, { key: string; baseUrl?: string }> = {
  anthropic: { key: "ANTHROPIC_API_KEY" },
  openai: { key: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  google: { key: "GOOGLE_API_KEY" },
};

// $/MTok. src/lib/agent.ts PRICES와 같은 값 (거기는 내보내지 않아서 여기 둔다). 캐시 쓰기는 입력의 1.25배.
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, // 캐시 읽기는 입력의 0.05배 (Opus·Sonnet 5.5)
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function costOf(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
}

// 부름·1:1 대답 모델 (기본은 역할 표의 speak = Sonnet). LIVE_ANSWER_MODEL=haiku면 Haiku — 첫 소리 빠르기 실험
export const ANSWER_MODEL: ModelChoice | undefined = process.env.LIVE_ANSWER_MODEL === "haiku" ? HAIKU : undefined;
