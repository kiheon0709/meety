// 파일 넣기 입구 (연동 1번). 회의 시작 화면에서 올린 md·txt·pdf·zip을 그 스페이스 자료로 읽어 묶는다.
//   저장: data/uploads/<spaceId>/<sha256 앞 8자>-<이름>.<확장자> (S4 knowledge-design §3-2 자리)
//   읽기·사실 뽑기는 S4 ingestFile, 묶기는 bindDoc 그대로. 같은 내용이면 뽑기 캐시라 비용 0.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DocInfo } from "@/lib/live/contract";
import { ingestFile } from "@/lib/ingest";
import { dataDir } from "@/lib/ingest/config";
import type { Extractor } from "@/lib/ingest/extract";
import { bindDoc } from "@/lib/live/docs";

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_EXTS = [".md", ".markdown", ".txt", ".pdf", ".zip"] as const;

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function uploadsDir(): string {
  return process.env.GALPI_UPLOAD_DIR || path.join(path.dirname(dataDir()), "uploads");
}

// 스페이스 id는 경로에 들어가므로 글자를 좁힌다 (../ 같은 것 막기)
const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// 확장자와 내용이 맞는지: pdf는 %PDF-, zip은 PK\3\4, 글은 UTF-8이고 NUL이 없어야 한다
function checkContent(ext: string, buf: Buffer): void {
  if (ext === ".pdf") {
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new UploadError("PDF 파일이 아니에요");
    return;
  }
  if (ext === ".zip") {
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new UploadError("zip 파일이 아니에요");
    return;
  }
  if (buf.includes(0)) throw new UploadError("글 파일이 아니에요");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new UploadError("UTF-8 글 파일만 받아요");
  }
}

// 사람이 준 파일 이름에서 확장자와 보여 줄 이름만 남긴다. 경로 조각은 버린다.
export function safeName(name: string): { base: string; ext: string } {
  const just = path.basename(name.replace(/\\/g, "/")).normalize("NFC");
  const ext = path.extname(just).toLowerCase();
  const base = path
    .basename(just, path.extname(just))
    .replace(/[^\p{L}\p{N}_ -]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return { base: base || "자료", ext };
}

export async function saveUpload(
  spaceId: string,
  file: { name: string; bytes: Buffer },
  opts: { extractor?: Extractor } = {},
): Promise<DocInfo> {
  if (!SPACE_ID.test(spaceId)) throw new UploadError("프로젝트를 알 수 없어요");
  const { base, ext } = safeName(file.name);
  if (!(UPLOAD_EXTS as readonly string[]).includes(ext)) throw new UploadError(`md·txt·pdf·zip만 받아요 (${ext || "확장자 없음"})`);
  if (file.bytes.length === 0) throw new UploadError("빈 파일이에요");
  if (file.bytes.length > UPLOAD_MAX_BYTES) throw new UploadError("10MB까지 받아요", 413);
  checkContent(ext, file.bytes);

  const dir = path.join(uploadsDir(), spaceId);
  const sha = crypto.createHash("sha256").update(file.bytes).digest("hex").slice(0, 8);
  const dest = path.join(dir, `${sha}-${base}${ext}`);
  // 만든 경로가 스페이스 폴더 밖이면 멈춘다 (위 거르기를 넘어도 한 번 더)
  if (path.relative(dir, dest).startsWith("..")) throw new UploadError("파일 이름이 이상해요");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, file.bytes, { mode: 0o600 });

  let info: DocInfo;
  try {
    info = (await ingestFile(dest, { extractor: opts.extractor })).info;
  } catch (e) {
    throw new UploadError(`파일을 읽지 못했어요: ${(e as Error).message}`, 422);
  }
  bindDoc(spaceId, info.id);
  return info;
}
