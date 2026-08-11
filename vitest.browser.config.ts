import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.browser.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
