import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // Dockerfile이 .next/standalone을 복사한다
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
