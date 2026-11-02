import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: { GALPI_DB_PATH: path.join(process.cwd(), "tests", ".tmp", `test-${process.pid}.db`), ANTHROPIC_API_KEY: "test", MEETY_TOKEN_KEY_FILE: path.join(process.cwd(), "tests", ".tmp", `token-${process.pid}.key`) },
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
