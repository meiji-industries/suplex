import { defineConfig } from "vitest/config";

const shared = { environment: "node" as const, testTimeout: 30_000 };
const packagedTests = ["desktop/tests/packaged-smoke.test.ts"];

export default defineConfig({
  test: {
    retry: 0,
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["tests/**/*.test.{ts,tsx}", "desktop/tests/**/*.test.ts"],
          exclude: [
            "tests/**/*.browser.test.ts",
            "tests/**/*.real.test.ts",
            ...packagedTests,
          ],
        },
      },
      { test: { ...shared, name: "real", include: ["tests/**/*.real.test.ts"] } },
      { test: { ...shared, name: "packaged", include: packagedTests } },
    ],
  },
});
