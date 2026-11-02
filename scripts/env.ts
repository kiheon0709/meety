// CLI 스크립트용 .env.local 로더 (Next 밖에서 돌릴 때).
import fs from "node:fs";
import path from "node:path";

const p = path.join(process.cwd(), ".env.local");
if (fs.existsSync(p)) {
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
