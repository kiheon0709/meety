// 파일 넣기 입구(S5 /api/live/docs/upload → saveUpload)로 들어온 pdf·zip이 폴더에서 읽은 자료와 같은 길로
// 사실 → 근거 조각(DB) → 회의 검색 색인까지 가는지. 모델 없이 (줄마다 사실 하나인 가짜 뽑기).
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { embedFacts, getFacts, searchDocs } from "../../src/lib/ingest";
import { setEmbedder, type Embedder } from "../../src/lib/ingest/embed";
import type { Extractor } from "../../src/lib/ingest/extract";
import { docRows, docSources } from "../../src/lib/ingest/sources";
import { saveUpload } from "../../src/lib/integrations/upload";
import { allowedDocIds } from "../../src/lib/live/docs";
import { createSpace } from "../../src/lib/service";
import { hasPdftotext, makeZip } from "./helpers";

const tmp = path.join(process.cwd(), "tests", ".tmp", `upload-index-${process.pid}`);
const prev = { ingest: process.env.GALPI_INGEST_DIR, upload: process.env.GALPI_UPLOAD_DIR };
process.env.GALPI_INGEST_DIR = path.join(tmp, "data", "ingest");
process.env.GALPI_UPLOAD_DIR = path.join(tmp, "data", "uploads");

// 조각마다 첫 의미 있는 줄 둘을 사실로 (pdf 쪽은 길어서 다 넣지 않는다)
const lines: Extractor = async ({ chunks }) => ({
  facts: chunks.flatMap((c, i) =>
    c.text
      .split("\n")
      .map((l) => l.replace(/^[-#\s]+/, "").replace(/\s+/g, " ").trim())
      .filter((l) => l.length >= 4)
      .slice(0, 2)
      .map((l) => ({ chunk: i, kind: "claim" as const, text: l, quote: l, keys: [] })),
  ),
  usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 },
});
let embedded = 0;
const toy: Embedder = {
  model: "toy",
  query: () => new Float32Array([1, 0]),
  passages: async (ts) => ((embedded += ts.length), ts.map(() => new Float32Array([1, 0]))),
};

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  setEmbedder(null);
  embedded = 0;
});
afterAll(() => {
  setEmbedder(undefined);
  process.env.GALPI_INGEST_DIR = prev.ingest;
  process.env.GALPI_UPLOAD_DIR = prev.upload;
});

describe("업로드 → 색인", () => {
  it("zip(노션 내보내기): 안의 md 조각이 근거 조각·사실·검색으로 이어지고, 다른 스페이스 검색엔 없다", async () => {
    const a = createSpace("zip 팀");
    const b = createSpace("남의 팀");
    const zip = makeZip([
      { name: "기획 0123456789abcdef0123456789abcdef.md", text: "# 기획\n\n## 일정\n\n리허설은 11월 1일 저녁이다.\n", deflate: true },
      { name: "회의 규칙 fedcba9876543210fedcba9876543210.md", text: "## 강도\n\n끼어들기 강도는 세 단계다.\n" },
      { name: "그림.png", text: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const info = await saveUpload(a.id, { name: "노션 내보내기.zip", bytes: zip }, { extractor: lines });

    expect(docRows(a.id)).toMatchObject([{ id: info.id, kind: "doc", connector: "upload" }]);
    expect(docSources(a.id, info.id).map((c) => [c.kind, c.loc])).toEqual([
      ["doc_chunk", '기획 · "일정" 절'],
      ["doc_chunk", '회의 규칙 · "강도" 절'],
    ]);
    expect(getFacts(info.id).map((f) => f.loc)).toEqual(['기획 · "일정" 절', '회의 규칙 · "강도" 절']);

    const hit = searchDocs("리허설 언제였지?", 1, { docIds: allowedDocIds(a.id, [info.id]) });
    expect(hit[0].fact).toMatchObject({ docId: info.id, text: "리허설은 11월 1일 저녁이다." });
    expect(allowedDocIds(b.id, [info.id])).toEqual([]);
    // 묶인 자료가 없는 스페이스는 빈 목록 → 결과 없음 (전체 검색으로 새지 않는다)
    expect(searchDocs("리허설 언제였지?", 3, { docIds: allowedDocIds(b.id, [info.id]) })).toEqual([]);
  });

  it.skipIf(!hasPdftotext || !fs.existsSync("docs/멘토링-사전자료-2026-10-25.pdf"))("pdf: 쪽마다 근거 조각, 사실 위치는 'N쪽', 같은 파일을 다시 올리면 조각이 늘지 않는다", async () => {
    const sp = createSpace("pdf 팀");
    const bytes = fs.readFileSync("docs/멘토링-사전자료-2026-10-25.pdf");
    const info = await saveUpload(sp.id, { name: "멘토링 사전자료.pdf", bytes }, { extractor: lines });
    const chunks = docSources(sp.id, info.id);
    expect(chunks.map((c) => c.loc)).toEqual(["1쪽", "2쪽", "3쪽", "4쪽", "5쪽"]);
    expect(chunks.every((c) => c.kind === "doc_chunk" && c.text.length > 0)).toBe(true);
    const facts = getFacts(info.id);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => /^\d+쪽$/.test(f.loc))).toBe(true);
    const f = facts.find((x) => x.text.includes("갈피"))!;
    expect(searchDocs(f.text, 1, { docIds: [info.id] })[0].fact.id).toBe(f.id);

    await saveUpload(sp.id, { name: "멘토링 사전자료.pdf", bytes }, { extractor: lines });
    expect(docSources(sp.id, info.id, { withGone: true })).toHaveLength(5);
  });

  it("올린 자료도 임베딩이 켜져 있으면 같은 길(embedFacts)로 채워진다", async () => {
    setEmbedder(toy);
    const sp = createSpace("임베딩 팀");
    const info = await saveUpload(sp.id, { name: "plan.md", bytes: Buffer.from("# 기획\n\n마감은 11월 2일이다.\n") }, { extractor: lines });
    expect(await embedFacts(info.id)).toBe(1);
    expect(embedded).toBe(1);
    expect(searchDocs("아무 말", 1, { docIds: [info.id] })[0].fact.text).toBe("마감은 11월 2일이다.");
  });
});
