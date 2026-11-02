// 자료(S4 @/lib/ingest)를 회의에 붙이는 곳. 자료는 스페이스에 묶어서만 쓴다:
// 어느 스페이스가 어떤 자료를 쓸 수 있는지는 data/ingest/owners.json에 따로 적는다
// (계약 DocInfo에 spaceId가 없어서 — 계약 변경 제안).
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../ingest/config";
import { getFacts, ingestPath, listDocs, searchDocs } from "../ingest";
import { forgetDoc, recordDoc } from "../ingest/sources";
import type { DocFact, DocInfo } from "./contract";

export { getFacts, listDocs, searchDocs };

const ownersFile = () => path.join(dataDir(), "owners.json");

function readOwners(): Record<string, string[]> {
  try {
    return JSON.parse(fs.readFileSync(ownersFile(), "utf8")) as Record<string, string[]>;
  } catch {
    return {};
  }
}

export function bindDoc(spaceId: string, docId: string) {
  const o = readOwners();
  o[docId] = [...new Set([...(o[docId] ?? []), spaceId])];
  fs.mkdirSync(path.dirname(ownersFile()), { recursive: true });
  fs.writeFileSync(ownersFile(), JSON.stringify(o, null, 1));
  recordDoc(spaceId, docId);
}

// 연결을 끊을 때 (S5 notion.ts): 그 스페이스 묶음에서만 뺀다. 다른 스페이스 묶음은 그대로
export function unbindDoc(spaceId: string, docId: string) {
  const o = readOwners();
  if (!o[docId]) return;
  o[docId] = o[docId].filter((s) => s !== spaceId);
  if (!o[docId].length) delete o[docId];
  fs.writeFileSync(ownersFile(), JSON.stringify(o, null, 1));
  forgetDoc(spaceId, docId);
}

// 그 스페이스 묶음을 keep만 남기고 푼다 (scripts/live-docs.ts --replace). 푼 docId를 돌려준다.
// 원본 DB를 복사한 회의에 예전 묶음(시험용 가짜 기획·옛 기획)이 따라와 근거가 되는 걸 막는다.
export function keepOnlyDocs(spaceId: string, keep: string[]): string[] {
  const o = readOwners();
  const drop = Object.keys(o).filter((id) => o[id].includes(spaceId) && !keep.includes(id));
  for (const id of drop) unbindDoc(spaceId, id);
  return drop;
}

export function docsForSpace(spaceId: string): DocInfo[] {
  const o = readOwners();
  return listDocs().filter((d) => o[d.id]?.includes(spaceId));
}

// 회의가 요청한 docIds 중 그 스페이스 자료만 남긴다
export function allowedDocIds(spaceId: string, docIds: string[]): string[] {
  const mine = new Set(docsForSpace(spaceId).map((d) => d.id));
  return docIds.filter((id) => mine.has(id));
}

// 회의 시작 때 자료를 다시 읽어 둔다 (같은 내용이면 캐시라 비용 0). 바뀐 파일을 다시 뽑느라 오래 걸리면 기다리지 않는다.
export async function refreshDocs(docIds: string[], waitMs = 3000): Promise<void> {
  const byId = new Map(listDocs().map((d) => [d.id, d]));
  const jobs = docIds
    .map((id) => byId.get(id)?.path)
    .filter((p): p is string => !!p && fs.existsSync(path.resolve(p)))
    .map((p) => ingestPath(p).catch(() => undefined));
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, waitMs))]);
}

// 사실이 많으면 고정 층에 다 넣지 않고 발화마다 찾는다
export const FIXED_FACTS_MAX = 80;

export function factsFor(docIds: string[]): DocFact[] {
  return docIds.flatMap((id) => getFacts(id));
}

export function searchFacts(text: string, docIds: string[], k = 3): DocFact[] {
  if (!docIds.length) return [];
  return searchDocs(text, k, { docIds }).map((r) => r.fact);
}
