import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@phirst/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@phirst/brokers": new URL("./packages/brokers/src/index.ts", import.meta.url).pathname,
      "@phirst/ai": new URL("./packages/ai/src/index.ts", import.meta.url).pathname,
      "@phirst/engine": new URL("./packages/engine/src/index.ts", import.meta.url).pathname,
      "@phirst/marketdata": new URL("./packages/marketdata/src/index.ts", import.meta.url).pathname,
    },
  },
});
