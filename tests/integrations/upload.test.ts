// 파일 넣기 입구 (S5 연동 1번) — 모델 없이 가짜 뽑기로.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Extractor } from "../../src/lib/ingest/extract";
import { getFacts } from "../../src/lib/ingest";
import { saveUpload, safeName, UPLOAD_MAX_BYTES, uploadsDir } from "../../src/lib/integrations/upload";
import { allowedDocIds, docsForSpace } from "../../src/lib/live/docs";
import { createSpace } from "../../src/lib/service";

const tmp = path.join(process.cwd(), "tests", ".tmp", `upload-${process.pid}`);
process.env.GALPI_INGEST_DIR = path.join(tmp, "data", "ingest");
process.env.GALPI_UPLOAD_DIR = path.join(tmp, "data", "uploads");

let calls = 0;
const lines: Extractor = async ({ chunks }) => {
  calls++;
  const facts = chunks.flatMap((c, i) =>
    c.text
      .split("\n")
      .map((l) => l.replace(/^[-#\s]+/, "").trim())
      .filter(Boolean)
      .map((l) => ({ chunk: i, kind: "claim" as const, text: l, quote: l, keys: [] })),
  );
  return { facts, usage: { model: "fake", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0, calls: 1 } };
};

const md = (s: string) => Buffer.from(s, "utf8");

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  calls = 0;
});

describe("파일 넣기", () => {
  it("올린 md를 읽어 사실로 만들고 그 스페이스에만 묶는다", async () => {
    const a = createSpace("올린 팀");
    const b = createSpace("다른 팀");
    const doc = await saveUpload(a.id, { name: "기획서.md", bytes: md("# 기획\n\n입구는 웹으로 간다.\n") }, { extractor: lines });
    expect(doc.facts).toBeGreaterThan(0);
    expect(getFacts(doc.id).map((f) => f.text)).toContain("입구는 웹으로 간다.");
    expect(docsForSpace(a.id).map((d) => d.id)).toEqual([doc.id]);
    expect(docsForSpace(b.id)).toEqual([]);
    expect(allowedDocIds(b.id, [doc.id])).toEqual([]);
    expect(fs.readdirSync(path.join(uploadsDir(), a.id))).toHaveLength(1);
  });

  it("같은 파일을 두 스페이스가 올리면 자료가 따로 생기고, 뽑기는 캐시로 한 번만", async () => {
    const a = createSpace("A");
    const b = createSpace("B");
    const bytes = md("# 같은 문서\n\n마감은 금요일.\n");
    const da = await saveUpload(a.id, { name: "plan.md", bytes }, { extractor: lines });
    const db = await saveUpload(b.id, { name: "plan.md", bytes }, { extractor: lines });
    expect(da.id).not.toBe(db.id);
    expect(calls).toBe(1);
    expect(allowedDocIds(a.id, [db.id])).toEqual([]);
  });

  it.each([
    ["확장자", "run.sh", md("echo hi"), /md·txt·pdf·zip/],
    ["빈 파일", "a.md", Buffer.alloc(0), /빈 파일/],
    ["pdf가 아닌 pdf", "fake.pdf", md("not a pdf"), /PDF/],
    ["zip이 아닌 zip", "fake.zip", md("hello"), /zip/],
    ["NUL 섞인 글", "bin.txt", Buffer.from([0x41, 0x00, 0x42]), /글 파일/],
    ["UTF-8 아님", "euc.txt", Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), /UTF-8/],
  ])("거절: %s", async (_label, name, bytes, msg) => {
    const a = createSpace("A");
    await expect(saveUpload(a.id, { name, bytes }, { extractor: lines })).rejects.toThrow(msg);
    expect(docsForSpace(a.id)).toEqual([]);
  });

  it("10MB 넘으면 413", async () => {
    const a = createSpace("A");
    const big = Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x61);
    await expect(saveUpload(a.id, { name: "big.txt", bytes: big }, { extractor: lines })).rejects.toMatchObject({ status: 413 });
  });

  it("파일 이름의 경로 조각·이상한 스페이스 id로 폴더 밖에 못 쓴다", async () => {
    expect(safeName("../../etc/passwd.md")).toEqual({ base: "passwd", ext: ".md" });
    expect(safeName("..\\..\\x.md").base).toBe("x");
    await expect(saveUpload("../evil", { name: "a.md", bytes: md("# a\n\nb\n") }, { extractor: lines })).rejects.toThrow(/프로젝트/);
    const a = createSpace("A");
    await saveUpload(a.id, { name: "../../../escape.md", bytes: md("# a\n\nb\n") }, { extractor: lines });
    expect(fs.existsSync(path.join(tmp, "escape.md"))).toBe(false);
    expect(fs.readdirSync(path.join(uploadsDir(), a.id))[0]).toMatch(/^[0-9a-f]{8}-escape\.md$/);
  });

  it("업로드 라우트는 스페이스 권한을 확인한다", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/live/docs/upload/route.ts"), "utf8");
    expect(route).toMatch(/canAccessSpace\(spaceId\)/);
    expect(route.indexOf("canAccessSpace")).toBeLessThan(route.indexOf("saveUpload(spaceId"));
  });
});
