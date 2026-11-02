// 모델 첫 토큰 지연 측정 (설정별 비교). npx tsx scripts/live-bench.ts
import "./env";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const client = new Anthropic();
const Out = z.object({ found: z.boolean(), said: z.string() });
const big = "회의 맥락 줄입니다. ".repeat(600);

async function once(label: string, params: Record<string, unknown>) {
  const t0 = Date.now();
  let first: number | undefined;
  const s = client.messages.stream({ max_tokens: 300, messages: [{ role: "user", content: "방금 발화: '봇으로 하죠'. 어긋남? 짧게." }], ...params } as Anthropic.MessageStreamParams);
  s.on("text", () => (first ??= Date.now() - t0));
  const m = await s.finalMessage();
  console.log(`${label.padEnd(40)} first ${first}ms total ${Date.now() - t0}ms out ${m.usage.output_tokens} cacheR ${m.usage.cache_read_input_tokens}`);
}

async function main() {
  const sys = [{ type: "text", text: big, cache_control: { type: "ephemeral" } }];
  for (let i = 0; i < 2; i++) {
    await once("haiku plain", { model: "claude-haiku-5-5", thinking: { type: "disabled" } });
    await once("haiku plain effort low", { model: "claude-haiku-5-5", thinking: { type: "disabled" }, output_config: { effort: "low" } });
    await once("haiku json", { model: "claude-haiku-5-5", thinking: { type: "disabled" }, output_config: { effort: "low", format: zodOutputFormat(Out) } });
    await once("haiku json + big cached sys", { model: "claude-haiku-5-5", system: sys, thinking: { type: "disabled" }, output_config: { effort: "low", format: zodOutputFormat(Out) } });
    await once("sonnet between_tools", { model: "claude-sonnet-5-5", thinking: { type: "between_tools" }, output_config: { effort: "low" } });
    await once("sonnet json + big sys", { model: "claude-sonnet-5-5", system: sys, thinking: { type: "between_tools" }, output_config: { effort: "low", format: zodOutputFormat(Out) } });
  }
}
main();
