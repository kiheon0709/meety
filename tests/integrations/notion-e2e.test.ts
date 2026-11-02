// 노션 읽기 끝까지 (S5): 가짜 노션 MCP 서버에서 페이지 1장 → 사실 N개 → 회의에서 "마감이 언제였지?" → 리서치 카드에 노션 출처.
// 모델은 가짜(고정 응답). 리서치 카드 자체는 S3 meeting.ts — 여기선 연동한 자료가 거기까지 가는지만 본다.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { getFacts } from "../../src/lib/ingest";
import type { Extractor } from "../../src/lib/ingest/extract";
import { beginNotionAuth, finishNotionAuth, importNotionPage } from "../../src/lib/integrations/notion";
import type { ModelRole } from "../../src/lib/live/contract";
import { setLlm, type CallInput, type LlmFn } from "../../src/lib/live/llm";
import { onUtterance, shutdownMeetings, startMeeting, subscribe, type Meeting, type OutEvent } from "../../src/lib/live/meeting";
import { ANSWER_SYSTEM, CHECKLIST_SYSTEM, TEMPLATE_SYSTEM, WATCH_SYSTEM } from "../../src/lib/live/prompts";
import { addMember, createSpace } from "../../src/lib/service";
import { approve, fakeNotion, PAGE_ID, PAGE_URL } from "./fake-notion";

const tmp = path.join(process.cwd(), "tests", ".tmp", `notion-e2e-${process.pid}`);
process.env.GALPI_INGEST_DIR = path.join(tmp, "data", "ingest");
process.env.GALPI_UPLOAD_DIR = path.join(tmp, "data", "uploads");
process.env.NOTION_MCP_CLIENT_ID = "cid-test";
process.env.LIVE_AUTO_PROCESS = "0";

const PAGE = `<page url="https://www.notion.so/${PAGE_ID}"><properties>{"title":"제출 안내"}</properties><content># 제출 안내\n\n## 일정\n\n대회 제출일은 11월 2일이다.\n포스터는 A1 세로로 낸다.\n</content></page>`;

const lines: Extractor = async ({ chunks }) => ({
  facts: chunks.flatMap((c, i) =>
    c.text
      .split("\n")
      .map((l) => l.replace(/^[-#\s]+/, "").trim())
      .filter((l) => l && l !== "일정")
      .map((l) => ({ chunk: i, kind: "plan" as const, text: l, quote: l, keys: [] })),
  ),
  usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 },
});

// 가짜 모델: 감시는 아무것도 안 짚고, 리서치(대답 지시문)는 "11월 2일" 사실을 근거로 답한다
let DUE_FACT = "";
const answers: string[] = [];
const fakeLlm = (async (role: ModelRole, input: CallInput<z.ZodType>) => {
  const sys = input.system[0];
  let text = "";
  let out: unknown;
  if (sys === WATCH_SYSTEM) {
    text = JSON.stringify({ conflict: { found: false, node_ids: [], fact_ids: [], said: "", against: "" }, agreement: { found: false, title: "", from: null, to: "", utt_ids: [] }, call: { addressed: false, want: "none", question: "" }, resolved: [] });
    input.onText?.(text);
  } else if (sys === ANSWER_SYSTEM) {
    answers.push(input.system.join("\n"));
    text = `대회 제출일은 11월 2일이에요.\n근거: ${DUE_FACT}`;
  } else if (sys === CHECKLIST_SYSTEM) out = { items: [] };
  else if (sys === TEMPLATE_SYSTEM) text = "";
  if (out === undefined) out = input.schema ? input.schema.parse(JSON.parse(text)) : text;
  return { text, out, stat: { role, model: "fake", ms: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
}) as LlmFn;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(m: Meeting) {
  await sleep(5);
  while (m.busy > 0) await sleep(5);
}

async function meetingIn(spaceId: string, docIds: string[]) {
  for (const n of ["기헌", "준영"]) addMember(spaceId, n);
  const m = startMeeting({ spaceId, title: "제출 준비", agenda: [{ title: "일정", expected: [] }], intensity: "high", docIds, participants: ["기헌", "준영"] });
  const evs: OutEvent[] = [];
  subscribe(m, (e) => evs.push(e));
  await m.templatesReady;
  let id = 0;
  const say = async (text: string, speaker = "기헌") => {
    onUtterance(m, { id: ++id, t0: id, t1: id + 1, text, speaker });
    await settle(m);
  };
  return { m, evs, say };
}

let DOC = "";
let SPACE_A = "";
beforeAll(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  setLlm(fakeLlm);
  const a = createSpace("노션 연결한 팀");
  SPACE_A = a.id;
  const fake = fakeNotion({ pageText: PAGE });
  const ap = approve(fake, await beginNotionAuth(a.id, null, fake.fetch));
  await finishNotionAuth({ state: ap.state, code: ap.code, iss: "https://mcp.notion.com" }, fake.fetch);
  DOC = (await importNotionPage(a.id, PAGE_URL, { fetch: fake.fetch, extractor: lines })).id;
  DUE_FACT = getFacts(DOC).find((f) => f.text.includes("11월 2일"))!.id;
});
afterAll(() => {
  setLlm(null);
  shutdownMeetings();
});

describe("노션 페이지 → 사실 → 회의 리서치 카드", () => {
  it("가져온 페이지 1장이 사실 2개가 된다", () => {
    expect(getFacts(DOC).map((f) => f.text)).toEqual(["대회 제출일은 11월 2일이다.", "포스터는 A1 세로로 낸다."]);
  });

  it("회의에서 '마감이 언제였지?' → 답이 안 나오면 카드에 11월 2일과 노션 페이지 출처", async () => {
    const { m, evs, say } = await meetingIn(SPACE_A, [DOC]);
    expect(m.docIds).toEqual([DOC]);
    await say("근데 대회 마감이 언제였지?");
    await say("음 잘 모르겠네", "준영");
    const show = evs.find((e) => e.type === "show");
    expect(show?.type === "show" && show.canvas).toMatchObject({ kind: "text", lines: ["대회 제출일은 11월 2일이에요.", expect.stringMatching(/^출처: 제출 안내 — /)] });
    expect(m.cands.find((c) => c.kind === "research")?.evidence[0]).toMatchObject({ docId: DOC, quote: "대회 제출일은 11월 2일이다." });
    expect(evs.some((e) => e.type === "speak")).toBe(false); // 소리 없이 카드만
    expect(answers.at(-1)).toContain("대회 제출일은 11월 2일이다."); // 노션 사실이 모델 입력(회의 묶음)에 들어감
  });

  it("다른 팀 회의는 그 노션 자료를 쓸 수 없고, 같은 물음에 카드가 안 나온다", async () => {
    const b = createSpace("노션 없는 팀");
    const { m, evs, say } = await meetingIn(b.id, [DOC]);
    expect(m.docIds).toEqual([]);
    await say("근데 대회 마감이 언제였지?");
    await say("음 잘 모르겠네", "준영");
    expect(evs.some((e) => e.type === "show")).toBe(false);
    expect(m.ctx.text).not.toContain("대회 제출일은 11월 2일이다.");
  });
});
