// data/ingest/ 아래 생성물 읽고 쓰기.
//   index.json            문서 목록 (DocInfo + 해시)
//   docs/<docId>.json     문서별 사실
//   cache/<해시>-<모델>-v<지시문 버전>.json  뽑기 결과 캐시 (같은 내용의 파일은 모델을 다시 부르지 않는다)
//   vec/<임베딩 모델>/<docId>.json  사실 임베딩 (사실 글 해시 → base64 Float32). 글이 바뀐 사실만 다시 계산
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DocFact, DocInfo } from "@/lib/live/contract";
import { dataDir } from "./config";

export interface IndexEntry extends DocInfo {
  hash: string;
  kind: string;
  model: string;
  ingestedAt: string;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

const indexFile = () => path.join(dataDir(), "index.json");
const docFile = (docId: string) => path.join(dataDir(), "docs", `${docId}.json`);
const cacheFile = (hash: string, key: string) => path.join(dataDir(), "cache", `${hash.slice(0, 24)}-${key}.json`);

export function readIndex(): Record<string, IndexEntry> {
  return readJson<{ docs: Record<string, IndexEntry> }>(indexFile(), { docs: {} }).docs;
}

// 다른 프로세스가 새로 읽었는지 알아보는 값 (검색 색인 다시 만들기 판단)
export function indexVersion(): string {
  try {
    const st = fs.statSync(indexFile());
    return `${dataDir()}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${dataDir()}:none`;
  }
}

export function readFacts(docId: string): DocFact[] {
  return readJson<{ facts: DocFact[] }>(docFile(docId), { facts: [] }).facts;
}

export function saveDoc(entry: IndexEntry, facts: DocFact[]) {
  writeJson(docFile(entry.id), { info: entry, facts });
  const docs = readIndex();
  docs[entry.id] = entry;
  writeJson(indexFile(), { docs });
}

const vecFile = (docId: string, model: string) => path.join(dataDir(), "vec", model.replace(/[^\w.-]+/g, "_"), `${docId}.json`);
export type VecMap = Record<string, { h: string; v: string }>; // factId → { 사실 글 해시, base64 벡터 }
export function readVecs(docId: string, model: string): VecMap {
  return readJson<VecMap>(vecFile(docId, model), {});
}
export function writeVecs(docId: string, model: string, vecs: VecMap) {
  writeJson(vecFile(docId, model), vecs);
}

export function readCache<T>(hash: string, key: string): T | null {
  return readJson<T | null>(cacheFile(hash, key), null);
}
export function writeCache(hash: string, key: string, data: unknown) {
  writeJson(cacheFile(hash, key), data);
}

export function fileHash(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// 같은 경로면 늘 같은 id: 파일 이름 + 경로 해시 6자리. 예: "B-plan-3f2a1c"
export function docIdFor(relPath: string): string {
  const base = path
    .basename(relPath, path.extname(relPath))
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const h = crypto.createHash("sha1").update(relPath.normalize("NFC")).digest("hex").slice(0, 6);
  return `${base || "doc"}-${h}`;
}

// 저장소 안 파일은 상대 경로로 남긴다 (워크트리·기계가 바뀌어도 id가 같게)
export function displayPath(abs: string): string {
  const rel = path.relative(process.cwd(), abs);
  return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs).normalize("NFC");
}
