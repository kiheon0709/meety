// 시나리오 A 회의 4 리허설: 정리가 "일요일(11/1)"을 쓰면 근거 확인이 "녹취에 11/1 없음"으로 버리고(4번 중 2번 재현),
// 동의가 있어도 제안/합의가 실행마다 갈리던 것 — 모델 없이 결정적으로 확인한다.
import { describe, expect, it, vi } from "vitest";
import { annotateDates } from "../src/lib/date";
import { promoteAgreed } from "../src/lib/service";
import type { AgentCommit } from "../src/lib/agent";

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse };
  },
}));

const LINES: [string, string][] = [
  ["준영", "녹음은 그냥 붙여넣기만 받죠. 브라우저 녹음은 빼고요."],
  ["태은", "리허설은 일요일 저녁에 한 번 해요."],
  ["지호", "좋아요. 일요일 저녁으로 하죠."],
  ["기헌", "오케이, 오늘은 여기까지."],
];
const utts = (speakers?: string[]) => LINES.map(([s, text], i) => ({ idx: 8 + i, speaker: speakers?.[i] ?? s, text }));

function commit(status: string, source_idxs = [9], type: "decision" | "claim" = "decision"): AgentCommit {
  return {
    message: "리허설 일정",
    needs_review: false,
    review_reason: null,
    confidence: 0.9,
    changes: [
      {
        op: "add",
        node_id: null,
        node: { type, title: "리허설은 일요일(11/1) 저녁에 한 번", body: "", topic: "발표 준비", owner: null, status, due: null },
        patch: null,
        source_idxs,
        reason: "",
      },
    ],
  };
}

describe("요일·상대 날짜를 회의 날짜로 계산해 덧붙이기", () => {
  it("금요일(10/30) 회의의 '일요일'은 11/1", () => {
    expect(annotateDates("리허설은 일요일 저녁에 한 번 해요.", "2026-10-30")).toBe("리허설은 일요일 저녁에 한 번 해요. [일요일 = 11/1(일)]");
  });
  it("이번 주·다음 주·지난주·내일·모레", () => {
    expect(annotateDates("다음 주 금요일까지", "2026-10-30")).toContain("[다음 주 금요일 = 11/6(금)]");
    expect(annotateDates("이번 주 토요일", "2026-10-30")).toContain("10/31(토)");
    expect(annotateDates("지난주 수요일 회의", "2026-10-30")).toContain("10/21(수)");
    expect(annotateDates("내일이나 모레", "2026-10-30")).toBe("내일이나 모레 [내일 = 10/31(토), 모레 = 11/1(일)]");
  });
  it("날짜 말이 없으면 그대로, 같은 말은 한 번만", () => {
    expect(annotateDates("요일 상관없어요", "2026-10-30")).toBe("요일 상관없어요");
    expect(annotateDates("일요일, 일요일", "2026-10-30")).toBe("일요일, 일요일 [일요일 = 11/1(일)]");
    expect(annotateDates("일요일", "날짜 아님")).toBe("일요일");
  });
});

describe("근거 확인이 날짜 표시를 본다", () => {
  it("verifyCommits 녹취에 [일요일 = 11/1(일)]이 들어간다", async () => {
    const { verifyCommits } = await import("../src/lib/agent");
    parse.mockResolvedValueOnce({ parsed_output: { drops: [], review_overrides: [] }, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" });
    const r = await verifyCommits({ head: [], utterances: utts(), commits: [commit("agreed")], heldAt: "2026-10-30" });
    const sent = parse.mock.calls.at(-1)![0];
    expect(sent.messages[0].content).toContain("[9] 태은: 리허설은 일요일 저녁에 한 번 해요. [일요일 = 11/1(일)]");
    expect(sent.system).toContain("회의 날짜로 계산한 것이라 근거로 친다");
    expect(r.commits).toHaveLength(1);
  });
  it("extractCommits 녹취에도 같은 표시", async () => {
    const { extractCommits } = await import("../src/lib/agent");
    parse.mockResolvedValueOnce({ parsed_output: { commits: [] }, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" });
    await extractCommits({ head: [], utterances: utts(), sessionTitle: "회의 4", heldAt: "2026-10-30" });
    const sent = parse.mock.calls.at(-1)![0];
    expect(sent.messages[0].content).toContain("[일요일 = 11/1(일)]");
    expect(sent.system[0].text).toContain("원문 표현을 남긴 채");
  });
});

describe("바로 뒤 다른 사람의 분명한 동의 → 합의", () => {
  it("태은 제안 + 지호 '좋아요, 일요일 저녁으로 하죠' → agreed, 동의 발화가 근거에 붙음", () => {
    const cs = [commit("proposed")];
    expect(promoteAgreed(cs, utts())).toBe(1);
    expect(cs[0].changes[0].node!.status).toBe("agreed");
    expect(cs[0].changes[0].source_idxs).toEqual([9, 10]);
  });
  it("화자를 모르면(?) 다른 사람으로 본다", () => {
    const cs = [commit("proposed")];
    expect(promoteAgreed(cs, utts(["?", "?", "?", "?"]))).toBe(1);
  });
  it("제안한 사람이 스스로 '좋아요'면 그대로", () => {
    const cs = [commit("proposed")];
    expect(promoteAgreed(cs, utts(["준영", "태은", "태은", "기헌"]))).toBe(0);
    expect(cs[0].changes[0].node!.status).toBe("proposed");
  });
  it("'좋아요, 근데 …'·'오케이, 오늘은 여기까지'는 동의로 안 본다", () => {
    const lines = utts();
    lines[2] = { ...lines[2], text: "좋아요, 근데 토요일이 낫지 않아요?" };
    const cs = [commit("proposed")];
    expect(promoteAgreed(cs, lines)).toBe(0);
    // 동의 줄이 없고 다음이 "오케이, 오늘은 여기까지"뿐
    const noAgree = utts().filter((u) => u.idx !== 10);
    expect(promoteAgreed([commit("proposed")], noAgree)).toBe(0);
  });
  it("결정이 아니거나 이미 합의면 건드리지 않는다", () => {
    const claim = [commit("open", [9], "claim")];
    expect(promoteAgreed(claim, utts())).toBe(0);
    const agreed = [commit("agreed")];
    expect(promoteAgreed(agreed, utts())).toBe(0);
    expect(agreed[0].changes[0].source_idxs).toEqual([9]);
  });
  it("동의가 2마디보다 멀면 올리지 않는다", () => {
    const far = [
      ...utts().slice(0, 2),
      { idx: 10, speaker: "준영", text: "슬라이드는 제가 할게요." },
      { idx: 11, speaker: "기헌", text: "자료는 내일 볼게요." },
      { idx: 12, speaker: "지호", text: "좋아요." },
    ];
    expect(promoteAgreed([commit("proposed")], far)).toBe(0);
  });
});
