import fs from "node:fs";
import path from "node:path";

const p = process.env.GALPI_DB_PATH!;
fs.mkdirSync(path.dirname(p), { recursive: true });
for (const f of [p, `${p}-wal`, `${p}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
