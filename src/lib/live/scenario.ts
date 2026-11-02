// 시나리오 대본(md) 읽기. 재생 평가(scripts/live-replay.ts)와 시험이 같이 쓴다.
import type { AgendaItem, Intensity, MeetingMode, RoleKind } from "./contract";

export interface Expect {
  type: "speak" | "hand_raise" | "change_card" | "settings" | "checklist" | "show" | "private";
  kind?: string; // speak·hand_raise: conflict/ack/answer · settings: high/mid/low
  raw: string;
  statuses?: string[]; // checklist: 안건 항목 상태 순서
  raised?: number; // checklist: 끝에 붙을 손든 항목 수
  needsDoc?: boolean; // "자료 근거": 근거에 자료(docId·loc)가 있어야 맞힘
  mustInclude?: string[]; // "포함: 11월 2일|11/2": 대사에 이 중 하나가 있어야 맞힘
}

export interface Line {
  speaker: string;
  text: string;
  expects: Expect[];
  pauseAfterMs?: number; // 대본의 "(침묵 N초)" — 이 말 뒤에 아무도 말 안 하는 시간 (먼저 꺼내기 채점)
}

export interface Scenario {
  title: string;
  participants: string[];
  intensity: Intensity;
  agenda: AgendaItem[];
  wantsDocs: boolean;
  docHints: string[]; // docIds: [B-plan.md를 읽은 문서] → ["B-plan"]
  lines: Line[];
  // 팀원 역할 (brain-design §5): "- roles: conflict, owner_gap" (켤 것만), "- budget: 3" (10분 자발 소리), "- mode: decision"
  roles?: RoleKind[];
  budget?: number;
  mode?: MeetingMode;
  leadPauseMs?: number; // 첫 말 전 "(침묵 N초)" — 미티가 회의를 여는 틈
}

export function parseExpect(raw: string): Expect[] {
  const out: Expect[] = [];
  const re = /speak\s+(conflict|ack|answer|open_item|owner_gap|feedback|structure|suggest)|hand_raise\s+(conflict|open_item|owner_gap|feedback|structure|suggest)|settings\s+(high|mid|low)|change_card|checklist|\back\b|show\s+(research|suggest|structure)|private\s+(quiet_member|structure)/g;
  for (const m of raw.matchAll(re)) {
    const inc = raw.match(/포함:\s*([^()\n]+?)\s*(?:$|\(|·)/)?.[1];
    if (m[1]) out.push({ type: "speak", kind: m[1], raw, ...(raw.includes("자료 근거") ? { needsDoc: true } : {}), ...(inc ? { mustInclude: inc.split("|").map((x) => x.trim()).filter(Boolean) } : {}) });
    else if (m[2]) out.push({ type: "hand_raise", kind: m[2], raw });
    else if (m[3]) out.push({ type: "settings", kind: m[3], raw });
    else if (m[0] === "change_card") out.push({ type: "change_card", raw });
    else if (m[4]) out.push({ type: "show", kind: m[4], raw, ...(inc ? { mustInclude: inc.split("|").map((x) => x.trim()).filter(Boolean) } : {}) });
    else if (m[5]) out.push({ type: "private", kind: m[5], raw });
    else if (m[0] === "ack") out.push({ type: "speak", kind: "ack", raw });
    else if (m[0] === "checklist") {
      const tail = raw.slice(raw.indexOf("checklist"));
      const statuses = [...tail.matchAll(/\b(done|open|no_owner)\b/g)].map((x) => x[1]);
      const r = tail.match(/손든 항목\s*(\d+)\s*개/);
      out.push({ type: "checklist", raw, statuses, raised: r ? Number(r[1]) : 0 });
    }
  }
  return out;
}

export function parseScenario(md: string): Scenario {
  const field = (name: string) => md.match(new RegExp(`^-\\s*${name}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
  const title = field("title");
  const participants = field("participants")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const intensity = (field("intensity") || "high") as Intensity;

  let agenda: AgendaItem[] = [];
  const inline = field("agenda");
  if (inline.startsWith("[")) {
    agenda = [...inline.matchAll(/title:\s*"([^"]*)"\s*,\s*expected:\s*\[([^\]]*)\]/g)].map((m) => ({ title: m[1], expected: [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]) }));
  } else {
    const block = md.split(/^-\s*agenda:.*$/m)[1] ?? "";
    for (const line of block.split("\n")) {
      const m = line.match(/^\s+\d+\.\s*(.+?)\s*—\s*expected:\s*\[(.*)\]/);
      if (m) agenda.push({ title: m[1].trim(), expected: [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]) });
      else if (agenda.length && /^\S/.test(line)) break;
    }
  }
  const wantsDocs = /^-\s*docIds:/m.test(md);
  const docHints = [...field("docIds").matchAll(/([A-Za-z][\w-]*?)(?:\.md)?(?=[^\w-]|$)/g)].map((x) => x[1]).filter((x) => x.length > 2);

  const code = md.match(/## 대본[\s\S]*?```[a-z]*\n([\s\S]*?)```/)?.[1] ?? "";
  const lines: Line[] = [];
  let leadPauseMs = 0;
  let last: Expect[] | null = null;
  let lastRaw = "";
  for (const row of code.split("\n")) {
    if (!row.trim()) continue;
    const ex = row.match(/^\[미티 기대\]\s*(.*)$/);
    if (ex) {
      if (!lines.length) continue;
      lastRaw = ex[1];
      last = lines[lines.length - 1].expects;
      last.push(...parseExpect(lastRaw));
      continue;
    }
    const pause = row.match(/^\(침묵\s*(\d+(?:\.\d+)?)\s*초\)\s*$/);
    if (pause) {
      if (lines.length) lines[lines.length - 1].pauseAfterMs = Number(pause[1]) * 1000;
      else leadPauseMs = Number(pause[1]) * 1000; // 첫 말 전 침묵 — 미티가 회의를 여는지
      continue;
    }
    const sp = row.match(/^([^\s:：][^:：]{0,19})[:：]\s*(.+)$/);
    if (sp) {
      lines.push({ speaker: sp[1].trim(), text: sp[2].trim(), expects: [] });
      last = null;
    } else if (last && /^\s+/.test(row)) {
      // 기대 줄의 이어지는 줄 — 체크리스트에 붙는 말 등
      const merged = parseExpect(`${lastRaw} ${row.trim()}`);
      const cl = merged.find((e) => e.type === "checklist");
      const prev = last.find((e) => e.type === "checklist");
      if (cl && prev) Object.assign(prev, cl);
      lastRaw = `${lastRaw} ${row.trim()}`;
    }
  }
  const roles = field("roles")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean) as RoleKind[];
  const budget = field("budget") ? Number(field("budget")) : undefined;
  const mode = (field("mode") || undefined) as MeetingMode | undefined;
  return { title, participants, intensity, agenda, wantsDocs, docHints, lines, ...(roles.length ? { roles } : {}), ...(budget !== undefined && Number.isFinite(budget) ? { budget } : {}), ...(mode ? { mode } : {}), ...(leadPauseMs ? { leadPauseMs } : {}) };
}

// 발화 길이 추정 (초): 공백 뺀 글자당 0.16초
export function speechSec(text: string): number {
  return Math.max(0.6, text.replace(/\s/g, "").length * 0.16);
}

// 긴 실제 회의 전사(멘토링 등) → 대본. "**[mm:ss] 이름:** 글" 문단을 문장 몇 개씩(150자 안쪽) 발화로 나눈다.
// 받아쓰기 그대로라 [미티 기대]는 없다 — 미티가 조용해야 정답.
export function parseLongTranscript(md: string, opts: { limit?: number; maxChars?: number } = {}): Scenario {
  const maxChars = opts.maxChars ?? 150;
  const lines: Line[] = [];
  const speakers = new Set<string>();
  let speaker = "";
  for (const raw of md.split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#") || t.startsWith("- ")) continue;
    const m = t.match(/^\*\*(?:\[[\d:]+\]\s*)?([^*:]+?):\*\*\s*(.*)$/);
    let text = t;
    if (m) {
      speaker = m[1].replace(/\s*멘토$/, "").trim();
      text = m[2];
    }
    if (!speaker || !text) continue;
    speakers.add(speaker);
    // 말로 하는 문장은 마침표가 거의 없다 → 어절 단위로 모으다가, 반쯤 찼을 때 "~요/~다/~죠/~까"로 끝나는 어절에서 끊는다
    let buf = "";
    for (const w of text.split(/\s+/)) {
      buf = buf ? `${buf} ${w}` : w;
      const end = /[.?!]$|(요|다|죠|까)[,.]?$/.test(w);
      if ((end && buf.length >= maxChars * 0.5) || buf.length >= maxChars) {
        lines.push({ speaker, text: buf, expects: [] });
        buf = "";
      }
    }
    if (buf) lines.push({ speaker, text: buf, expects: [] });
  }
  const cut = opts.limit && opts.limit > 0 ? lines.slice(0, opts.limit) : lines;
  return { title: "긴 실제 회의", participants: [...speakers], intensity: "high", agenda: [], wantsDocs: false, docHints: [], lines: cut };
}
