// 회의 자료 목록을 바꿀 때 (scripts/live-docs.ts --replace): 목록에서 빠진 예전 묶음은 풀리고, 그 사실은 회의 검색·고정 층에 안 섞인다.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ingestFile, searchDocs } from "../../src/lib/ingest";
import type { Extractor } from "../../src/lib/ingest/extract";
import { docRows } from "../../src/lib/ingest/sources";
import { allowedDocIds, bindDoc, docsForSpace, factsFor, keepOnlyDocs } from "../../src/lib/live/docs";
import { createSpace } from "../../src/lib/service";

const tmp = path.join(process.cwd(), "tests", ".tmp", `replace-${process.pid}`);
const prev = process.env.GALPI_INGEST_DIR;

const lines: Extractor = async ({ chunks }) => ({
  facts: chunks.flatMap((c, i) => c.text.split("\n").map((l) => l.replace(/^[-#\s]+/, "").trim()).filter(Boolean).map((l) => ({ chunk: i, kind: "decision" as const, text: l, quote: l, keys: [] }))),
  usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 },
});
async function doc(name: string, body: string) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return (await ingestFile(file, { extractor: lines })).info.id;
}

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  process.env.GALPI_INGEST_DIR = path.join(tmp, "data");
});
afterAll(() => {
  process.env.GALPI_INGEST_DIR = prev;
});

describe("자료 목록 바꾸기 (--replace)", () => {
  it("목록에 없는 예전 묶음은 풀리고, 사실 JSON이 남아 있어도 회의 검색·고정 층에 안 나온다", async () => {
    const sp = createSpace("시연 팀");
    const other = createSpace("다른 팀");
    const fake = await doc("B-plan.md", "# 가짜 기획\n\n시연 마감은 11월 9일이다.\n");
    const old = await doc("current-plan.md", "# 옛 기획\n\n미티는 회의 중에 끼어들지 않는다.\n");
    const plan = await doc("meety-plan.md", "# 미티 기획\n\n제출 마감은 11월 2일이다.\n");
    for (const id of [fake, old]) bindDoc(sp.id, id); // 원본 DB에서 따라온 예전 묶음
    bindDoc(other.id, fake);

    bindDoc(sp.id, plan); // 이번 목록
    expect(keepOnlyDocs(sp.id, [plan]).sort()).toEqual([fake, old].sort());

    expect(docsForSpace(sp.id).map((d) => d.id)).toEqual([plan]);
    expect(docsForSpace(other.id).map((d) => d.id)).toEqual([fake]); // 다른 스페이스 묶음은 그대로
    expect(docRows(sp.id).filter((r) => r.status === "active").map((r) => r.id)).toEqual([plan]);

    // 화면이 예전 목록을 그대로 보내도(시작 요청 docIds) 두뇌가 쓰는 건 묶인 것뿐
    const docIds = allowedDocIds(sp.id, [fake, old, plan]);
    expect(docIds).toEqual([plan]);
    expect(factsFor(docIds).map((f) => f.text)).toEqual(["제출 마감은 11월 2일이다."]);
    const hits = searchDocs("시연 마감 11월 9일 회의 중에 끼어들지", 5, { docIds });
    expect(hits.map((h) => h.fact.docId)).toEqual([plan]);
    // 사실 JSON은 남아 있다 (지우지 않음) — 전체 검색(스크립트용)에선 보임
    expect(searchDocs("시연 마감은 11월 9일", 1)[0].fact.docId).toBe(fake);

    expect(keepOnlyDocs(sp.id, [plan])).toEqual([]); // 두 번 해도 그대로
  });
});
