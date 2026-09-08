import { defineConfig } from "vitest/config";

const shared = { environment: "node" as const, testTimeout: 30_000 };
const integrationTests = [
  "tests/**/*.integration.test.ts",
  "tests/task-archive.test.ts",
  "tests/task-host.test.ts",
  "tests/task-sources.test.ts",
  "tests/task-worktree.test.ts",
  "tests/worker-environment.test.ts",
  "tests/workflows-delivery.test.ts",
  "tests/workflows-delivery-repairs.test.ts",
];
const packagedTests = ["desktop/tests/packaged-smoke.test.ts"];

export default defineConfig({
  test: {
    retry: 0,
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["tests/**/*.test.ts", "desktop/tests/**/*.test.ts"],
          exclude: [
            "tests/**/*.browser.test.ts",
            "tests/**/*.real.test.ts",
            ...integrationTests,
            ...packagedTests,
          ],
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          include: integrationTests,
          setupFiles: ["tests/helpers/setup-git-environment.ts"],
        },
      },
      { test: { ...shared, name: "real", include: ["tests/**/*.real.test.ts"] } },
      { test: { ...shared, name: "packaged", include: packagedTests } },
    ],
  },
});
