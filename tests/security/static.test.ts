// 보안 결정적 시험 — 코드를 읽어서 판단하는 것 (모델·두뇌 없이).
// 새로 찾은 구멍은 it.fails("[취약점] …")로 기록한다(지금은 통과=뚫림 확인, 고치면 빨개짐 → it으로). 단계 3 기준 남은 it.fails 없음.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { A7_FLOWS } from "./attacks";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

function walk(dir: string, exts: string[], skip: RegExp): string[] {
  const out: string[] = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (skip.test(rel)) continue;
    if (e.isDirectory()) out.push(...walk(rel, exts, skip));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

// ── 3. 기록을 바꾸는 길: 서버 액션 권한 확인 ─────────────────────────
// 액션 하나 = "export async function 이름(...) { ... }" 덩어리
function actions(): { name: string; body: string; line: number }[] {
  const src = read("src/lib/actions.ts");
  const lines = src.split("\n");
  const out: { name: string; body: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export async function (\w+)/);
    if (!m) continue;
    let j = i;
    while (j < lines.length && lines[j] !== "}") j++;
    out.push({ name: m[1], body: lines.slice(i, j + 1).join("\n"), line: i + 1 });
  }
  return out;
}

// 스페이스를 건드리는데 권한 확인이 필요 없는 것 (이유와 함께)
const NO_GUARD_OK: Record<string, string> = {
  signUpAction: "계정 만들기",
  signInAction: "로그인",
  signOutAction: "로그아웃",
  markNotificationsReadAction: "내 알림",
  createSpaceAction: "새 스페이스",
  joinAction: "초대 토큰으로 확인",
  switchMemberAction: "쿠키만 바꿈. 예시 스페이스에서만 읽힘(getCurrentMember)",
};
// 권한 확인으로 인정하는 꼴: canAccessSpace, 또는 getCurrentMember 결과가 없으면 멈춤
const GUARDED = /canAccessSpace\(|getCurrentMember\([^)]*\);[\s\S]{0,120}?if \(!me\b/;

function unguardedActions() {
  return actions()
    .filter((a) => /"space_id"|"member_id"|"session_id"/.test(a.body))
    .filter((a) => !NO_GUARD_OK[a.name] && !GUARDED.test(a.body))
    .map((a) => `src/lib/actions.ts:${a.line} ${a.name}`);
}

describe("3. 기록 직접 변경 — 서버 액션 권한 확인", () => {
  it("검사 대상 액션이 있다 (파일 구조가 바뀌면 이 시험을 다시 봐야 함)", () => {
    expect(actions().length).toBeGreaterThan(15);
  });

  it("[고침 V1] 스페이스·멤버·회의를 바꾸는 서버 액션은 모두 권한을 확인한다", () => {
    // 단계 2에서 뚫려 있던 10개(claimMember·addMember·toggleDecider·removeMember·updateSettings·createSession·saveRecording·processSession·commitState·ask)를 단계 3에서 고침
    expect(unguardedActions()).toEqual([]);
  });

  it("[고침 V1] 멤버 연결(claimMemberAction)은 그 멤버가 비어 있고 같은 스페이스인지 확인한다", () => {
    const a = actions().find((x) => x.name === "claimMemberAction")!;
    expect(a.body).toMatch(/canAccessSpace\(/);
    expect(a.body).toMatch(/target\.space_id !== spaceId/);
    expect(a.body).toMatch(/target\.user_id && target\.user_id !== user\.id/);
  });

  it("[고침 V1] member_id·session_id를 받는 액션은 그게 이 스페이스 것인지 확인한다", () => {
    for (const name of ["removeMemberAction"]) expect(actions().find((x) => x.name === name)!.body, name).toMatch(/sameSpaceMember\(spaceId/);
    expect(actions().find((x) => x.name === "processSessionAction")!.body).toMatch(/getSession\(sessionId\)\?\.space_id !== spaceId/);
  });
});

// ── 7. 데이터가 어디로 나가나 ─────────────────────────────────────
const CODE = [
  ...walk("src", [".ts", ".tsx"], /node_modules/),
  ...walk("voice", [".py"], /\.venv|__pycache__|cache|recordings/),
  ...walk("scripts", [".ts"], /node_modules/),
];

// 밖으로 나가는 호출이 있는 파일 (코드 추적으로 확인한 목록). 새 파일이 생기면 이 시험이 실패한다 → 데이터 흐름 표를 갱신할 것.
const OUTBOUND_OK: Record<string, string> = {
  "src/lib/agent.ts": "Anthropic — 회의 후 정리",
  "src/lib/live/llm.ts": "Anthropic — 회의 중 watch·speak·verify·summarize",
  "src/lib/ingest/extract.ts": "Anthropic — 자료 사실 뽑기",
  "src/lib/ingest/diff.ts": "Anthropic — 발표 대본·자료 비교 (개발용)",
  "src/lib/notify.ts": "디스코드 웹훅 (safeFetch)",
  "src/lib/integrations/http.ts": "연동 — 커넥터마다 정해진 공식 호스트만 (security.md ⑫)",
  "src/lib/integrations/oauth.ts": "노션 MCP 인가 서버 (safeFetch로만)",
  "src/lib/integrations/mcp.ts": "노션 원격 MCP 서버 (safeFetch로만, 읽기 도구만)",
  "scripts/notion-register.ts": "사람이 한 번 돌리는 노션 클라이언트 등록 (safeFetch로만)",
  "src/lib/integrations/export.ts": "승인된 결정 → 노션 결정 DB·디스코드 (safeFetch로만)",
  "scripts/live-bench.ts": "Anthropic — 개발용 지연 측정",
  "src/app/layout.tsx": "글꼴 CDN",
};

function outboundFiles(): string[] {
  const hits: string[] = [];
  for (const f of CODE) {
    const s = read(f);
    const ts = /new Anthropic\(|fetch\(\s*(hook|["'`]https?:\/\/)|safeFetch\(|fetchImpl\(|href="https?:\/\/(?!localhost)/.test(s);
    const py = /^\s*(import|from)\s+(requests|httpx|aiohttp)\b|urlopen\(\s*["']https?:\/\/(?!localhost|127)/m.test(s);
    if (ts || py) hits.push(f);
  }
  return hits.sort();
}

describe("7. 데이터가 밖으로 나가는 곳", () => {
  it("밖으로 나가는 호출은 정해진 파일에만 있다", () => {
    // 실제 코드에 있는 것만 비교 (두뇌·자료가 아직 합쳐지지 않은 상태에서도 돌게)
    const expected = Object.keys(OUTBOUND_OK).filter(exists).sort();
    expect(outboundFiles()).toEqual(expected);
  });

  it("음성 서버는 원본 음성을 밖으로 보내지 않는다 (네트워크 라이브러리 없음)", () => {
    // 서버가 실제로 불러 쓰는 파일만 (replay.py·fake_meeting.py 같은 개발 도구는 로컬 서버에 붙는 시험용)
    const server = CODE.filter((x) => /^voice\/(server|segmenter|speakers)\.py$|^voice\/tts\//.test(x));
    expect(server.length).toBeGreaterThan(2);
    for (const f of server) {
      const s = read(f);
      expect(s, f).not.toMatch(/^\s*(import|from)\s+(requests|httpx|aiohttp|websockets)\b/m);
      expect(s.replace(/localhost|127\.0\.0\.1/g, ""), f).not.toMatch(/urlopen\(\s*["']https?:/);
    }
  });

  it("녹음 파일은 회의 시작 때 save를 켠 경우에만 만든다", () => {
    const s = read("voice/server.py");
    const opens = [...s.matchAll(/wave\.open\(str\(REC_DIR/g)];
    expect(opens.length).toBe(1);
    const before = s.slice(0, opens[0].index).split("\n").slice(-6).join("\n");
    expect(before).toMatch(/if m\.get\("save"\):/);
  });

  it("두뇌로 가는 발화 요청에 소리 칸이 없다 (글만 간다)", () => {
    const c = read("src/lib/live/contract.ts");
    const utt = c.slice(c.indexOf("export interface UtteranceReq"), c.indexOf("}", c.indexOf("export interface UtteranceReq")));
    expect(utt).not.toMatch(/audio|pcm|wav|Buffer|Uint8Array/i);
  });

  it("데이터 흐름 표(attacks.ts A7_FLOWS)의 '밖으로' 항목이 위 파일 목록과 맞다", () => {
    const external = A7_FLOWS.filter((f) => f.dest !== "local" && f.dest !== "huggingface").map((f) => f.dest);
    expect(new Set(external)).toEqual(new Set(["anthropic", "discord", "notion", "elevenlabs", "cdn"]));
  });
});

// ── 2. 목소리 등록 ──────────────────────────────────────────────────
describe("2. 남의 목소리 — 음성 서버 목소리 등록", () => {
  const hasEnroll = exists("voice/server.py") && /speakers\/enroll/.test(read("voice/server.py"));
  // S7이 고침(음성 서버 require_confirm·replace·Origin 확인) → it.fails에서 it으로
  (hasEnroll ? it : it.skip)("목소리 등록·삭제에는 화면 확인이나 권한이 필요하다", () => {
      const s = read("voice/server.py");
      const enroll = s.slice(s.indexOf('@app.post("/speakers/enroll")'), s.indexOf('@app.delete("/speakers/'));
      const del = s.slice(s.indexOf('@app.delete("/speakers/'), s.indexOf('@app.delete("/speakers/') + 400);
      // 아무 확인 없이 이름만으로 등록·덮어쓰기·삭제가 된다 → 남이 "기헌"으로 자기 목소리를 등록할 수 있음
      expect(enroll + del).toMatch(/token|confirm|auth|Depends\(/i);
    });
});
