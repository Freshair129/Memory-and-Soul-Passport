import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: "node",
    include: ["tests/contract/**/*.test.mjs", "tests/integration/**/*.test.mjs"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
