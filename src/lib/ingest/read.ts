// 파일을 읽어 위치(loc)가 붙은 조각으로 나눈다. 원본은 읽기만 한다.
//   .md·.txt → 그대로, .pdf → pdftotext -layout (쪽마다), .zip → 안의 md·txt (노션 내보내기)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { CHUNK_MAX } from "./config";

export interface Chunk {
  loc: string; // "끼어들기 강도" 절, 3쪽
  text: string;
}
export interface ReadDoc {
  title: string;
  kind: "md" | "txt" | "pdf" | "zip";
  chunks: Chunk[];
}

export function readDoc(file: string): ReadDoc {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, ext).normalize("NFC");
  if (ext === ".md" || ext === ".markdown") {
    const { title, chunks } = splitMarkdown(fs.readFileSync(file, "utf8"));
    return { title: title ?? base, kind: "md", chunks };
  }
  if (ext === ".txt") return { title: base, kind: "txt", chunks: splitText(fs.readFileSync(file, "utf8")) };
  if (ext === ".pdf") {
    const pages = pdfPages(file);
    const firstLine = pages[0]?.split("\n").find((l) => l.trim())?.trim();
    return { title: firstLine?.slice(0, 80) || base, kind: "pdf", chunks: splitPages(pages) };
  }
  if (ext === ".zip") return { title: base, kind: "zip", chunks: zipChunks(fs.readFileSync(file)) };
  throw new Error(`읽을 수 없는 파일 형식이에요: ${ext || "(확장자 없음)"}`);
}

// ── markdown ─────────────────────────────────────────────

// 제목(#~###)으로 절을 나눈다. 코드 블록 안의 #은 제목이 아니다.
// loc은 H1(문서 제목)을 뺀 제목 경로: "끼어들기 강도" 절, "작업 패키지 > P0" 절. 첫 제목 전은 "첫머리".
export function splitMarkdown(src: string): { title: string | null; chunks: Chunk[] } {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let title: string | null = null;
  const stack: { level: number; text: string }[] = [];
  const sections: { path: string[]; lines: string[] }[] = [];
  let cur: { path: string[]; lines: string[] } = { path: [], lines: [] };
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const level = m[1].length;
      const text = m[2].trim();
      if (level === 1 && title === null) {
        title = text;
        continue;
      }
      sections.push(cur);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
      cur = { path: stack.map((s) => s.text), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  sections.push(cur);

  const chunks: Chunk[] = [];
  for (const s of sections) {
    const body = s.lines.join("\n").trim();
    if (!body) continue;
    const loc = s.path.length ? `"${s.path.join(" > ")}" 절` : "첫머리";
    const head = s.path.length ? `## ${s.path.join(" > ")}\n` : "";
    const parts = splitBySize(body);
    parts.forEach((p, i) => chunks.push({ loc: parts.length > 1 ? `${loc} (${i + 1}/${parts.length})` : loc, text: head + p }));
  }
  return { title, chunks };
}

// ── txt ──────────────────────────────────────────────────

export function splitText(src: string): Chunk[] {
  const paras = src.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let start = 1;
  const flush = (end: number) => {
    if (!buf.length) return;
    chunks.push({ loc: start === end ? `${start}번째 단락` : `${start}~${end}번째 단락`, text: buf.join("\n\n") });
    buf = [];
  };
  paras.forEach((p, i) => {
    if (buf.length && buf.join("\n\n").length + p.length > CHUNK_MAX) {
      flush(i);
      start = i + 1;
    }
    buf.push(p.length > CHUNK_MAX ? p.slice(0, CHUNK_MAX) : p);
  });
  flush(paras.length);
  return chunks;
}

// ── pdf ──────────────────────────────────────────────────

function pdfPages(file: string): string[] {
  let out: string;
  try {
    out = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new Error("pdftotext가 없어요. `brew install poppler`로 설치해 주세요.");
    throw e;
  }
  const pages = out.split("\f");
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  return pages;
}

// 표 칸을 맞추느라 생긴 긴 공백은 두 칸으로 줄인다 (모델 입력 줄이기).
export function splitPages(pages: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  pages.forEach((raw, i) => {
    const text = raw
      .split("\n")
      .map((l) => l.replace(/\s{3,}/g, "  ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return;
    const parts = splitBySize(text);
    parts.forEach((p, j) => chunks.push({ loc: parts.length > 1 ? `${i + 1}쪽 (${j + 1}/${parts.length})` : `${i + 1}쪽`, text: p }));
  });
  return chunks;
}

// ── zip (노션 내보내기) ───────────────────────────────────

// zip 폭탄 막기 (S5 업로드 입구): 항목 하나·zip 전체(안에 든 zip까지 합쳐)를 풀었을 때 크기와 항목 수에 상한.
// 넘으면 그 파일은 읽지 않는다.
const ZIP_ENTRY_MAX = 50 * 1024 * 1024;
export const ZIP_TOTAL_MAX = 100 * 1024 * 1024;
export const ZIP_ENTRIES_MAX = 2000;
export interface ZipBudget {
  bytes: number; // 남은 풀 수 있는 바이트
  entries: number; // 남은 항목 수
}
const newBudget = (): ZipBudget => ({ bytes: ZIP_TOTAL_MAX, entries: ZIP_ENTRIES_MAX });

// 노션은 파일 이름 끝에 " 0123abcd…"(32자리 16진수)를 붙인다. 위치 표시에서는 뗀다.
function notionName(entry: string): string {
  return path
    .basename(entry, path.extname(entry))
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .normalize("NFC");
}

export function zipChunks(buf: Buffer, depth = 0, budget: ZipBudget = newBudget()): Chunk[] {
  const chunks: Chunk[] = [];
  for (const e of readZip(buf, budget).sort((a, b) => a.name.localeCompare(b.name))) {
    const ext = path.extname(e.name).toLowerCase();
    if (ext === ".zip" && depth < 2) {
      chunks.push(...zipChunks(e.data(), depth + 1, budget)); // 안에 든 zip도 같은 예산에서 뺀다
      continue;
    }
    if (ext !== ".md" && ext !== ".txt") continue;
    const page = notionName(e.name);
    const src = e.data().toString("utf8");
    const parts = ext === ".md" ? splitMarkdown(src).chunks : splitText(src);
    for (const c of parts) chunks.push({ loc: `${page} · ${c.loc}`, text: c.text });
  }
  return chunks;
}

// 의존성 없이 쓰는 최소 zip 읽기 (보관·deflate만, zip64는 안 됨).
function readZip(buf: Buffer, budget: ZipBudget): { name: string; data: () => Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 파일이 아니거나 망가졌어요");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("너무 큰 zip(zip64)은 아직 못 읽어요");
  budget.entries -= count;
  if (budget.entries < 0) throw new Error(`zip 안 파일이 너무 많아요 (모두 ${ZIP_ENTRIES_MAX}개까지)`);
  const entries: { name: string; data: () => Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 목록을 읽지 못했어요");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    // 이름은 UTF-8로 읽는다 (노션·맥 zip은 UTF-8 표시가 없어도 보통 UTF-8)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    entries.push({
      name,
      data: () => {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + csize);
        const limit = Math.min(ZIP_ENTRY_MAX, budget.bytes);
        if (limit <= 0) throw new Error("zip을 풀면 너무 커요");
        let out: Buffer;
        if (method === 0) out = Buffer.from(raw);
        else if (method === 8) {
          try {
            out = zlib.inflateRawSync(raw, { maxOutputLength: limit });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) throw new Error("zip을 풀면 너무 커요");
            throw e;
          }
        } else throw new Error(`zip 압축 방식 ${method}은 못 읽어요: ${name}`);
        if (out.length > limit) throw new Error("zip을 풀면 너무 커요");
        budget.bytes -= out.length;
        return out;
      },
    });
  }
  return entries;
}

// ── 공용 ─────────────────────────────────────────────────

// CHUNK_MAX를 넘으면 빈 줄(단락) 경계에서 나눈다. 단락 하나가 넘으면 줄 경계에서.
function splitBySize(text: string): string[] {
  if (text.length <= CHUNK_MAX) return [text];
  const units = text.split(/\n\s*\n/).flatMap((u) => (u.length > CHUNK_MAX ? u.split("\n") : [u]));
  const out: string[] = [];
  let buf = "";
  for (const u of units) {
    if (buf && buf.length + u.length + 2 > CHUNK_MAX) {
      out.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n\n${u}` : u.slice(0, CHUNK_MAX);
  }
  if (buf) out.push(buf);
  return out;
}
