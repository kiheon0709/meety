// 자료 읽기(S4) 설정. 모델 이름은 여기 한 곳에만 둔다.
import path from "node:path";

// 역할: extract — 자료 조각에서 사실 뽑기. S3 라우터가 생기면 이 이름으로 옮긴다.
// 대본·자료 어긋남 미리 보기(scripts/ingest-diff.ts)도 같은 모델을 쓴다.
export const EXTRACT_MODEL = process.env.GALPI_EXTRACT_MODEL || "claude-haiku-5-5";

// 뽑기 지시문을 바꾸면 올린다. 캐시 열쇠(파일 해시 + 모델 + 이 값)에 들어가서 다시 뽑게 된다.
export const EXTRACT_VERSION = 3;

// $/MTok (src/lib/agent.ts PRICES와 같은 값. 그쪽은 내보내지 않아서 비용 계산용으로 복사)
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function costUsd(model: string, input: number, output: number): number {
  const p = PRICES[model] ?? PRICES["claude-haiku-5-5"];
  return (input * p.input + output * p.output) / 1_000_000;
}

// 생성물 위치. 시험은 GALPI_INGEST_DIR로 따로 둔다.
export function dataDir(): string {
  return process.env.GALPI_INGEST_DIR || path.join(process.cwd(), "data", "ingest");
}

// 조각 하나의 최대 길이(글자). 넘으면 단락 경계에서 나눈다.
export const CHUNK_MAX = 2500;
