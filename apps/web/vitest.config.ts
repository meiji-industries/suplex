import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    retry: 0,
    environment: "node",
    testTimeout: 30_000,
    setupFiles: ["tests/react-act-environment.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
