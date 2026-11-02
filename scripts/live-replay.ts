// 띄워 둔 Next 서버(/api/live)로 대본을 흘려 넣는 재생 평가 (화면이 쓰는 길 그대로).
//   npx tsx scripts/live-replay.ts docs/agent/scenarios/A-meeting.md [--repeat 3] [--speed 2] [--patience 4000] [--base http://localhost:3108] [--space sp_…] [--participation 9] [--hold 8000]
// 모델 채점 묶음은 서버 없이 도는 scripts/live-eval.ts가 더 빠르다. 이건 라우트·SSE·회의 열쇠까지 확인할 때.
import "./env";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, EndMeetingRes } from "../src/lib/live/contract";
import { parseScenario } from "../src/lib/live/scenario";
import { runScenario, runSection, runSummary, type Driver, type Got, type Snap } from "./live-lib";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const file = args.find((a) => a.endsWith(".md"));
if (!file) {
  console.error("사용법: npx tsx scripts/live-replay.ts <시나리오.md> [--repeat 3] [--base http://localhost:3108]");
  process.exit(1);
}
const BASE = opt("base", "http://localhost:3108");

function http(spaceId: string): Driver {
  let id = "";
  let token = "";
  const events: Got[] = [];
  const ac = new AbortController();
  const call = async (p: string, body?: object) => {
    const r = await fetch(`${BASE}/api/live${p}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "x-live-token": token }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
    return r.json();
  };
  return {
    events,
    async start(sc, docIds) {
      const r = (await call("/start", { spaceId, title: sc.title, agenda: sc.agenda, intensity: sc.intensity, participants: sc.participants, docIds, ...(sc.mode ? { mode: sc.mode } : {}), ...(opt("participation", "") ? { participation: Number(opt("participation", "")) } : {}) })) as { meetingId: string; controlToken: string };
      id = r.meetingId;
      token = r.controlToken;
      // --hold 8000: 회의 주소·열쇠를 알리고 그만큼 기다렸다 시작 — 그 사이 record-screen --meeting으로 화면을 붙여 녹화한다
      if (opt("hold", "")) {
        console.log(`MEETING ${id} ${token} ${spaceId}`);
        await new Promise((res) => setTimeout(res, Number(opt("hold", "0"))));
      }
      const res = await fetch(`${BASE}/api/live/${id}/stream?token=${token}`, { signal: ac.signal });
      void (async () => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const d = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
            buf = buf.slice(i + 2);
            if (d) events.push({ at: Date.now(), ev: JSON.parse(d.slice(6)) as AgentEvent });
          }
        }
      })().catch(() => {});
    },
    async templatesReady() {
      for (let i = 0; i < 300 && !events.some((g) => g.ev.type === "prepare" && g.ev.actionId === "templates"); i++) {
        if ((await this.snapshot()).busy === 0 && i > 5) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    utter: (u) => call(`/${id}/utterance`, u),
    gap: (afterId, ms) => call(`/${id}/gap`, { after_id: afterId, ms }),
    speech: () => call(`/${id}/speech`, {}),
    end: () => call(`/${id}/end`, {}) as Promise<EndMeetingRes>,
    snapshot: () => call(`/${id}/state`) as Promise<Snap>,
    close: () => ac.abort(),
  };
}

async function main() {
  const sc = parseScenario(fs.readFileSync(file!, "utf8"));
  // 서버가 같은 DB를 쓰고 있으니 읽기 전용으로만 연다 (쓰기 연결로 열었다 닫으면 서버 쪽 기록이 사라진 적이 있음)
  const db = new Database(process.env.GALPI_DB_PATH ?? path.join(process.cwd(), "data", "ctxgit.db"), { readonly: true, fileMustExist: true });
  const spaceId = opt("space", "") || (db.prepare(`SELECT id FROM spaces WHERE is_demo = 1 AND name LIKE '%5조%' ORDER BY created_at LIMIT 1`).get() as { id: string } | undefined)?.id;
  db.close();
  if (!spaceId) throw new Error("예시 스페이스가 없어요. npm run seed 먼저");
  const docs = sc.docHints.length ? ((await (await fetch(`${BASE}/api/live/docs?spaceId=${spaceId}`)).json()) as { id: string; path: string }[]) : [];
  const docIds = sc.docHints.flatMap((h) => docs.filter((d) => d.path.includes(h) || d.id.includes(h)).map((d) => d.id));
  const out: string[] = [`# 재생 평가 (HTTP) — ${path.basename(file!, ".md")} · ${new Date().toISOString()}`, ""];
  const repeat = Number(opt("repeat", "1"));
  for (let k = 0; k < repeat; k++) {
    const r = await runScenario(sc, http(spaceId), docIds, { speed: Number(opt("speed", "2")), patience: Number(opt("patience", "4000")), pauseMs: Number(opt("pause", "1200")) });
    const s = runSummary(r);
    console.log(`${k + 1}회차: 맞힘 ${s.hit}/${s.total} · 오탐 ${s.offense} · 추가 카드 ${s.cards} · $${r.snap.cost.toFixed(4)}`);
    console.log(r.timeline.join("\n"));
    out.push(...runSection(path.basename(file!, ".md"), k, r), "```", ...r.timeline, "```", "");
  }
  const dir = path.join(process.cwd(), "tests", "live", "results");
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `replay-${path.basename(file!, ".md")}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  fs.writeFileSync(outFile, out.join("\n"));
  console.log(`저장: ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
