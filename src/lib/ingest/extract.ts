// 조각에서 사실(DocFact) 뽑기. 모델 역할: extract (config.ts).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { EXTRACT_MODEL, costUsd } from "./config";
import type { Chunk } from "./read";
import { bigrams } from "./search";

export const FACT_KINDS = ["decision", "claim", "number", "plan"] as const;

export interface RawFact {
  chunk: number; // 조각 번호 (0부터)
  kind: (typeof FACT_KINDS)[number];
  text: string;
  quote: string;
  keys: string[]; // 사람이 이 내용을 다르게 말할 때 쓸 법한 표현 (검색용)
}
export interface ExtractUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ms: number;
  calls: number;
}
export type Extractor = (input: { title: string; chunks: Chunk[] }) => Promise<{ facts: RawFact[]; usage: ExtractUsage }>;

const FactsOut = z.object({
  facts: z.array(
    z.object({
      chunk: z.number(),
      kind: z.enum(FACT_KINDS),
      text: z.string(),
      quote: z.string(),
      keys: z.array(z.string()),
    }),
  ),
});

const SYSTEM = `너는 팀의 기획 문서를 읽고 "사실" 목록을 만든다. 이 목록은 회의나 발표 중에 누가 문서와 다른 말을 하면 "문서에는 이렇게 돼 있어요"라고 짚는 근거로 쓰인다.

## 사실 하나
- text: 한국어 한 문장, "~다"체. 문서를 안 본 사람도 알아듣게 주어를 넣고 대명사를 쓰지 마라. 예: "끼어들기 강도는 상·중·하 세 단계다."
- quote: 그 사실의 근거가 되는 원문 부분을 **글자 하나 바꾸지 말고 그대로** 복사한다. 한 문장이나 목록 한 줄 정도. 요약·번역·띄어쓰기 수정 금지. 앞의 "- " 같은 목록 기호는 빼도 된다.
- kind:
  - decision: 팀이 정한 것. 제품이 이렇게 동작한다는 규칙·원칙, 대상 사용자(타깃), 하지 않기로 한 것, 결정 로그의 항목 ("강도를 낮추는 건 말로 바로 된다", "대상은 서기도 PM도 없는 작은 팀이다")
  - number: 글로 쓴 숫자·날짜·단계 수·수량이 핵심인 것 ("대회 제출은 11월 2일이다", "중 강도는 0.8초 이상 끊기면 말한다"). 숫자가 없으면 number가 아니다 ("상은 말이 끝나자마자 말한다"는 decision).
  - plan: 앞으로 할 일·일정·검증 계획, 그리고 **아직 정하지 않은 것**. 아직 안 정한 것은 text에 "아직 정하지 않았다"를 꼭 넣는다 ("미티 목소리는 아직 정하지 않았다. 후보를 들어보고 고른다.")
  - claim: 의견·문제 인식·가정·평가·남과 비교한 주장 ("ChatGPT는 우리 팀이 뭘 정했는지 모른다")
- keys: 회의 중에 사람이 이 내용을 **묻거나, 다른 말로 하거나, 반대로** 말할 때 쓸 법한 짧은 표현 4~6개. 원문에 없는 낱말 위주로, 줄임말·영어 표기·흔한 말을 섞는다. 예: "로컬 모드에선 음성이 기기 밖으로 나가지 않는다" → ["외부 서버로 보낸다", "클라우드 처리", "온디바이스", "데이터가 밖으로 나가나", "개인정보"]
- chunk: 근거가 있는 조각 번호.

## 규칙
1. 확인 가능한 내용 하나에 사실 하나. 목록 항목은 항목마다 따로 뽑는다. 한 문장에 두 내용이 있으면 둘로 나눈다.
2. 숫자, 단계 수, 이름, "하지 않는 것"(예: "회의 중에 끼어들지 않는다")은 꼭 뽑는다. 누가 말로 틀리기 쉬운 것이 제일 중요하다.
3. 목차, 인사, 문서 형식 안내, 그림 설명, 머리말·꼬리말(쪽 번호)은 뽑지 마라.
4. 문서에 없는 내용을 지어내지 마라.
5. 같은 내용이 문서 여러 곳(본문과 결정 로그 표 등)에 나오면 **한 번만** 뽑는다. 날짜가 붙은 쪽이 있으면 그 날짜를 text에 넣고 그쪽을 근거(chunk·quote)로 쓴다. 예: "10/28에 Jetson AGX 박스는 쓰지 않기로 했다."
6. 번복된 결정은 지금 결정을 text로 쓰고, 옛 결정이 번복됐다는 것도 text에 남긴다.`;

let _client: Anthropic | null = null;
function client() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export const modelExtractor: Extractor = async ({ title, chunks }) => {
  const body = chunks.map((c, i) => `<chunk n="${i}" loc="${c.loc}">\n${c.text}\n</chunk>`).join("\n\n");
  const t0 = Date.now();
  const res = await client().messages.parse({
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    output_config: { format: zodOutputFormat(FactsOut) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `문서 제목: ${title}\n\n${body}\n\n위 조각들에서 사실을 뽑아라.` }],
  });
  const ms = Date.now() - t0;
  if (res.stop_reason === "refusal") throw new Error("모델이 응답을 거부했습니다");
  if (res.stop_reason === "max_tokens") throw new Error("출력이 max_tokens에 잘렸습니다");
  if (!res.parsed_output) throw new Error("구조화 출력 파싱 실패");
  const input = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
  return {
    facts: res.parsed_output.facts,
    usage: { model: EXTRACT_MODEL, input_tokens: input, output_tokens: res.usage.output_tokens, cost_usd: costUsd(EXTRACT_MODEL, input, res.usage.output_tokens), ms, calls: 1 },
  };
};

// 조각을 한 번 부를 만큼씩 묶는다 (호출 수 줄이기). 위치는 조각마다 그대로 남는다.
// 너무 크게 묶으면 haiku가 뒤쪽 절을 통째로 빼먹는다 (8000자일 때 "아직 안 정한 것" 절이 빠짐).
const BATCH_CHARS = 3000;
export function batches(chunks: Chunk[]): Chunk[][] {
  const out: Chunk[][] = [];
  let cur: Chunk[] = [];
  let len = 0;
  for (const c of chunks) {
    if (cur.length && len + c.text.length > BATCH_CHARS) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(c);
    len += c.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface CheckedFact {
  kind: RawFact["kind"];
  text: string;
  loc: string;
  quote: string;
  keys: string[];
}

// 모든 묶음을 돌려 사실을 모으고, quote가 원문 그대로인지 확인한다.
export async function extractFacts(
  title: string,
  chunks: Chunk[],
  extractor: Extractor = modelExtractor,
): Promise<{ facts: CheckedFact[]; usage: ExtractUsage; quoteFixed: number; dropped: number; retried: number }> {
  const groups = batches(chunks);
  // 한 묶음의 모델 출력이 형식에 안 맞아 던지면(가끔) 그 묶음만 한 번 더 — 문서 전체가 실패하지 않게
  const ask = (g: Chunk[]) => extractor({ title, chunks: g }).catch(() => extractor({ title, chunks: g }));
  const results = await mapLimit(groups, 4, ask);
  // 빼먹은 조각(사실 0개)은 그 조각만 따로 한 번 더 묻는다
  const missed = groups.flatMap((g, gi) => g.filter((c, ci) => c.text.length > 40 && !results[gi].facts.some((f) => f.chunk === ci)));
  if (missed.length) {
    const retry = batches(missed);
    groups.push(...retry);
    results.push(...(await mapLimit(retry, 4, ask)));
  }
  const facts: CheckedFact[] = [];
  let quoteFixed = 0;
  let dropped = 0;
  const usage: ExtractUsage = { model: "", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 0 };
  results.forEach((r, gi) => {
    usage.model = r.usage.model;
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
    usage.cost_usd += r.usage.cost_usd;
    usage.ms = Math.max(usage.ms, r.usage.ms); // 병렬이라 가장 긴 호출
    usage.calls += r.usage.calls;
    for (const f of r.facts) {
      const chunk = groups[gi][f.chunk];
      const text = f.text.trim();
      if (!chunk || !text) {
        dropped++;
        continue;
      }
      const q = verbatimQuote(f.quote, chunk.text);
      if (!q) {
        dropped++;
        continue;
      }
      if (q.fixed) quoteFixed++;
      const keys = (f.keys ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8);
      facts.push({ kind: f.kind, text, loc: chunk.loc, quote: q.quote, keys });
    }
  });
  usage.cost_usd = Math.round(usage.cost_usd * 1_000_000) / 1_000_000;
  return { facts: dedupe(facts), usage, quoteFixed, dropped, retried: missed.length };
}

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

// quote가 원문에 (공백 차이만 빼고) 그대로 있으면 원문 공백을 하나로 줄인 형태로 돌려준다.
// 없으면 원문에서 가장 비슷한 줄로 바꾼다. 비슷한 줄도 없으면 null (사실을 버린다).
export function verbatimQuote(quote: string, source: string): { quote: string; fixed: boolean } | null {
  const q = norm(quote).replace(/^[-*•]\s+/, "");
  const src = norm(source);
  if (q && src.includes(q)) return { quote: q, fixed: false };
  const qg = new Set(bigrams(q));
  if (!qg.size) return null;
  let best = "";
  let bestScore = 0;
  for (const line of source.split("\n")) {
    const l = norm(line).replace(/^[-*•#]+\s*/, "");
    if (!l) continue;
    const lg = new Set(bigrams(l));
    let hit = 0;
    for (const g of qg) if (lg.has(g)) hit++;
    const score = hit / qg.size;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return bestScore >= 0.5 ? { quote: best, fixed: true } : null;
}

function dedupe(facts: CheckedFact[]): CheckedFact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const k = norm(f.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
