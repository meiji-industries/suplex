import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    retry: 0,
    include: ["tests/**/*.browser.test.ts"],
    environment: "node",
    setupFiles: ["tests/helpers/setup-git-environment.ts"],
    testTimeout: 30_000,
  },
});
