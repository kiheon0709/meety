// 에이전트 품질 평가. 임시 스페이스를 만들어 녹취를 순서대로 처리하고 채점한 뒤 지운다.
//   npx tsx scripts/eval.ts            → 모든 케이스
//   npx tsx scripts/eval.ts clean long → 일부만
//   --keep 을 주면 스페이스를 지우지 않는다 (화면에서 보려고)
// **dev 서버는 끄고 돌릴 것** (WAL 고아 방지).
import "./env";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";
import { getHead } from "../src/lib/head";
import { addMember, createSession, createSpace, processSession } from "../src/lib/service";
import type { HeadNode } from "../src/lib/types";

type Case = { files: string[]; min_chains?: number; max_dups?: number; max_pending_per_meeting?: number; min_resolved_questions?: number; min_decisions?: number };
const expect = JSON.parse(fs.readFileSync(path.join(process.cwd(), "eval", "expect.json"), "utf8")) as { cases: Record<string, Case> };
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const keep = process.argv.includes("--keep");
const names = args.length ? args : Object.keys(expect.cases);

function parseFile(file: string) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`front matter 없음: ${file}`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const [k, ...rest] = line.split(":");
    meta[k.trim()] = rest.join(":").trim();
  }
  return { title: meta.title, held_at: meta.held_at, body: m[2], utts: m[2].split("\n").filter((l) => l.trim()).length };
}

// 글자 2-gram 자카드. 제목이 거의 같은 유효 항목 쌍 = 중복.
function sim(a: string, b: string) {
  const g = (s: string) => {
    const t = s.replace(/\s/g, "");
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = g(a), B = g(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}
function dups(head: HeadNode[]) {
  const live = head.filter((n) => !["superseded", "withdrawn", "rejected"].includes(n.status));
  const out: string[] = [];
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.type === b.type && sim(a.title, b.title) >= 0.75) out.push(`${a.id} "${a.title}" ≈ ${b.id} "${b.title}"`);
    }
  return out;
}

function cleanup(spaceId: string) {
  const db = getDb();
  db.exec(`
    DELETE FROM notifications WHERE space_id='${spaceId}';
    DELETE FROM events WHERE space_id='${spaceId}';
    DELETE FROM briefings WHERE space_id='${spaceId}';
    DELETE FROM nodes WHERE space_id='${spaceId}';
    DELETE FROM approvals WHERE commit_id IN (SELECT id FROM commits WHERE space_id='${spaceId}');
    DELETE FROM comments WHERE space_id='${spaceId}';
    DELETE FROM commits WHERE space_id='${spaceId}';
    DELETE FROM sources WHERE space_id='${spaceId}' OR session_id IN (SELECT id FROM sessions WHERE space_id='${spaceId}');
    DELETE FROM docs WHERE space_id='${spaceId}';
    DELETE FROM sessions WHERE space_id='${spaceId}';
    DELETE FROM invites WHERE space_id='${spaceId}';
    DELETE FROM members WHERE space_id='${spaceId}';
    DELETE FROM spaces WHERE id='${spaceId}';`);
}

interface Row { name: string; meetings: number; utts: number; chunks: number; commits: number; pending: number; chains: number; decisions: number; resolvedQ: number; dups: string[]; dropped: number; cost: number; sec: number; pass: boolean; why: string[] }

async function runCase(name: string, c: Case): Promise<Row> {
  const sp = createSpace(`eval · ${name}`);
  for (const n of ["기헌", "준영", "태은", "지호"]) addMember(sp.id, n);
  const row: Row = { name, meetings: c.files.length, utts: 0, chunks: 0, commits: 0, pending: 0, chains: 0, decisions: 0, resolvedQ: 0, dups: [], dropped: 0, cost: 0, sec: 0, pass: true, why: [] };
  const t0 = Date.now();
  try {
    let maxPendingOne = 0;
    for (const f of c.files) {
      const { title, held_at, body, utts } = parseFile(path.join(process.cwd(), f));
      row.utts += utts;
      row.chunks += Math.ceil(utts / 150);
      const s = createSession(sp.id, title, held_at, body);
      const r = await processSession(s.id);
      row.commits += r.commits;
      row.pending += r.pending;
      maxPendingOne = Math.max(maxPendingOne, r.pending);
      row.dropped += r.skipped.filter((x) => x.startsWith("검수에서 버림")).length;
      row.cost += r.usage.cost_usd;
      console.log(`  ${name} / ${title}: 업데이트 ${r.commits} (물어봄 ${r.pending}) · $${r.usage.cost_usd} · ${(r.usage.ms / 1000).toFixed(0)}s`);
    }
    const head = getHead(sp.id);
    row.chains = head.filter((n) => n.type === "decision" && n.status === "superseded" && n.superseded_by).length;
    row.decisions = head.filter((n) => n.type === "decision" && !["superseded", "withdrawn"].includes(n.status)).length;
    row.resolvedQ = head.filter((n) => n.type === "question" && n.status === "resolved").length;
    row.dups = dups(head);
    if (c.min_chains !== undefined && row.chains < c.min_chains) row.why.push(`바뀐 길 ${row.chains} < ${c.min_chains}`);
    if (c.min_decisions !== undefined && row.decisions < c.min_decisions) row.why.push(`결정 ${row.decisions} < ${c.min_decisions}`);
    if (c.max_dups !== undefined && row.dups.length > c.max_dups) row.why.push(`중복 ${row.dups.length}`);
    if (c.max_pending_per_meeting !== undefined && maxPendingOne > c.max_pending_per_meeting) row.why.push(`회의당 물어봄 최대 ${maxPendingOne} > ${c.max_pending_per_meeting}`);
    if (c.min_resolved_questions !== undefined && row.resolvedQ < c.min_resolved_questions) row.why.push(`해결된 안건 ${row.resolvedQ} < ${c.min_resolved_questions}`);
    row.pass = row.why.length === 0;
    console.log(`  → 결정 ${row.decisions} · 바뀐 길 ${row.chains} · 해결 안건 ${row.resolvedQ} · 중복 ${row.dups.length} · $${row.cost.toFixed(3)}`);
    for (const d of row.dups) console.log(`    중복: ${d}`);
    if (keep) console.log(`  (스페이스 유지: ${sp.id})`);
  } catch (e) {
    row.pass = false;
    row.why.push(`오류: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    row.sec = Math.round((Date.now() - t0) / 1000);
    if (!keep) cleanup(sp.id);
  }
  return row;
}

async function main() {
  const rows: Row[] = [];
  for (const n of names) {
    console.log(`\n=== ${n} ===`);
    rows.push(await runCase(n, expect.cases[n]));
  }
  const md = [
    `| 케이스 | 회의 | 마디 | 조각 | 업데이트 | 물어봄 | 유효 결정 | 바뀐 길 | 해결 안건 | 중복 | 검수 버림 | 비용 | 시간 | 결과 |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.name} | ${r.meetings} | ${r.utts} | ${r.chunks} | ${r.commits} | ${r.pending} | ${r.decisions} | ${r.chains} | ${r.resolvedQ} | ${r.dups.length} | ${r.dropped} | $${r.cost.toFixed(2)} | ${r.sec}s | ${r.pass ? "통과" : "실패: " + r.why.join(", ")} |`),
  ].join("\n");
  console.log("\n" + md);
  const out = path.join(process.cwd(), "eval", `results-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(out, `# 평가 결과 ${new Date().toLocaleString("ko-KR")}\n\n${md}\n\n총 비용 $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)}\n`);
  console.log(`\n저장: ${out} · 총 비용 $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
