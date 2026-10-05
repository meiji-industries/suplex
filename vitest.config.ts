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
          setupFiles: ["tests/react-act-environment.ts"],
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/**/*.browser.test.ts"],
        },
      },
    ],
  },
});
