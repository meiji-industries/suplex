import { defineConfig } from "vitest/config";

const shared = { environment: "node" as const, testTimeout: 30_000 };

export default defineConfig({
  test: {
    retry: 0,
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [
            "tests/**/*.engine.test.ts",
            "tests/**/*.browser.test.ts",
            "tests/**/*.real.test.ts",
          ],
        },
      },
      {
        test: {
          ...shared,
          name: "engine",
          include: ["tests/*.engine.test.ts"],
        },
      },
      { test: { ...shared, name: "real", include: ["tests/**/*.real.test.ts"] } },
    ],
  },
});
