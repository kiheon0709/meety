// 발표 대본과 기획 문서의 어긋남 미리 보기 (자료 쪽 품질 확인용. 두뇌의 판단과는 별개).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { DocFact } from "@/lib/live/contract";
import { EXTRACT_MODEL, costUsd } from "./config";

export const VERDICTS = ["맞음", "어긋남", "관련 없음"] as const;
export type Verdict = (typeof VERDICTS)[number];

// 대본에서 말하는 줄만 꺼낸다. 코드 블록이 있으면 그 안만 본다.
// "[미티 기대] …" 같은 지문은 빼고, "기헌: " 같은 화자 표시는 뗀다.
export function parseScript(src: string): { speaker: string | null; text: string }[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const fenced: string[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced.push(l);
  }
  return (fenced.length ? fenced : lines)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[") && !l.startsWith("#") && !l.startsWith(">"))
    .map((l) => {
      const m = l.match(/^([^:：\s]{1,10})\s*[:：]\s*(.+)$/);
      return m ? { speaker: m[1], text: m[2].trim() } : { speaker: null, text: l };
    });
}

export interface DiffRow {
  text: string;
  verdict: Verdict;
  fact: DocFact | null;
  reason: string;
}

const JudgeOut = z.object({
  rows: z.array(
    z.object({
      n: z.number(),
      verdict: z.enum(VERDICTS),
      fact: z.string().nullable(), // 근거 사실 번호 (예: "2-1")
      reason: z.string(),
    }),
  ),
});

const SYSTEM = `발표 대본의 문장마다, 같이 주어진 기획 문서 사실 후보와 비교해 판정한다.
- 맞음: 후보 사실과 내용이 같다.
- 어긋남: 후보 사실과 숫자·단계 수·방식·범위가 다르다. 작은 차이라도 사실과 부딪치면 어긋남이다.
- 관련 없음: 인사·마무리·진행 멘트이거나, 후보 사실이 이 문장과 다른 이야기다.
fact에는 근거로 쓴 후보 번호(예: "3-2")를, 관련 없음이면 null을 쓴다. reason은 한국어 한 문장.`;

export async function judgeScript(
  sentences: string[],
  candidates: DocFact[][],
): Promise<{ rows: DiffRow[]; cost_usd: number; ms: number }> {
  const body = sentences
    .map((s, i) => {
      const c = candidates[i].map((f, j) => `  [${i + 1}-${j + 1}] ${f.text} (원문: "${f.quote}")`).join("\n");
      return `${i + 1}. ${s}\n${c || "  (후보 없음)"}`;
    })
    .join("\n\n");
  const t0 = Date.now();
  const res = await new Anthropic().messages.parse({
    model: EXTRACT_MODEL,
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(JudgeOut) },
    system: SYSTEM,
    messages: [{ role: "user", content: body }],
  });
  const ms = Date.now() - t0;
  if (!res.parsed_output) throw new Error("구조화 출력 파싱 실패");
  const byN = new Map(res.parsed_output.rows.map((r) => [r.n, r]));
  const rows = sentences.map((text, i): DiffRow => {
    const r = byN.get(i + 1);
    if (!r) return { text, verdict: "관련 없음", fact: null, reason: "(판정 없음)" };
    const j = r.fact ? Number(r.fact.split("-")[1]) - 1 : -1;
    return { text, verdict: r.verdict, fact: candidates[i][j] ?? null, reason: r.reason };
  });
  return { rows, cost_usd: costUsd(EXTRACT_MODEL, res.usage.input_tokens, res.usage.output_tokens), ms };
}
