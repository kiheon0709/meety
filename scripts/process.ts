// pending 세션을 순서대로 처리하고 결과를 출력한다. UI 없이 에이전트 품질을 보기 위한 CLI.
//   npx tsx scripts/process.ts            → 모든 스페이스의 pending 세션
//   npx tsx scripts/process.ts <spaceId>  → 해당 스페이스만
import "./env";
import { getCommits, getHead } from "../src/lib/head";
import { listSessions, listSpaces, processSession } from "../src/lib/service";
import { TYPE_LABEL, type Change } from "../src/lib/types";

const only = process.argv[2];

function describe(ch: Change): string {
  switch (ch.op) {
    case "add":
      return `  + [${TYPE_LABEL[ch.node.type]}/${ch.node.status}] ${ch.node.title}`;
    case "update":
      return `  ~ ${ch.node_id} ${JSON.stringify(ch.before)} → ${JSON.stringify(ch.after)}`;
    case "supersede":
      return `  ⇒ ${ch.node_id} → ${ch.new_node_id} [${TYPE_LABEL[ch.node.type]}] ${ch.node.title}`;
    case "withdraw":
      return `  ✕ ${ch.node_id} 철회: ${ch.reason}`;
  }
}

async function main() {
  let total = 0;
  for (const space of listSpaces()) {
    if (only && space.id !== only) continue;
    for (const s of listSessions(space.id)) {
      if (s.status === "done") continue;
      console.log(`\n=== ${space.name} / ${s.title} (${s.held_at}) ===`);
      const t0 = Date.now();
      const r = await processSession(s.id);
      total += r.usage.cost_usd;
      console.log(
        `커밋 ${r.commits}개 (확인 대기 ${r.pending}) · 변경 ${r.changes}개 · ${(r.usage.ms / 1000).toFixed(1)}s · in ${r.usage.input_tokens} / out ${r.usage.output_tokens} / cache r${r.usage.cache_read_input_tokens} w${r.usage.cache_creation_input_tokens} · $${r.usage.cost_usd}`,
      );
      if (r.skipped.length) console.log("버린 것:", r.skipped);
      for (const c of getCommits(space.id, s.id)) {
        console.log(`\n[${c.status}${c.needs_review ? " · 확인 필요: " + c.review_reason : ""}] ${c.message}`);
        for (const ch of c.changes) console.log(describe(ch));
      }
      void t0;
    }
    const head = getHead(space.id);
    console.log(`\nHEAD 노드 ${head.length}개 (유효 ${head.filter((n) => !["superseded", "withdrawn"].includes(n.status)).length})`);
  }
  console.log(`\n총 비용 $${total.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
