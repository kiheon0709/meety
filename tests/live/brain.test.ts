import { describe, expect, it } from "vitest";
import { WatchOut, parseLines, parseVerify } from "../../src/lib/live/prompts";
import { parseJsonText } from "../../src/lib/live/llm";
import { cleanText, isAcceptance, isBackchannel, isHintEcho, isUnfinished, needsCheck, stripOpener, isLeadingCall, isTentative, hasWakeWord, isEndPhrase, isHideRecordingRequest, isIdentityRequest, isMeetyCommand, isVocative, overlap, parseSettingsCommand, splitSentences } from "../../src/lib/live/rules";
import { parseTemplates } from "../../src/lib/live/prompts";
import { earlyConflict } from "../../src/lib/live/meeting";
import { A6_HIDE_AI } from "../security/attacks";
import { splitRecent, type Utt } from "../../src/lib/live/context";

describe("호출어", () => {
  it("흔들린 받아쓰기까지 받는다", () => {
    for (const t of ["미티야 끼어들지 마", "미띠야, 그거 뭐였지?", "밋티야 말해 봐", "메티야 조용히 해", "아 미트야 그만", "근데 지금 회의 중이니까 미티야 끼어들지 마."]) expect(hasWakeWord(t), t).toBe(true);
  });
  it("일반 단어는 받지 않는다", () => {
    for (const t of ["미팅 시간 바꾸자", "미트볼 먹으러 가요", "미트 소스 파스타", "미디어 쪽 자료", "커미티에서 정했어요", "오늘 미팅룸 잡았어요"]) expect(hasWakeWord(t), t).toBe(false);
  });
  it("맨 앞에서 부름 / 3인칭", () => {
    expect(isLeadingCall("미티, 조용히 해")).toBe(true);
    expect(isLeadingCall("미티 끼어들지 마")).toBe(true);
    expect(isLeadingCall("미티가 바로바로 말하게 하죠")).toBe(false);
    expect(isLeadingCall("근데 미티는 손만 들어")).toBe(false);
  });
  it("부르는 꼴과 3인칭 언급을 가른다", () => {
    expect(isVocative("미티야 끼어들지 마")).toBe(true);
    expect(isVocative("저희가 만든 건 AI 팀원, 미티예요.")).toBe(false);
    expect(isVocative("미티는 회의에 들어와요")).toBe(false);
  });
});

describe("설정 명령", () => {
  it("낮추는 말", () => {
    expect(parseSettingsCommand("미티야 끼어들지 마", "high")).toEqual({ intensity: "low", direction: "down" });
    expect(parseSettingsCommand("조용히 해", "mid")).toEqual({ intensity: "low", direction: "down" });
    expect(parseSettingsCommand("좀 덜 끼어들어", "high")).toEqual({ intensity: "mid", direction: "down" });
  });
  it("받아쓰기가 흔들린 '끼어들지 마'도 낮추기로 받는다 (S7 실제 음성: '끼어들지나')", () => {
    for (const t of ["근데 지금 회의 중이니까 미티야 끼어들지나", "끼어들지말", "끼어드지마", "끼어 들지 마", "끼여들지 마", "미띠야 끼어들지 좀 마", "끼어들지 말고 손만 들어"]) {
      expect(parseSettingsCommand(t, "high"), t).toEqual({ intensity: "low", direction: "down" });
      expect(isMeetyCommand(t), t).toBe(true);
    }
  });
  it("'끼어들어'(올리기)는 낮추기로 오해하지 않는다", () => {
    expect(parseSettingsCommand("미티야 다시 끼어들어도 돼", "low")).toEqual({ intensity: "high", direction: "up" });
  });
  it("올리는 말은 up", () => {
    expect(parseSettingsCommand("미티야 적극적으로 해", "low")).toEqual({ intensity: "high", direction: "up" });
  });
  it("이미 그 강도면 없음", () => {
    expect(parseSettingsCommand("끼어들지 마", "low")).toBeNull();
    expect(parseSettingsCommand("영상 순서로 가자", "high")).toBeNull();
  });
});

describe("회의 끝 말", () => {
  it("끝으로 본다", () => {
    for (const t of ["오케이. 오늘은 여기까지.", "오케이 오늘은 여기 까지", "오늘 회의 끝", "이상입니다."]) expect(isEndPhrase(t), t).toBe(true);
  });
  it("끝이 아니다", () => {
    for (const t of ["여기까지가 1단계예요", "그 이상입니다 정말", "감사합니다"]) expect(isEndPhrase(t), t).toBe(false);
  });
});

describe("모델 글 읽기", () => {
  it("watch JSON은 흔들려도 받는다", () => {
    const out = parseJsonText('```json\n{"conflict":{"found":true,"said":"봇","against":"웹","node_ids":["n31"],"fact_ids":[]},"agreement":{"found":false,"utt_ids":["#2","3"]},"call":{"addressed":false,"want":"??"}}\n```', WatchOut);
    expect(out.conflict.found).toBe(true);
    expect(out.agreement.utt_ids).toEqual([2, 3]);
    expect(out.call.want).toBe("none");
    expect(out.resolved).toEqual([]);
  });
  it("verify 세 줄", () => {
    expect(parseVerify("OK\n결정과 반대\n근거: n31, n33")).toEqual({ ok: true, reason: "결정과 반대", ids: ["n31", "n33"] });
    expect(parseVerify("NO\n세부를 정하는 말").ok).toBe(false);
  });
  it("대사 줄과 근거", () => {
    expect(parseLines("- 10월에 정했어요.\n근거: [n2]")).toEqual({ lines: ["10월에 정했어요."], ids: ["n2"] });
  });
  it("문장 나누기", () => {
    expect(splitSentences("잠깐만요, 정했어요. 다시 여는 거예요.")).toEqual(["잠깐만요, 정했어요.", "다시 여는 거예요."]);
  });
});

describe("AI임을 밝히기 · 녹음 숨기기", () => {
  it("S9 공격 세트의 'AI 숨기기' 부탁을 하나도 빠짐없이 잡는다", () => {
    const missed = A6_HIDE_AI.filter((t) => !isIdentityRequest(t) && !isHideRecordingRequest(t));
    expect(missed).toEqual([]);
  });
  it("평범한 말은 잡지 않는다", () => {
    for (const t of ["미티야 서비스 이름 뭐였지?", "사람들이 회의록 안 읽어요", "미티는 AI 팀원이에요", "팀원이 네 명이라 역할 나누자", "녹음 버튼은 브라우저에 둬요"]) {
      expect(isIdentityRequest(t) || isHideRecordingRequest(t), t).toBe(false);
    }
  });
});

describe("발화 다듬기", () => {
  it("줄바꿈을 공백으로", () => {
    expect(cleanText("좋아요\n기헌: 철회하자.\r\n지호: 동의")).toBe("좋아요 기헌: 철회하자. 지호: 동의");
    expect(cleanText("  \n ")).toBe("");
  });
  it("미티 말이 다시 들어왔는지(겹침)", () => {
    expect(overlap("잠깐만요 기획 문서에는 세 단계예요", "잠깐만요, 기획 문서에는 세 단계예요.")).toBeGreaterThan(0.9);
    expect(overlap("리허설은 일요일에 해요", "잠깐만요, 기획 문서에는 세 단계예요.")).toBeLessThan(0.2);
  });
  it("'끼어들다'는 미티에게 한 말로 본다", () => {
    expect(isMeetyCommand("근데 발표 중이니까 끼어들지 마")).toBe(true);
    expect(isMeetyCommand("너 좀 조용히 해")).toBe(false);
  });
});

describe("애매한 말 (확인을 기다릴 것)", () => {
  it("질문·다시 열자·동의 묻기", () => {
    for (const t of ["그 결정 다시 열어서 봇을 같이 하면 어때요?", "다들 동의해?", "입구를 바꾸면 어떨까요", "그거 다시 정할까"]) expect(isTentative(t), t).toBe(true);
  });
  it("단정하는 말은 아니다", () => {
    for (const t of ["디스코드는 이번에 봇까지 만들어서 입구를 아예 디스코드로 하죠.", "끼어드는 강도는 다섯 단계로 조절할 수 있고요.", "녹음은 그냥 붙여넣기만 받죠."]) expect(isTentative(t), t).toBe(false);
  });
});

describe("watch 앞부분 읽기", () => {
  it("node_ids·fact_ids가 다 오면 바로 읽는다", () => {
    expect(earlyConflict('{"conflict":{"found":true,"node_ids":["n31"],"fact_ids":[],"sa')).toEqual({ found: true, node_ids: ["n31"], fact_ids: [] });
    expect(earlyConflict('{"conflict":{"found":false,"node_ids":[],"fact_ids":[]')).toEqual({ found: false, node_ids: [], fact_ids: [] });
  });
  it("아직 덜 왔으면 null", () => {
    expect(earlyConflict('{"conflict":{"found":true,"node_ids":["n31"')).toBeNull();
  });
});

describe("동의하는 말", () => {
  it("받는 말", () => {
    for (const t of ["네, 저는 좋아요.", "조아. 그 순서로 가자", "좋아. 그 순서로 가자.", "그래, 그걸로 하자.", "오케이. 오늘은 여기까지.", "저도 찬성이에요.", "그렇게 하자", "동의해요"]) expect(isAcceptance(t), t).toBe(true);
  });
  it("제안·이유·되묻기는 아니다", () => {
    for (const t of ["그럼 영상은 준영이가 찍는 걸로 하자.", "그래서 봇은 2단계예요.", "그래도 다시 보죠.", "다들 동의해?", "입구는 디스코드로 바꾸자."]) expect(isAcceptance(t), t).toBe(false);
  });
});

describe("말이 안 끝난 것 같은 final", () => {
  it("이음말·조사로 끝나거나 중간에서 잘린 것", () => {
    for (const t of ["디스코드는 이번에 봇까지 만들어서", "그건 했는데", "입구를 아예 디스코드로 하고", "회의 끝나고 정리하는 걸 입구", "보안은 프롬프트에"]) expect(isUnfinished(t), t).toBe(true);
  });
  it("끝난 말", () => {
    for (const t of ["입구를 아예 디스코드로 하죠.", "그게 임팩트 있어요", "좋아, 그 순서로 가자", "세 단계로 하는 거 맞나?", "이상입니다"]) expect(isUnfinished(t), t).toBe(false);
  });
});

describe("미리 만든 말을 확인 전에 꺼내지 않을 말", () => {
  it("안 끝난 말·무언가를 부정하는 말", () => {
    for (const t of ["일반적인 회의를 서머리를 해주거나 하는 기능이 메인이 아닌데", "요약은 메인이 아니에요.", "디스코드 말고 웹으로 하죠.", "녹음 대신 붙여넣기만 받죠.", "그건 이번 범위가 아니고요."]) expect(needsCheck(t), t).toBe(true);
  });
  it("끝났고 부정이 없는 말 (빠른 길)", () => {
    for (const t of ["디스코드는 이번에 봇까지 만들어서 입구를 아예 디스코드로 하죠. 그게 임팩트 있어요.", "녹음은 그냥 붙여넣기만 받죠. 브라우저 녹음은 빼고요.", "끼어드는 강도는 다섯 단계로 조절할 수 있고요.", "리허설은 토요일 오후에 하는 게 낫지 않아요. 일요일은 다들 바쁘대요."]) expect(needsCheck(t), t).toBe(false);
  });
});

describe("맞장구", () => {
  it("짧은 맞장구·진행 말", () => {
    for (const t of ["음, 일단 들어보자.", "네네", "넵", "음…", "오케이", "그렇구나", "어어 계속해", "네, 알겠어요."]) expect(isBackchannel(t), t).toBe(true);
  });
  it("내용이 있는 말은 아니다", () => {
    for (const t of ["아 맞다, 세 단계였지.", "네, 그럼 토요일로 하죠.", "리허설은 토요일 오후에 하는 게 낫지 않아요.", "오케이, 오늘은 여기까지.", "음 그건 좀 아닌 것 같은데"]) expect(isBackchannel(t), t).toBe(false);
  });
});

describe("받아쓰기가 힌트 문장을 뱉은 것", () => {
  it("힌트 문장 그대로·두 번 되풀이는 버리고, 사람이 한 번 소개하는 말은 받는다", () => {
    expect(isHintEcho("이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티. 이 시즌은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티.")).toBe(true);
    expect(isHintEcho("회의 참석자는 기헌, 준영, 그리고 AI 팀원 미티.")).toBe(true);
    expect(isHintEcho("회의에는 AI 팀원 미티도 참석해요.")).toBe(true);
    expect(isHintEcho("저희 팀은 기헌, 준영, 태은, 지호, 그리고 AI 팀원 미티예요.")).toBe(false);
    expect(isHintEcho("미티야, 지금 강도 몇이야?")).toBe(false);
  });
});

describe("여는 말 떼기", () => {
  it("모델이 붙여 온 여는 말을 뗀다", () => {
    expect(stripOpener("잠깐만요, 10월 10일 회의에서 정했어요.")).toBe("10월 10일 회의에서 정했어요.");
    expect(stripOpener("하나만요. 기획 문서에는 세 단계예요.")).toBe("기획 문서에는 세 단계예요.");
    expect(stripOpener("10월 10일 회의에서 정했어요.")).toBe("10월 10일 회의에서 정했어요.");
  });
});

describe("미리 만든 말 읽기", () => {
  it("'id | 문장' 줄", () => {
    const t = parseTemplates("n31 | 잠깐만요, 10월 10일에 웹 중심으로 정했어요.\n- [B-plan-204199#3] | 기획 문서에는 세 단계예요.\n쓸데없는 줄");
    expect([...t]).toEqual([
      ["n31", "잠깐만요, 10월 10일에 웹 중심으로 정했어요."],
      ["B-plan-204199#3", "기획 문서에는 세 단계예요."],
    ]);
  });
});

describe("굴러가는 층", () => {
  const u = (id: number, t1: number): Utt => ({ id, t0: t1 - 1, t1, text: `${id}`, receivedAt: 0 });
  it("2분보다 오래된 것만 요약 후보", () => {
    const utts = [u(1, 10), u(2, 60), u(3, 150), u(4, 200)];
    const { recent, toSummarize } = splitRecent(utts, 0);
    expect(recent.map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(toSummarize.map((x) => x.id)).toEqual([1, 2]);
    expect(splitRecent(utts, 2).recent.map((x) => x.id)).toEqual([3, 4]);
  });
});

describe("대답 글의 근거 id는 소리로 안 읽힌다", async () => {
  const { stripSpokenIds } = await import("../../src/lib/live/meeting");
  it("(n26)·(#52)·(uuid) 빼기, 보통 괄호는 둠", () => {
    expect(stripSpokenIds("화면 설계가 태은 님 할 일로만 있어서(n26), 그 범위에 맞춰요.")).toBe("화면 설계가 태은 님 할 일로만 있어서, 그 범위에 맞춰요.");
    expect(stripSpokenIds("기획 문서(#52, #46)에 있어요.")).toBe("기획 문서에 있어요.");
    expect(stripSpokenIds("회의 3(10월 10일)에서 정했어요.")).toBe("회의 3(10월 10일)에서 정했어요.");
  });
});

describe("소리로 할 대답 길이", async () => {
  const { capSpoken } = await import("../../src/lib/live/meeting");
  it("두 줄 110자 안쪽, 첫 줄이 길면 문장 끝에서 자름", () => {
    expect(capSpoken(["짧아요.", "이것도요."])).toEqual(["짧아요.", "이것도요."]);
    const long = "기록상 슬라이드 초안은 태은님 할 일이고 기헌님은 문제 정의 파트인데, 역할이 겹치는지 먼저 확인해 보세요. 제 생각엔 문제 정의부터 쓰는 게 좋아요, 팀원끼리 예전 결정 이유를 다르게 기억한다는 얘기가 첫 장으로 잘 맞거든요. 이 순서로 가볼까요?";
    expect(capSpoken([long])).toEqual(["기록상 슬라이드 초안은 태은님 할 일이고 기헌님은 문제 정의 파트인데, 역할이 겹치는지 먼저 확인해 보세요."]);
  });
});

describe("부름·설정 꼴 (10/31 WV 채점에서)", async () => {
  const { isCommaCall, parseSettingsCommand } = await import("../../src/lib/live/rules");
  it("'미티 체크리스트 보여줘'는 빠른 부름, '미티 목소리는 후보 몇 개 …'는 아님 · '강도 올려줘'는 설정", () => {
    expect(isCommaCall("미티 체크리스트 보여줘.")).toBe(true);
    expect(isCommaCall("미티, 이거 맞아?")).toBe(true);
    expect(isCommaCall("미티 목소리는 후보 몇 개 들어보고 고르면 될 것 같아요.")).toBe(false);
    expect(parseSettingsCommand("미티야, 강도 올려줘.", "low")).toEqual({ intensity: "high", direction: "up" });
    expect(parseSettingsCommand("참여도 좀 낮춰 줘", "high")).toEqual({ intensity: "low", direction: "down" });
  });
});

describe("첫 구 흘리기", async () => {
  const { firstPhrase } = await import("../../src/lib/live/meeting");
  it("쉼표·물음표 뒤 또는 10자 넘은 어절 경계까지, 짧으면 아직", () => {
    expect(firstPhrase("아 그거요, 준영 님이 찍기로 했어요")).toBe("아 그거요,");
    expect(firstPhrase("시연 영상은 준영 님이 찍기로")).toBe("시연 영상은 준영 님이");
    expect(firstPhrase("시연 영상은")).toBeNull();
  });
});

describe("미티 자기소개 지식 (11/1 기헌)", async () => {
  const { ANSWER_SYSTEM, SOLO_SYSTEM, MEETY_SELF } = await import("../../src/lib/live/prompts");
  const { capSpoken } = await import("../../src/lib/live/meeting");
  it("부름·1:1 대답 둘 다 같은 자기소개를 본다 · 노션은 연결했을 때만 읽고, 웹은 찾아 카드로, 캘린더·GitHub은 아직", () => {
    expect(ANSWER_SYSTEM).toContain(MEETY_SELF);
    expect(SOLO_SYSTEM).toContain(MEETY_SELF);
    expect(MEETY_SELF).not.toMatch(/노션[^\n]*접근하지 못/);
    expect(MEETY_SELF).toContain("노션은 연결했을 때만 읽는다");
    expect(MEETY_SELF).toMatch(/아직 못 하는 것: 캘린더·GitHub/);
    expect(MEETY_SELF).toContain("웹에서 찾아 출처와 함께 화면 카드로");
    expect(MEETY_SELF).not.toMatch(/못 하는 것:[^\n]*웹 검색/);
    for (const s of ["참여도 다이얼 0~10", "조용히 해", "화면에서 한 번 확인", "확정한 것만", "1:1 회의", "등록한 목소리", "AI라는 걸 숨기지 않는다"]) expect(MEETY_SELF).toContain(s);
  });
  it("자기소개 한 줄(100자 안쪽)은 소리 길이 상한에 안 잘린다", () => {
    const line = "저는 회의에 같이 앉는 AI 팀원 미티예요, 지난 결정과 어긋나면 짚고 할 일과 마감을 챙기고 부르면 답해요. 더 궁금한 거 있어요?";
    expect(line.length).toBeLessThanOrEqual(100);
    expect(capSpoken([line])).toEqual([line]);
  });
});

describe("대답 끝에 붙은 근거 줄", () => {
  it("'…돼요. 근거:'·'…요. 근거: n1, f2'는 떼어 내고, 끝에 붙은 '근거:' 뒤에 한글이 오면 대답 속 말로 둔다", () => {
    expect(parseLines("다시 말하게 하려면 화면에서 올려 주시면 돼요. 근거:")).toEqual({ lines: ["다시 말하게 하려면 화면에서 올려 주시면 돼요."], ids: [] });
    expect(parseLines("세 단계예요. 근거: n1, f2")).toEqual({ lines: ["세 단계예요."], ids: ["n1", "f2"] });
    expect(parseLines("첫 줄이에요.\n근거: [n3]")).toEqual({ lines: ["첫 줄이에요."], ids: ["n3"] });
    expect(parseLines("지난번엔 근거: 회의록이라고 했어요.").lines).toEqual(["지난번엔 근거: 회의록이라고 했어요."]);
    expect(parseLines("세 단계예요.\n근거: 지난 회의").lines).toEqual(["세 단계예요."]); // 맨 앞 근거 줄은 전처럼 근거로
  });
});

describe("웹 검색 결과 읽기", async () => {
  const { webResultOf, WEB_SEARCH_COST } = await import("../../src/lib/live/llm");
  const { splitWebQuery, ANSWER_SYSTEM, SOLO_SYSTEM } = await import("../../src/lib/live/prompts");
  it("인용한 출처 먼저(같은 주소 한 번), 그다음 결과 앞쪽 — 셋까지 · 검색 수는 usage에서 · 오류 코드", () => {
    const res = (title: string, url: string) => ({ type: "web_search_result", title, url, encrypted_content: "", page_age: null });
    const msg = {
      usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
      content: [
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
        { type: "web_search_tool_result", tool_use_id: "s1", content: [res("A", "https://a"), res("B", "https://b"), res("C", "https://c"), res("D", "https://d")] },
        { type: "text", text: "답", citations: [{ type: "web_search_result_location", url: "https://c", title: "C", cited_text: "", encrypted_index: "" }, { type: "web_search_result_location", url: "https://c", title: "C", cited_text: "", encrypted_index: "" }] },
      ],
    };
    expect(webResultOf(msg as never)).toEqual({ searches: 1, sources: [{ title: "C", url: "https://c" }, { title: "A", url: "https://a" }, { title: "B", url: "https://b" }] });
    const err = { usage: {}, content: [{ type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }] };
    expect(webResultOf(err as never)).toEqual({ searches: 0, sources: [], error: "max_uses_exceeded" });
    expect(WEB_SEARCH_COST).toBe(0.01);
  });
  it("대답 글의 '웹: 검색어' 줄은 떼어 내 검색어로 · 대답·1:1 지시 둘 다 웹 줄 규칙이 있다", () => {
    expect(splitWebQuery(["한번 찾아볼게요.", "웹: 회의 AI 시장 규모"])).toEqual({ lines: ["한번 찾아볼게요."], query: "회의 AI 시장 규모" });
    expect(splitWebQuery(["세 단계예요."])).toEqual({ lines: ["세 단계예요."] });
    for (const s of [ANSWER_SYSTEM, SOLO_SYSTEM]) expect(s).toContain('"웹: " 뒤에 검색어');
  });
});

describe("웹 받침말 (11/2)", async () => {
  const { isWebAsk, isWebAck, isRecordQuestion } = await import("../../src/lib/live/rules");
  it("웹으로 갈 부름을 알아보고, 대답의 '한번 찾아볼게요.' 줄을 알아본다 · 기록 물음은 기록 쪽", () => {
    for (const s of ["미티야 요즘 회의 AI 시장 규모가 얼마지?", "미티야, 경쟁 서비스 찾아봐.", "미티 그거 검색해 줘"]) expect(isWebAsk(s)).toBe(true);
    expect(isWebAsk("미티야 강도 몇 단계였지?")).toBe(false);
    expect(isRecordQuestion("미티야 시연 영상은 누가 찍기로 했었지?")).toBe(true);
    for (const s of ["한번 찾아볼게요.", "네, 한번 찾아볼게요.", "찾아볼게요"]) expect(isWebAck(s)).toBe(true);
    expect(isWebAck("찾아볼게요, 그건 세 단계예요.")).toBe(false);
  });
});

describe("소리·화면 글에서 기록 id 빼기 (11/2 리허설 '[n6]에서')", async () => {
  const { scrubIds } = await import("../../src/lib/live/meeting");
  const ctx = { nodes: new Map([["n6", {}], ["n12", {}]]), facts: new Map([["doc-abc#3", {}]]) } as never;
  const m = { ctx };
  it("괄호 id는 빼고, 뒤에 조사가 붙으면 '지난 회의'·'자료'로 · 괄호 없는 실제 id도 · 보통 글은 그대로", () => {
    expect(scrubIds(m, "기헌님, 공유 기능은 [n6]에서 첫 버전 포함으로 이미 정했어요.")).toBe("기헌님, 공유 기능은 지난 회의에서 첫 버전 포함으로 이미 정했어요.");
    expect(scrubIds(m, "세 단계예요 [n6, n12].")).toBe("세 단계예요.");
    expect(scrubIds(m, "세 단계예요 (n12)")).toBe("세 단계예요");
    expect(scrubIds(m, "기획 문서(doc-abc#3)에는 세 단계로 되어 있어요.")).toBe("기획 문서에는 세 단계로 되어 있어요.");
    expect(scrubIds(m, "n12에서 정했어요.")).toBe("지난 회의에서 정했어요.");
    expect(scrubIds(m, "[doc-abc#3]에 나와요.")).toBe("자료에 나와요.");
    expect(scrubIds(m, "#52 발화처럼요 (#52)")).toBe("#52 발화처럼요");
    expect(scrubIds(m, "f1 키를 눌러요. 2.3%예요.")).toBe("f1 키를 눌러요. 2.3%예요.");
  });
});

describe("합의 카드 한 줄 (11/2: 제목과 내용이 두 번)", async () => {
  const { cardText } = await import("../../src/lib/live/record");
  it("제목이 내용으로 끝나거나 내용을 품으면 한 번만, 아니면 '제목: 내용'", () => {
    expect(cardText({ title: "모집 예산: 포스터 인쇄 3만 원, 체험 행사 간식 5만 원", to: "포스터 인쇄 3만 원, 체험 행사 간식 5만 원" })).toBe("모집 예산: 포스터 인쇄 3만 원, 체험 행사 간식 5만 원");
    expect(cardText({ title: "포스터 인쇄 3만 원", to: "포스터 인쇄 3만 원" })).toBe("포스터 인쇄 3만 원");
    expect(cardText({ title: "영상", to: "회의 장면 먼저" })).toBe("영상: 회의 장면 먼저");
    expect(cardText({ title: "영상", from: "제품 소개 먼저", to: "회의 장면 먼저" })).toBe("영상: 제품 소개 먼저 → 회의 장면 먼저");
    expect(cardText({ title: "영상: 회의 장면 먼저", from: "제품 소개 먼저", to: "회의 장면 먼저" })).toBe("영상: 제품 소개 먼저 → 회의 장면 먼저");
  });
  it("'얼마로 했었죠?'도 기억 안 나는 물음", async () => {
    const { isKnowledgeGap } = await import("../../src/lib/live/rules");
    expect(isKnowledgeGap("예산은 지난번에 얼마로 했었죠?")).toBe(true);
    expect(isKnowledgeGap("마감은 언제로 정했었지?")).toBe(true);
    expect(isKnowledgeGap("예산은 3만 원으로 했었죠.")).toBe(false);
  });
});

describe("웹 군말·단위 (11/2 S6 상황 5)", async () => {
  const { isWebFiller } = await import("../../src/lib/live/rules");
  const { WEB_SYSTEM } = await import("../../src/lib/live/prompts");
  it("웹으로 갈 때 군말을 알아본다 · 보통 대답은 아님 · 웹 지시에 '단위 바꾼 결론만'", () => {
    for (const s of ["회의 AI 시장 규모는 이 기록에 없어요. 웹에서 찾아볼게요.", "한번 찾아볼게요.", "업계 평균은 자료에 없어요.", "웹에서 찾아볼까요?"]) expect(isWebFiller(s)).toBe(true);
    for (const s of ["세 단계예요.", "기록엔 없는데, 제 생각엔 웹이 먼저예요."]) expect(isWebFiller(s)).toBe(false);
    expect(WEB_SYSTEM).toContain("바꾸는 과정·원래 표기");
  });
});
