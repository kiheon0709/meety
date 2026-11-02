// 연동 토큰 암호화 (AES-256-GCM). 열쇠는 MEETY_TOKEN_KEY(32바이트, base64 또는 hex).
// 개발 중 열쇠가 없으면 data/.secrets/token.key를 한 번 만들어 쓴다(권한 600). 배포(NODE_ENV=production)엔 꼭 환경변수로.
// 암호문은 "어느 스페이스의 어느 연결인지"(aad)에 묶인다 → 다른 행에 옮겨 붙이면 풀리지 않는다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "v1:";
let cached: { src: string; key: Buffer } | null = null;

function keyFile(): string {
  return process.env.MEETY_TOKEN_KEY_FILE || path.join(process.cwd(), "data", ".secrets", "token.key");
}

function parseKey(raw: string): Buffer {
  const t = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (key.length !== 32) throw new Error("MEETY_TOKEN_KEY는 32바이트(base64 또는 hex 64자)여야 해요");
  return key;
}

function tokenKey(): Buffer {
  const env = process.env.MEETY_TOKEN_KEY;
  const src = env ? `env:${env}` : `file:${keyFile()}`;
  if (cached?.src === src) return cached.key;
  let key: Buffer;
  if (env) key = parseKey(env);
  else {
    if (process.env.NODE_ENV === "production") throw new Error("MEETY_TOKEN_KEY가 없어요 (배포에선 꼭 필요)");
    const f = keyFile();
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      fs.writeFileSync(f, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    key = parseKey(fs.readFileSync(f, "utf8"));
  }
  cached = { src, key };
  return key;
}

export function seal(plain: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function open(sealed: string, aad: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error("알 수 없는 암호문");
  const buf = Buffer.from(sealed.slice(PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", tokenKey(), buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
