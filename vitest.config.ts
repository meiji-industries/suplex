import { defineConfig } from "vitest/config";

const shared = { environment: "node" as const, testTimeout: 30_000 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [
            "tests/**/*.temporal.test.ts",
            "tests/**/*.browser.test.ts",
            "tests/**/*.real.test.ts",
            "tests/workflow-replay.test.ts",
          ],
        },
      },
      { test: { ...shared, name: "replay", include: ["tests/workflow-replay.test.ts"] } },
      {
        test: {
          ...shared,
          name: "temporal",
          include: ["tests/*.temporal.test.ts"],
        },
      },
      { test: { ...shared, name: "real", include: ["tests/**/*.real.test.ts"] } },
    ],
  },
});
