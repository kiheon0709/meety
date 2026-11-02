// 자료(S4) → 두뇌(S3). 시그니처는 src/lib/live/contract.ts와 같다.
//   listDocs(): DocInfo[]
//   getFacts(docId): DocFact[]
//   searchDocs(query, k?): { fact, score }[]   (opts.docIds로 회의에 고른 자료만 볼 수 있다 — 계약 확장. 로컬 임베딩이 있으면 BM25와 RRF)
//   ingestPath(path): Promise<DocInfo>
// listDocs·getFacts·searchDocs는 data/ingest/를 동기로 읽는다. 모델 호출은 ingestPath만 한다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DocFact, DocInfo } from "@/lib/live/contract";
import { EXTRACT_MODEL, EXTRACT_VERSION } from "./config";
import { extractFacts, modelExtractor, type CheckedFact, type ExtractUsage, type Extractor } from "./extract";
import { readDoc } from "./read";
import { embedder, packVec, unpackVec } from "./embed";
import { embedText, FactIndex, type IngestFact } from "./search";
import { displayPath, docIdFor, fileHash, indexVersion, readCache, readFacts, readIndex, readVecs, saveDoc, writeCache, writeVecs, type VecMap } from "./store";

export function listDocs(): DocInfo[] {
  return Object.values(readIndex())
    .map(({ id, title, path, facts }) => ({ id, title, path, facts }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function getFacts(docId: string): DocFact[] {
  return readFacts(docId);
}

// 검색 색인은 회의가 고른 자료 묶음(docIds)마다 따로 만든다 — 다른 스페이스 자료는 그 색인에 아예 없다 (knowledge-design §2-4).
// 자료가 바뀌거나(index.json, _gen) 사실 임베딩이 새로 생기면 다시 만든다.
const INDEX_CACHE_MAX = 32;
const _indexes = new Map<string, { version: string; index: FactIndex }>();
let _gen = 0;

function factIndex(docIds?: string[]): FactIndex {
  const ids = docIds?.length ? [...new Set(docIds)].sort() : Object.keys(readIndex()).sort();
  const key = docIds?.length ? ids.join("|") : "*";
  const version = `${indexVersion()}:${_gen}`;
  const hit = _indexes.get(key);
  if (hit?.version === version) return hit.index;
  const known = readIndex();
  const present = ids.filter((id) => known[id]);
  const facts = present.flatMap((id) => readFacts(id) as IngestFact[]);
  const emb = embedder();
  const vecs = new Map<string, Float32Array>();
  if (emb) {
    for (const id of present) for (const [fid, x] of Object.entries(readVecs(id, emb.model))) vecs.set(fid, unpackVec(x.v));
    // 임베딩이 없거나 낡은 사실이 있으면 뒤에서 채운다 (이번 검색은 있는 것만으로)
    const stale = present.filter((id) => needsVecs(id, emb.model));
    if (stale.length) void Promise.all(stale.map((id) => embedFacts(id))).catch(() => undefined);
  }
  const index = new FactIndex(facts, vecs);
  _indexes.delete(key);
  _indexes.set(key, { version, index });
  if (_indexes.size > INDEX_CACHE_MAX) _indexes.delete(_indexes.keys().next().value!);
  return index;
}

const vecHash = (f: IngestFact) => crypto.createHash("sha1").update(embedText(f)).digest("hex").slice(0, 16);
function needsVecs(docId: string, model: string): boolean {
  const have = readVecs(docId, model);
  return (readFacts(docId) as IngestFact[]).some((f) => have[f.id]?.h !== vecHash(f));
}

// 사실 임베딩 채우기. 글이 그대로인 사실은 다시 계산하지 않는다. 임베딩을 못 쓰면 0.
const _filling = new Map<string, Promise<number>>();
export function embedFacts(docId: string): Promise<number> {
  const running = _filling.get(docId);
  if (running) return running;
  const job = (async () => {
    const emb = embedder();
    if (!emb) return 0;
    const facts = readFacts(docId) as IngestFact[];
    const have = readVecs(docId, emb.model);
    const todo = facts.filter((f) => have[f.id]?.h !== vecHash(f));
    if (!todo.length) return 0;
    const out = await emb.passages(todo.map(embedText));
    if (!out) return 0;
    const next: VecMap = {};
    for (const f of facts) if (have[f.id]?.h === vecHash(f)) next[f.id] = have[f.id];
    todo.forEach((f, i) => (next[f.id] = { h: vecHash(f), v: packVec(out[i]) }));
    writeVecs(docId, emb.model, next);
    _gen++;
    return todo.length;
  })().finally(() => _filling.delete(docId));
  _filling.set(docId, job);
  return job;
}

// opts.docIds: 회의에 고른 자료만 (빈 목록이면 결과도 없음 — 묶인 자료가 없는 스페이스가 전체를 보지 않게). 없으면 전체(스크립트용).
// 질문 임베딩이 EMBED_WAIT_MS 안에 나오면 BM25와 합치고, 아니면 BM25만.
export function searchDocs(query: string, k = 5, opts: { docIds?: string[] } = {}): { fact: DocFact; score: number }[] {
  if (opts.docIds && !opts.docIds.length) return [];
  const index = factIndex(opts.docIds);
  const qvec = index.vectors ? (embedder()?.query(query) ?? null) : null;
  return index.search(query, k, opts.docIds, qvec);
}

export async function ingestPath(p: string): Promise<DocInfo> {
  return (await ingestFile(p)).info;
}

// 스크립트·시험용: 비용·캐시 여부까지 돌려준다. extractor를 바꿔 끼우면 모델 없이 시험할 수 있다.
export interface IngestResult {
  info: DocInfo;
  facts: IngestFact[];
  cached: boolean;
  usage: ExtractUsage | null;
  quoteFixed: number;
  dropped: number;
  retried: number;
  chunks: number;
}
interface CacheData {
  title: string;
  chunks: number;
  facts: CheckedFact[];
  usage: ExtractUsage;
  quoteFixed: number;
  dropped: number;
  retried?: number;
}

export async function ingestFile(
  p: string,
  opts: { extractor?: Extractor; model?: string; force?: boolean } = {},
): Promise<IngestResult> {
  const abs = path.resolve(p);
  const buf = fs.readFileSync(abs);
  const hash = fileHash(buf);
  const model = opts.model ?? (opts.extractor && opts.extractor !== modelExtractor ? "custom" : EXTRACT_MODEL);
  const rel = displayPath(abs);
  const id = docIdFor(rel);

  const cacheKey = `${model}-v${EXTRACT_VERSION}`;
  let data = opts.force ? null : readCache<CacheData>(hash, cacheKey);
  const cached = !!data;
  if (!data) {
    const doc = readDoc(abs);
    const r = await extractFacts(doc.title, doc.chunks, opts.extractor ?? modelExtractor);
    data = { title: doc.title, chunks: doc.chunks.length, ...r };
    writeCache(hash, cacheKey, data);
  }

  const facts: IngestFact[] = data.facts.map((f, i) => ({ id: `${id}#${i + 1}`, docId: id, ...f }));
  const info: DocInfo = { id, title: data.title, path: rel, facts: facts.length };
  saveDoc({ ...info, hash, kind: path.extname(abs).slice(1).toLowerCase(), model, ingestedAt: new Date().toISOString() }, facts);
  _gen++;
  return { info, facts, cached, usage: cached ? null : data.usage, quoteFixed: data.quoteFixed, dropped: data.dropped, retried: data.retried ?? 0, chunks: data.chunks };
}
