// 모델 시나리오 채점 (같은 프로세스에서 두뇌를 직접 부른다 — Next 서버가 필요 없다).
//   LIVE_LLM=1 npx tsx scripts/live-eval.ts                  기본 묶음(A·B·변형 3·결정 바꾸기·실제 근거·오탐 2·부름) 각 3회
//   LIVE_LLM=1 npx tsx scripts/live-eval.ts --only A,P --repeat 1
//   LIVE_LLM=1 npx tsx scripts/live-eval.ts --only M        멘토링 71분 (긴 실제 대화, 빠르게)
//   LIVE_LLM=1 npx tsx scripts/live-eval.ts --only RF,RS    실제 녹음 받아쓰기 71분(빠르게) · 오탐 났던 구간(실제 시각대로)
//   LIVE_CACHE=1 …                                           같은 입력이면 모델을 다시 안 부름 (지연 숫자는 의미 없음)
// DB는 data/ctxgit.db를 tests/.tmp/live-eval.db로 복사해서 쓴다(원본엔 안 씀). 결과는 tests/live/results/eval-<시각>.md
import "./env";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (process.env.LIVE_LLM !== "1") {
  console.error("모델을 부르는 채점이라 LIVE_LLM=1일 때만 돌아요.");
  process.exit(1);
}
const ROOT = process.cwd();
const dbCopy = process.env.LIVE_EVAL_DB ?? path.join(ROOT, "tests", ".tmp", "live-eval.db"); // 동시에 두 채점을 돌리면 서로 다른 파일로
fs.mkdirSync(path.dirname(dbCopy), { recursive: true });
for (const f of [dbCopy, `${dbCopy}-wal`, `${dbCopy}-shm`]) fs.rmSync(f, { force: true });
fs.copyFileSync(path.join(ROOT, "data", "ctxgit.db"), dbCopy);
process.env.GALPI_DB_PATH = dbCopy;
process.env.LIVE_AUTO_PROCESS = "0";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const SETS: Record<string, string> = {
  A: "docs/agent/scenarios/A-meeting.md",
  B: "docs/agent/scenarios/B-presentation.md",
  OG1: "tests/live/scenarios/OG1-owner-gap.md",
  OG2: "tests/live/scenarios/OG2-owner-named.md",
  RC1: "tests/live/scenarios/RC1-research.md",
  RC2: "tests/live/scenarios/RC2-research-answered.md",
  FB1: "tests/live/scenarios/FB1-feedback.md",
  FB2: "tests/live/scenarios/FB2-feedback-objected.md",
  SC1: "tests/live/scenarios/SC1-structure.md",
  SC2: "tests/live/scenarios/SC2-structure-resolved.md",
  QM1: "tests/live/scenarios/QM1-quiet-member.md",
  QM2: "tests/live/scenarios/QM2-everyone-talks.md",
  SG1: "tests/live/scenarios/SG1-suggest.md",
  SG2: "tests/live/scenarios/SG2-suggest-given.md",
  N1: "tests/live/scenarios/A-noisy-1.md",
  N2: "tests/live/scenarios/A-noisy-2.md",
  N3: "tests/live/scenarios/A-noisy-3.md",
  L: "tests/live/scenarios/A-live-stt.md",
  C: "tests/live/scenarios/C-change.md",
  P: "tests/live/scenarios/P-plan.md",
  P2: "tests/live/scenarios/P2-plan-gear.md",
  P3: "tests/live/scenarios/P3-plan-meety.md",
  Q2: "tests/live/scenarios/Q2-plan-ask.md",
  F1: "tests/live/scenarios/F1-agree.md",
  F2: "tests/live/scenarios/F2-debate.md",
  Q: "tests/live/scenarios/Q-ask.md",
  D2: "tests/live/scenarios/D2-backchannel.md",
  S1: "tests/live/scenarios/S1-solo-ask.md",
  S2: "tests/live/scenarios/S2-solo-mixed.md",
  S3: "tests/live/scenarios/S3-solo-calls.md",
  AG1: "tests/live/scenarios/AG1-solo-planning.md",
  AG2: "tests/live/scenarios/AG2-brainstorm.md",
  AG3: "tests/live/scenarios/AG3-presentation-quiet.md",
  M: "docs/mentoring/2026-10-29-멘토링-전사.md",
  M2: "docs/mentoring/2026-10-29-멘토링-전사.md",
  R: "tests/live/fixtures/mentoring-stt-15min.json",
  RF: "tests/live/fixtures/mentoring-stt-full.json",
  RS: "tests/live/fixtures/mentoring-stt-full.json",
  AV: "tests/live/fixtures/A-meeting-voice.events.jsonl",
  WV: "tests/live/fixtures/wake-voice.events.jsonl",
};
const DEFAULT = ["A", "B", "N1", "N2", "N3", "L", "C", "P", "P2", "P3", "F1", "F2", "Q", "Q2", "D2"];
// 팀원 역할 대본 (역할마다 꺼낼 때 1 + 참을 때 1, brain-design §5-1)
const ROLE_SETS = ["OG1", "OG2", "RC1", "RC2", "FB1", "FB2", "SC1", "SC2", "QM1", "QM2", "SG1", "SG2", "S1", "S2", "S3"];

const isLong = (n: string) => n.startsWith("M") || n === "R" || n === "RF" || n === "RS";

async function main() {
  const { parseScenario, parseLongTranscript } = await import("../src/lib/live/scenario");
  const meeting = await import("../src/lib/live/meeting");
  const llm = await import("../src/lib/live/llm");
  const docs = await import("../src/lib/live/docs");
  const { getDb } = await import("../src/lib/db");
  const lib = await import("./live-lib");
  const { ROLE_MODELS } = await import("../src/lib/live/models");

  // watch 모델 바꿔 보기 (P1 실험): --watch haiku | haiku-think | sonnet
  const WATCH_VARIANTS: Record<string, typeof ROLE_MODELS.watch> = {
    haiku: ROLE_MODELS.watch,
    "haiku-think": { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", hedgeMs: 1300 },
    sonnet: { provider: "anthropic", model: "claude-sonnet-5-5", thinkingOff: "between_tools", effort: "low", hedgeMs: 1800 },
  };
  const watchVariant = opt("watch", "haiku");
  if (!WATCH_VARIANTS[watchVariant]) throw new Error(`모르는 --watch: ${watchVariant}`);
  ROLE_MODELS.watch = WATCH_VARIANTS[watchVariant];

  const only = opt("only", "").split(",").filter(Boolean);
  const allRoles = args.includes("--all-roles");
  const dial = opt("participation", "") === "" ? undefined : Number(opt("participation", ""));
  const { ROLE_KINDS } = await import("../src/lib/live/roles");
  const names = only.length ? only.flatMap((n) => (n === "roles" ? ROLE_SETS : [n])) : [...DEFAULT, ...ROLE_SETS];
  const repeat = Number(opt("repeat", names.some(isLong) ? "1" : "3"));
  // --partials: partial 선판단을 켜고 실제 시각 재생(RS 등)에 받아쓰기 중간 결과를 흘린다 (다이얼 7 이상에서만 쓰임)
  const partials = args.includes("--partials");
  const soloRun = args.includes("--solo"); // 참석자를 첫 사람 하나로 — 1:1로 돌려 보기
  if (partials) meeting.TIMING.partialEnabled = true;
  const soniox = args.includes("--soniox");
  const runOpts = { soniox, speed: Number(opt("speed", "2")), patience: Number(opt("patience", "4000")), pauseMs: Number(opt("pause", "1200")), loose: dial !== undefined, partials };

  // 같은 입력이면 다시 안 부르는 캐시 (LIVE_CACHE=1)
  if (process.env.LIVE_CACHE === "1") {
    const dir = path.join(ROOT, "tests", ".tmp", "live-cache");
    fs.mkdirSync(dir, { recursive: true });
    llm.setLlm((async (role, input) => {
      const key = crypto.createHash("sha256").update(JSON.stringify([role, ROLE_MODELS[role].model, input.system, input.user, !!input.strict])).digest("hex").slice(0, 32);
      const file = path.join(dir, `${key}.json`);
      if (fs.existsSync(file)) {
        const hit = JSON.parse(fs.readFileSync(file, "utf8"));
        input.onText?.(hit.text);
        const out = input.schema ? (input.strict ? hit.out : input.schema.parse(JSON.parse(hit.text.slice(hit.text.indexOf("{"), hit.text.lastIndexOf("}") + 1)))) : hit.text;
        return { text: hit.text, out, stat: { ...hit.stat, ms: 0, firstTokenMs: 0, cost: 0 } };
      }
      const r = await llm.direct(role, input);
      fs.writeFileSync(file, JSON.stringify({ text: r.text, out: input.strict ? r.out : undefined, stat: r.stat }));
      return r;
    }) as typeof llm.call);
  }

  const space = getDb().prepare(`SELECT id FROM spaces WHERE is_demo = 1 AND name LIKE '%5조%' ORDER BY created_at LIMIT 1`).get() as { id: string } | undefined;
  if (!space) throw new Error("예시 스페이스가 없어요 (npm run seed && npm run process)");
  const myDocs = docs.docsForSpace(space.id);

  // 같은 프로세스 드라이버
  const inProcess = (): import("./live-lib").Driver => {
    let m: import("../src/lib/live/meeting").Meeting;
    const events: import("./live-lib").Got[] = [];
    let unsub = () => {};
    return {
      events,
      async start(sc, docIds) {
        // 역할: 대본에 "- roles:"가 있으면 그것만, 없으면(어긋남 대본) 어긋남만 — --all-roles면 두뇌 기본값(반드시 넷)
        const roles = allRoles ? undefined : Object.fromEntries(ROLE_KINDS.map((k) => [k, (sc.roles ?? ["conflict"]).includes(k)]));
        // --participation N: 대본의 강도 대신 참여도 다이얼로 (판단 리듬·채널을 바꿔 채점)
        m = meeting.startMeeting({ spaceId: space.id, title: sc.title, agenda: sc.agenda, intensity: sc.intensity, participants: soloRun ? sc.participants.slice(0, 1) : sc.participants, docIds, ...(roles ? { roles } : {}), ...(sc.budget !== undefined ? { budget: { voicePer10Min: sc.budget } } : {}), ...(sc.mode ? { mode: sc.mode } : {}), ...(dial !== undefined ? { participation: dial } : {}) });
        unsub = meeting.subscribe(m, (ev) => events.push({ at: Date.now(), ev }));
      },
      templatesReady: () => m.templatesReady,
      async utter(u) {
        meeting.onUtterance(m, u);
      },
      async gap(afterId, ms) {
        meeting.onGap(m, afterId, ms);
      },
      async partial(id, text, stable) {
        meeting.onPreAnswer(m, id, text, stable);
        void meeting.onPartial(m, id, text, stable).catch(() => {});
      },
      async speech() {
        meeting.onSpeechStart(m);
      },
      end: () => meeting.endMeeting(m),
      async snapshot() {
        return meeting.snapshot(m) as unknown as import("./live-lib").Snap;
      },
      close: () => unsub(),
    };
  };

  const out: string[] = [];
  const summary: string[] = [];
  const stageRows: import("./live-lib").StageRow[] = [];
  const allSnaps: import("./live-lib").Snap[] = [];
  const roleRuns: { results: import("./live-lib").RunResult[]; lines: number }[] = [];
  const answerRows: string[] = [];
  const planRows: { name: string; run: number; judged: number; said: number; perMin: number }[] = [];
  const voiceRows: ({ name: string; run: number; partials: boolean } & import("./live-lib").VoiceTiming)[] = [];
  let total = 0;
  const started = Date.now();

  // M2: 멘토링 전사를 두 번 이어 붙여 2시간 상당
  const load = (name: string) => {
    const file = SETS[name];
    if (!file) throw new Error(`모르는 묶음: ${name}`);
    const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
    // R: 실제 녹화 받아쓰기 원문(화자 없음) 그대로 — 미티가 조용해야 정답
    if (name === "R") {
      const finals = (JSON.parse(raw) as { finals: { text: string; speaker?: string }[] }).finals.filter((u) => u.text.trim());
      const sc = { title: "실제 녹화 받아쓰기 15분", participants: ["멘토", "홍기헌", "엄태은", "김지호"], intensity: "high" as const, agenda: [], wantsDocs: false, docHints: [], lines: finals.map((u) => ({ speaker: u.speaker ?? "?", text: u.text, expects: [] })) };
      return { file, sc, docIds: [] as string[], opts: { ...runOpts, fast: true } };
    }
    // RF: S7 실제 녹음 E2E(70.7분)의 final 전부, 그 실행과 같게 강도 중·기획 문서 · RS: 그중 오탐이 났던 980~1180초를 실제 시각대로
    // AV: 시나리오 A 녹음(A-meeting.wav)을 S2 음성 서버(partial.stable 있음)에 실제로 흘린 이벤트 그대로 — S2 voice/recordings/stable/
    // WV: 부름 녹음(wake.wav, "미티야 지난주에 뭐 정했었지?" 등)을 S2 음성 서버에 흘린 이벤트 그대로 — 부름 → 첫 소리 재기
    if (name === "WV") {
      const voice = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as import("./live-lib").VoiceEv);
      const finals = voice.filter((e): e is Extract<import("./live-lib").VoiceEv, { type: "final" }> => e.type === "final" && "t1" in e);
      const sc = { title: "부름 실제 음성 (음성 서버 이벤트 재생)", participants: ["기헌", "태은", "준영", "지호"], intensity: "mid" as const, agenda: [], wantsDocs: true, docHints: [], lines: finals.map((f) => ({ speaker: "?", text: f.text, expects: [] })) };
      const docIds = myDocs.filter((d) => d.id.startsWith("current-plan")).map((d) => d.id);
      return { file, sc, docIds, opts: { ...runOpts, voice } };
    }
    if (name === "AV") {
      const voice = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as import("./live-lib").VoiceEv);
      const a = parseScenario(fs.readFileSync(path.join(ROOT, SETS.A), "utf8"));
      const finals = voice.filter((e): e is Extract<import("./live-lib").VoiceEv, { type: "final" }> => e.type === "final" && "t1" in e);
      const sc = { ...a, title: "시나리오 A 실제 음성 (음성 서버 이벤트 재생)", lines: finals.map((f) => ({ speaker: "?", text: f.text, expects: [] })) };
      const docIds = a.docHints.flatMap((h) => myDocs.filter((d) => d.path.includes(h) || d.id.includes(h)).map((d) => d.id));
      return { file, sc, docIds, opts: { ...runOpts, voice } };
    }
    if (name === "RF" || name === "RS") {
      const all = (JSON.parse(raw) as { finals: { t0: number; t1: number; text: string }[] }).finals;
      const finals = name === "RS" ? all.filter((u) => u.t0 >= 980 && u.t0 < 1180) : all;
      const lines = finals.map((u) => ({ speaker: "?", text: u.text, expects: [], t0: u.t0, t1: u.t1 }));
      const sc = { title: name === "RF" ? "실제 녹음 받아쓰기 71분" : "실제 녹음 받아쓰기 980~1180초", participants: ["기헌", "준영", "태은", "지호"], intensity: "mid" as const, agenda: [], wantsDocs: true, docHints: [], lines };
      const docIds = myDocs.filter((d) => d.id.startsWith("current-plan")).map((d) => d.id);
      return { file, sc, docIds, opts: name === "RF" ? { ...runOpts, fast: true } : { ...runOpts, real: true } };
    }
    const sc = name === "M" || name === "M2" ? parseLongTranscript(name === "M2" ? `${raw}\n${raw}` : raw, { limit: Number(opt("limit", "0")) }) : parseScenario(raw);
    if (name === "M2") sc.title = "긴 실제 회의 (멘토링 ×2, 약 2시간)";
    const docIds = sc.docHints.flatMap((h) => myDocs.filter((d) => d.path.includes(h) || d.id.includes(h)).map((d) => d.id));
    return { file, sc, docIds, opts: name.startsWith("M") ? { ...runOpts, fast: true } : runOpts };
  };
  // --concurrent: 묶음들을 회차마다 동시에 돌린다 (회의 여러 개가 한 서버에서 섞이지 않는지)
  const concurrent = args.includes("--concurrent");
  const pre = new Map<string, import("./live-lib").RunResult[]>();
  if (concurrent) {
    for (let k = 0; k < repeat; k++) {
      const rs = await Promise.all(names.map((n) => { const x = load(n); return lib.runScenario(x.sc, inProcess(), x.docIds, x.opts); }));
      names.forEach((n, i) => (pre.get(n) ?? pre.set(n, []).get(n)!).push(rs[i]));
    }
  }

  for (const name of names) {
    const { file, sc, docIds, opts } = load(name);
    const results: import("./live-lib").RunResult[] = [];
    for (let k = 0; k < repeat; k++) {
      const r = concurrent ? pre.get(name)![k] : await lib.runScenario(sc, inProcess(), docIds, opts);
      results.push(r);
      total += r.snap.cost;
      allSnaps.push(r.snap);
      stageRows.push(...lib.stages(name, k + 1, r.snap));
      const s = lib.runSummary(r);
      console.log(`${name} ${k + 1}회차: 맞힘 ${s.hit}/${s.total} 오탐 ${s.offense} 추가카드 ${s.cards}${r.checklistOk === undefined ? "" : ` 체크리스트 ${r.checklistOk ? "맞음" : "다름"}`} 말로 끼어듦 ${r.speaks}${partials ? ` 미리 생각 ${r.drafts.thinking}(거둠 ${r.drafts.dropped}, final보다 ${r.drafts.leadMs.map((x) => (x / 1000).toFixed(1)).join("/") || "—"}초 앞)` : ""} · $${r.snap.cost.toFixed(4)} (누적 $${total.toFixed(3)})`);
      if (r.voice) {
        const sec = (x?: number) => (x === undefined ? "—" : (x / 1000).toFixed(2));
        const rel = (x: number | undefined, base: number) => (x === undefined ? "—" : ((x - base) / 1000).toFixed(2));
        for (const v of r.voice) console.log(`  #${v.uttId} 말 끝 ${sec(v.speechEnd)} · final ${sec(v.final)} · draft ${rel(v.draft, v.final)} · queued ${rel(v.queued, v.final)} · ${v.actType ?? "행동 없음"} ${rel(v.act, v.final)} (final 기준 초)${v.reused ? " · partial 이어씀" : ""}`);
        voiceRows.push(...r.voice.map((v) => ({ name, run: k + 1, partials, ...v })));
      }
      // 부름·1:1 대답: 그 말을 보낸 때부터 받침말·prepare·대답(speak)까지 (초)
      {
        const rows: string[] = [];
        for (const c of r.snap.cands.filter((x) => x.kind === "answer" || x.kind === "ack")) {
          const sent = r.lineSentAt[c.uttId - 1];
          const ev = (type: string) => lib.findEv(r, c.actionId, type);
          const sp = ev("speak");
          const pre = ev("prepare");
          const endAt = r.speechEndAt?.get(c.uttId);
          if (sent && sp) rows.push(`#${c.uttId} ${c.kind} ${((sp - sent) / 1000).toFixed(2)}${pre ? ` (prepare ${((pre - sent) / 1000).toFixed(2)})` : ""}${endAt ? ` [말 끝부터 ${((sp - endAt) / 1000).toFixed(2)}]` : ""}`);
        }
        if (rows.length) {
          console.log(`  대답까지(초): ${rows.join(" · ")}`);
          out.push(`대답까지(초, 말 보낸 때부터): ${rows.join(" · ")}`, "");
          answerRows.push(...rows.map((x) => `${name} ${k + 1}회차 ${x}`));
        }
      }
      // 먼저 꺼내기: 꺼낸 말·NONE·접음·중복 막음, 분당
      if (r.snap.planLog?.length) {
        const pl = r.snap.planLog;
        const said = pl.filter((x) => x.text && !x.note);
        const mins = Math.max(0.5, (r.lineSentAt.at(-1)! - r.lineSentAt[0]) / 60000);
        const tags = [...new Set(said.map((x) => x.tag))].map((t) => `${t} ${said.filter((x) => x.tag === t).length}`).join("·");
        const line = `먼저 꺼내기: 판단 ${pl.length} → 꺼냄 ${said.length}${tags ? ` (${tags})` : ""} · NONE ${pl.filter((x) => x.tag === "NONE").length} · 접음 ${pl.filter((x) => x.note?.includes("접음")).length} · 중복 막음 ${pl.filter((x) => x.note?.includes("이미 꺼낸")).length} · 분당 ${(said.length / mins).toFixed(2)}`;
        console.log(`  ${line}`);
        for (const x of said) console.log(`    #${x.uttId} ${x.tag} (${x.trigger}): ${x.text}`);
        const thinks = pl.filter((x) => x.tag === "THINK").map((x) => `#${x.uttId} ${x.note?.match(/최고 ([\d.-]+)/)?.[1] ?? "-"}`);
        const thr = pl.find((x) => x.tag === "THINK")?.note?.match(/임계 ([\d.]+)/)?.[1];
        if (thinks.length) console.log(`    속생각 최고점(임계 ${thr}): ${thinks.join(" · ")}`);
        const held = pl.filter((x) => x.tag !== "THINK" && x.note && x.trigger === "말할 틈").map((x) => `${x.tag} ${x.note}`);
        if (held.length) console.log(`    참음: ${held.join(" · ")}`);
        out.push(line, "", ...said.map((x) => `- #${x.uttId} ${x.tag} (${x.trigger}): ${x.text}`), "");
        planRows.push({ name, run: k + 1, judged: pl.length, said: said.length, perMin: said.length / mins });
      }
      if (r.snap.soloLog?.length) {
        const line = `1:1 대답 판단: ${r.snap.soloLog.map((x) => `#${x.uttId} ${x.reply === null ? "NONE" : "대답"}`).join(" · ")}`;
        console.log(`  ${line}`);
        out.push(line, "");
      }
      const reasons = new Map<string, number>();
      for (const x of r.snap.partialLog ?? []) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
      if (reasons.size) {
        console.log(`  partial: ${[...reasons].map(([k2, v]) => `${k2} ${v}`).join(" · ")}`);
        out.push(`partial 까닭별: ${[...reasons].map(([k2, v]) => `${k2} ${v}`).join(" · ")}`, "");
      }
      out.push(...lib.runSection(name, k, r));
      if (isLong(name)) out.push(...mentoringNotes(r, sc.lines.length));
      else out.push("<details><summary>시간순</summary>", "", "```", ...r.timeline, "```", "</details>", "");
    }
    roleRuns.push({ results, lines: sc.lines.length });
    const sums = results.map(lib.runSummary);
    const same = new Set(results.map((r) => JSON.stringify(r.rows.map((x) => x.ok)) + JSON.stringify(r.extras.map((x) => x.got.ev.type)))).size === 1;
    summary.push(`| ${name} | ${path.basename(file, ".md")} | ${sums.map((s) => `${s.hit}/${s.total}`).join(" · ")} | ${sums.map((s) => s.offense).join(" · ")} | ${results.map((r) => r.speaks).join(" · ")} | ${same ? "같음" : "다름"} | $${results.reduce((a, r) => a + r.snap.cost, 0).toFixed(3)} |`);
  }

  // 지연 표
  const sp = stageRows.filter((r) => r.kind === "speak" && r.via !== "respond");
  const col = (k: keyof import("./live-lib").StageRow, rows = sp) => rows.map((r) => r[k] as number).filter((x) => typeof x === "number");
  const p = (xs: number[]) => (xs.length ? `${lib.pct(xs, 50)} / ${lib.pct(xs, 90)}` : "—");
  const tpl = sp.filter((r) => r.template);
  const lat = [
    `| 단계 | 전체 p50 / p90 (ms) | 미리 만든 말 p50 / p90 |`,
    `| --- | --- | --- |`,
    `| final → 어긋남 알아챔 (watch 앞부분) | ${p(col("watch"))} | ${p(col("watch", tpl))} |`,
    `| 알아챔 → 대사 준비 | ${p(col("prep"))} | ${p(col("prep", tpl))} |`,
    `| 준비 → 말함 (조용해지길 기다림) | ${p(col("wait"))} | ${p(col("wait", tpl))} |`,
    `| **final → speak** | **${p(col("total"))}** | **${p(col("total", tpl))}** |`,
    `| (참고) verify | ${p(col("verifyMs"))} | ${p(col("verifyMs", tpl))} |`,
    ``,
    `말로 끼어든 ${sp.length}건 중 미리 만든 말 ${tpl.length}건, 말한 뒤 verify가 아니라고 한 것 ${sp.filter((r) => r.lateNo).length}건. 손들기 ${stageRows.filter((r) => r.kind === "hand_raise").length}건.`,
    ``,
    `<details><summary>건별 (ms)</summary>`,
    ``,
    `| 묶음 | 회차 | 발화 | 행동 | 미리 만든 말 | watch | 준비 | 기다림 | final→행동 | verify |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...stageRows.map((r) => `| ${r.scenario} | ${r.run} | #${r.uttId} | ${r.kind}${r.via ? ` (${r.via})` : ""} | ${r.template ? "예" : "아니오"} | ${r.watch} | ${r.prep} | ${r.wait} | ${r.total} | ${r.verifyMs ?? "—"}${r.lateNo ? " ✗" : ""} |`),
    ``,
    `</details>`,
  ];
  const roles: Record<string, { ms: number[]; first: number[]; hedged: number }> = {};
  for (const s of allSnaps) for (const st of s.stats) {
    const r = (roles[st.role] ??= { ms: [], first: [], hedged: 0 });
    r.ms.push(st.ms);
    if (st.firstTokenMs !== undefined) r.first.push(st.firstTokenMs);
  }
  for (const s of allSnaps) for (const [role, v] of Object.entries(s.byRole)) if (roles[role]) roles[role].hedged += v.hedged;
  const roleTable = [`| 역할 | 모델 | 호출 | 첫 토큰 p50 | 전체 p50 / p90 | 재요청 |`, `| --- | --- | --- | --- | --- | --- |`, ...Object.entries(roles).map(([role, v]) => `| ${role} | ${ROLE_MODELS[role as keyof typeof ROLE_MODELS].model} | ${v.ms.length} | ${lib.pct(v.first, 50)} | ${lib.pct(v.ms, 50)} / ${lib.pct(v.ms, 90)} | ${v.hedged} |`)];

  // 역할별 MIR·FIR (brain-design §5-2): 기대가 있는 줄에서 놓친 비율 / 기대가 없는 줄에서 그 역할로 나온 행동 비율
  const rates: Record<string, { expected: number; missed: number; extra: number; quiet: number }> = {};
  for (const rr of roleRuns) {
    for (const [role, v] of Object.entries(lib.roleRates(rr.results, rr.lines))) {
      const x = (rates[role] ??= { expected: 0, missed: 0, extra: 0, quiet: 0 });
      x.expected += v.expected;
      x.missed += v.missed;
      x.extra += v.extra;
      x.quiet += v.quiet;
    }
  }
  const pctOf = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const rateTable = [`| 역할 | 꺼내야 할 때 | 놓침 → MIR | 참아야 할 줄 | 헛끼어듦 → FIR |`, `| --- | --- | --- | --- | --- |`, ...Object.entries(rates).map(([role, v]) => `| ${role} | ${v.expected} | ${v.missed} → ${pctOf(v.missed, v.expected)} | ${v.quiet} | ${v.extra} → ${pctOf(v.extra, v.quiet)} |`)];

  // 비용 분해 (cost-design ①): 역할 × 토큰 종류. 재요청(hedge)은 진 쪽 비용이 stat에 안 들어가므로 입력·캐시 몫을 한 번 더 셈 [추정]
  const cost: Record<string, { n: number; hedged: number; input: number; cacheRead: number; cacheWrite: number; output: number; cIn: number; cRead: number; cWrite: number; cOut: number; hedgeEst: number; model: string }> = {};
  const { PRICES } = await import("../src/lib/live/models");
  for (const sn of allSnaps) for (const st of sn.stats) {
    const x = (cost[st.role] ??= { n: 0, hedged: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cIn: 0, cRead: 0, cWrite: 0, cOut: 0, hedgeEst: 0, model: st.model });
    const pr = PRICES[st.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    x.n++;
    x.input += st.input;
    x.cacheRead += st.cacheRead;
    x.cacheWrite += st.cacheWrite;
    x.output += st.output;
    x.cIn += (st.input * pr.input) / 1e6;
    x.cRead += (st.cacheRead * pr.cacheRead) / 1e6;
    x.cWrite += (st.cacheWrite * pr.cacheWrite) / 1e6;
    x.cOut += (st.output * pr.output) / 1e6;
    if (st.hedged) {
      x.hedged++;
      x.hedgeEst += (st.input * pr.input + st.cacheRead * pr.cacheRead) / 1e6;
    }
  }
  const usd = (v: number) => `$${v.toFixed(4)}`;
  const costRows = Object.entries(cost).sort((a, b) => b[1].cIn + b[1].cRead + b[1].cWrite + b[1].cOut - (a[1].cIn + a[1].cRead + a[1].cWrite + a[1].cOut));
  const sumAll = costRows.reduce((a, [, v]) => a + v.cIn + v.cRead + v.cWrite + v.cOut, 0);
  const costTable = [
    `| 역할 | 모델 | 호출 (재요청) | 입력 토큰/호출 | 캐시 읽기/호출 | 캐시 쓰기/호출 | 출력/호출 | 입력 $ | 캐시 읽기 $ | 캐시 쓰기 $ | 출력 $ | 합 (비중) | 재요청 진 쪽 추정 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...costRows.map(([role, v]) => {
      const t = v.cIn + v.cRead + v.cWrite + v.cOut;
      return `| ${role} | ${v.model} | ${v.n} (${v.hedged}) | ${Math.round(v.input / v.n)} | ${Math.round(v.cacheRead / v.n)} | ${Math.round(v.cacheWrite / v.n)} | ${Math.round(v.output / v.n)} | ${usd(v.cIn)} | ${usd(v.cRead)} | ${usd(v.cWrite)} | ${usd(v.cOut)} | ${usd(t)} (${pctOf(t, sumAll)}) | +${usd(v.hedgeEst)} |`;
    }),
  ];

  const head = [
    `# 모델 시나리오 채점 — ${new Date().toISOString()}`,
    ``,
    ...(dial !== undefined ? [`- **참여도 다이얼 ${dial}** (대본 강도 대신) — 채널은 다이얼이 정하므로 같은 역할의 소리·손들기를 같게 셈, 카드는 8줄 늦게까지 맞힘`] : []),
    `- watch: ${watchVariant} (${ROLE_MODELS.watch.model}${ROLE_MODELS.watch.thinkingOff ? `, 생각 끔(${ROLE_MODELS.watch.thinkingOff})` : ", 생각 켬"})`,
    `- 묶음: ${names.join(", ")} · 각 ${repeat}회${concurrent ? " · **동시에**" : ""} · 사람 말 ${runOpts.speed}배 빠르게 · 기다려 줌 ${runOpts.patience}ms · 기본 침묵 ${runOpts.pauseMs}ms${process.env.LIVE_CACHE === "1" ? " · **캐시 사용(지연 숫자 의미 없음)**" : ""}`,
    `- 타이밍은 S2 음성 서버 흉내: gap 300(말 끝+0.6초) → gap 800(+0.82초) → final(+0.9초) → gap 1500(+1.8초)`,
    `- 걸린 시간 ${Math.round((Date.now() - started) / 1000)}초 · 비용 **$${total.toFixed(4)}**`,
    ``,
    `## 결과`,
    ``,
    `| 묶음 | 대본 | 맞힘 (회차별) | 오탐 | 말로 끼어듦 | 3회 같음 | 비용 |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...summary,
    ``,
    ...(voiceRows.length
      ? [
          `## 실제 음성 재생 — 어긋남마다 시각 (초, final 받은 때 기준. 말 끝은 회의 시작 기준)`,
          ``,
          `| 묶음 | 회차 | partial | 발화 | 말 끝 | final | draft | queued | 행동 | partial 이어씀 |`,
          `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
          ...voiceRows.map((v) => {
            const rel = (x?: number) => (x === undefined ? "—" : ((x - v.final) / 1000).toFixed(2));
            return `| ${v.name} | ${v.run} | ${v.partials ? "켬" : "끔"} | #${v.uttId} | ${v.speechEnd === undefined ? "—" : (v.speechEnd / 1000).toFixed(2)} | ${(v.final / 1000).toFixed(2)} | ${rel(v.draft)} | ${rel(v.queued)} | ${v.actType ?? "—"} ${rel(v.act)} | ${v.reused ? "예" : "아니오"} |`;
          }),
          ``,
        ]
      : []),
    `## 역할별 놓침률(MIR)·헛끼어듦률(FIR)${allRoles ? " — 모든 대본에 두뇌 기본 역할(어긋남·역할 빈칸·리서치·피드백)을 켬" : " — 어긋남 대본은 어긋남만, 역할 대본은 그 역할만 켬"}`,
    ``,
    ...rateTable,
    ``,
    `## 비용 분해 (역할 × 토큰 종류)`,
    ``,
    ...costTable,
    ``,
    `## 지연 (말로 끼어든 것, 단계별)`,
    ``,
    ...lat,
    ``,
    ...roleTable,
    ``,
    `## 회차별`,
    ``,
  ];
  const dir = path.join(ROOT, "tests", "live", "results");
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `eval-${names.join("")}${concurrent ? "-concurrent" : ""}${watchVariant === "haiku" ? "" : `-${watchVariant}`}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  fs.writeFileSync(outFile, [...head, ...out].join("\n"));
  console.log([...head.slice(6)].join("\n"));
  console.log(`\n저장: ${path.relative(ROOT, outFile)}`);
}

function mentoringNotes(r: import("./live-lib").RunResult, n: number): string[] {
  const tl = r.snap.tokenLog;
  const pick = (i: number) => tl[Math.min(tl.length - 1, Math.floor(i))];
  const pts = [0, tl.length * 0.25, tl.length * 0.5, tl.length * 0.75, tl.length - 1].map(pick).filter(Boolean);
  const calls = Object.entries(r.snap.byRole).map(([k, v]) => `${k} ${v.n}`).join(", ");
  const spoken = r.timeline.filter((l) => l.includes("🗣") || l.includes("✋"));
  // 회의가 길어져도 watch가 느려지지 않는지: 앞에서부터 4등분해 각 구간의 watch 지연 중앙값
  const w = r.snap.stats.filter((x) => x.role === "watch").map((x) => x.ms);
  const q = (i: number) => w.slice(Math.floor((w.length * i) / 4), Math.floor((w.length * (i + 1)) / 4));
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  return [
    `- 발화 ${n}개 · 호출 ${calls} · 비용 $${r.snap.cost.toFixed(4)}`,
    `- 맥락 토큰(추정, 고정 + 요약 + 최근): ${pts.map((x) => `#${x.uttId} ${x.fixed}+${x.summary}+${x.recent}`).join(" → ")}`,
    `- watch 지연 중앙값(앞 1/4 → 끝 1/4): ${[0, 1, 2, 3].map((i) => `${med(q(i))}ms`).join(" → ")} · 판단 건너뜀 ${r.snap.health?.skipped ?? 0} · 상태 ${r.snap.health?.state ?? "?"}`,
    `- 미티가 말하거나 손든 것 ${spoken.length}개:`,
    ...spoken.map((l) => `  - ${l.trim()}`),
    ``,
  ];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
