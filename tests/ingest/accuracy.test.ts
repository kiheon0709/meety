import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { FactIndex } from "../../src/lib/ingest/search";
import type { IngestFact } from "../../src/lib/ingest/search";
import { FIXTURE, QUERIES, isAnswer, type Query } from "./queries";

const facts: IngestFact[] = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const index = new FactIndex(facts);
const rank = (x: Query) => index.search(x.q, 3).findIndex((r) => isAnswer(x, r.fact.text)) + 1;

describe("다음 회의 발언 30개 → 지금 기획 사실 (상위 3개)", () => {
  for (const x of QUERIES) {
    const name = `${x.conflict ? "[어긋남] " : ""}${x.noisy ? "[흔들림] " : ""}${x.q}`;
    // miss: 못 찾는 걸 알고 있는 것. 찾게 되면 이 시험이 실패해서 알려 준다.
    (x.miss ? it.fails : it)(name, () => expect(rank(x)).toBeGreaterThan(0));
  }

  it("정확도: 전체 29/30 이상, 어긋나는 발언 9/10 이상", () => {
    const hit = QUERIES.filter((x) => rank(x) > 0);
    expect(QUERIES).toHaveLength(30);
    expect(QUERIES.filter((x) => x.conflict)).toHaveLength(10);
    expect(hit.length).toBeGreaterThanOrEqual(29);
    expect(hit.filter((x) => x.conflict).length).toBeGreaterThanOrEqual(9);
  });
});
