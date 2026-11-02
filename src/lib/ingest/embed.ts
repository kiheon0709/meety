// 로컬 임베딩 (knowledge-design §2-2). multilingual-e5-small(ONNX 8비트, 약 120MB)을 이 기기에서 돌린다 — 자료가 밖으로 안 나간다.
// 회의 중 검색(searchDocs)은 동기 함수라, 질문 한 문장은 워커가 계산하고 여기서 Atomics.wait로 EMBED_WAIT_MS까지 기다린다.
// 패키지(@huggingface/transformers, optionalDependencies)나 모델이 없거나, 아직 올리는 중이거나, 늦으면 null → BM25만.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { dataDir } from "./config";

export const EMBED_MODEL = "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;
// 질문 한 문장 기다리는 상한. M-시리즈 맥에서 p50 1.9ms·p95 3.4ms [측정 2026-10-30] — 넘으면 이번 검색은 BM25만
export const EMBED_WAIT_MS = 50;

export interface Embedder {
  model: string;
  query(text: string): Float32Array | null; // 동기. 못 하면 null
  passages(texts: string[]): Promise<Float32Array[] | null>;
}

let current: Embedder | null | undefined;

// 시험은 가짜를 끼운다. null이면 임베딩을 끈다.
export function setEmbedder(e: Embedder | null | undefined) {
  current = e;
}

declare global {
  var __galpiEmbedder: Embedder | undefined;
}

export function embedder(): Embedder | null {
  if (current !== undefined) return current;
  // 끔: GALPI_EMBED=0, 시험(모델을 내려받지 않게). 개발 서버가 모듈을 다시 올려도 워커(모델 약 200MB)는 하나만
  current = process.env.GALPI_EMBED === "0" || process.env.VITEST ? null : (globalThis.__galpiEmbedder ??= workerEmbedder());
  return current;
}

export const modelsDir = () => process.env.GALPI_MODELS_DIR || path.join(path.dirname(dataDir()), "models");

// 워커 코드는 글로 넘긴다 — Next 번들러가 패키지를 묶으려 들지 않게 (패키지가 없으면 워커가 error를 보내고 끝)
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const pipe = (async () => {
  const t = await import("@huggingface/transformers");
  t.env.cacheDir = workerData.cacheDir;
  return t.pipeline("feature-extraction", workerData.model, { dtype: "q8" });
})();
pipe.then(() => parentPort.postMessage({ type: "ready" }), (e) => parentPort.postMessage({ type: "error", message: String((e && e.message) || e) }));
parentPort.on("message", async (m) => {
  let data = null;
  try {
    const out = await (await pipe)(m.texts, { pooling: "mean", normalize: true });
    data = out.data;
  } catch {}
  if (m.sab) {
    const flag = new Int32Array(m.sab, 0, 1);
    if (data) new Float32Array(m.sab, 4, workerData.dim).set(data.subarray(0, workerData.dim));
    Atomics.store(flag, 0, data ? 1 : 2);
    Atomics.notify(flag, 0);
  } else parentPort.postMessage({ id: m.id, data });
});
`;

function workerEmbedder(): Embedder {
  let worker: Worker | null = null;
  let state: "off" | "loading" | "ready" | "failed" = "off";
  let ready: Promise<boolean> = Promise.resolve(false);
  let seq = 0;
  const waiting = new Map<number, (d: Float32Array | null) => void>();

  const start = () => {
    if (state !== "off") return;
    state = "loading";
    fs.mkdirSync(modelsDir(), { recursive: true });
    worker = new Worker(WORKER, { eval: true, workerData: { model: EMBED_MODEL, dim: EMBED_DIM, cacheDir: modelsDir() } });
    worker.unref(); // 검색 워커 때문에 프로세스가 안 끝나는 일이 없게
    ready = new Promise((resolve) => {
      worker!.on("message", (m: { type?: string; message?: string; id?: number; data?: Float32Array | null }) => {
        if (m.type === "ready") {
          state = "ready";
          resolve(true);
        } else if (m.type === "error") {
          state = "failed";
          console.warn(`로컬 임베딩을 못 켜서 낱말 검색만 써요: ${m.message}`);
          resolve(false);
        } else if (m.id !== undefined) {
          waiting.get(m.id)?.(m.data ?? null);
          waiting.delete(m.id);
        }
      });
      worker!.on("error", (e) => {
        state = "failed";
        console.warn(`로컬 임베딩 워커가 멈춰서 낱말 검색만 써요: ${e.message}`);
        resolve(false);
      });
      // 워커가 끝나면 기다리던 것을 모두 null로 (영영 기다리지 않게)
      worker!.on("exit", () => {
        state = "failed";
        resolve(false);
        for (const done of waiting.values()) done(null);
        waiting.clear();
      });
    });
  };

  return {
    model: EMBED_MODEL,
    query(text) {
      start();
      if (state !== "ready" || !worker) return null;
      const sab = new SharedArrayBuffer(4 + EMBED_DIM * 4);
      const flag = new Int32Array(sab, 0, 1);
      worker.postMessage({ texts: [`query: ${text}`], sab });
      // 늦으면 이 버퍼는 버린다 (워커가 나중에 써도 아무도 안 읽음)
      if (Atomics.wait(flag, 0, 0, EMBED_WAIT_MS) === "timed-out" || Atomics.load(flag, 0) !== 1) return null;
      return new Float32Array(sab, 4, EMBED_DIM).slice();
    },
    async passages(texts) {
      start();
      if (!(await ready) || !worker || !texts.length) return texts.length ? null : [];
      const id = ++seq;
      const data = await new Promise<Float32Array | null>((resolve) => {
        waiting.set(id, resolve);
        worker!.postMessage({ id, texts: texts.map((t) => `passage: ${t}`) });
      });
      if (!data) return null;
      return texts.map((_, i) => data.slice(i * EMBED_DIM, (i + 1) * EMBED_DIM));
    },
  };
}

// 저장용: Float32 → base64
export const packVec = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
export const unpackVec = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
