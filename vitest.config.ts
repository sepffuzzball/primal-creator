import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.mts"],
    // Build output (Next standalone) contains a stale copy of source test files;
    // never collect tests from there.
    exclude: ["**/node_modules/**", "**/.next/**", "**/.git/**"],
  },
})
