import { readFileSync } from "node:fs";

import { expect, test } from "vitest";
import { z } from "zod";

const scripts = z.object({ scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync("package.json", "utf8"))).scripts;

test("package scripts have one comprehensive gate authority", () => {
  expect(scripts.check).toBe("pnpm run typecheck && pnpm run lint && pnpm run test");
  expect(scripts["check:full"]).toBe("pnpm run check && pnpm run test:browser");
  expect(scripts.verify).toBe("pnpm run check:full");
  expect(scripts["test:all"]).toBe("pnpm run check:full");
});

test("CI invokes the canonical full gate", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const command = workflow.match(/- name: Run the verification gate\s*\n\s*run:\s*(.+)/)?.[1];
  expect(command).toBe("pnpm check:full");
});

test.each(["vitest.config.ts", "vitest.browser.config.ts"])("%s explicitly disables retries", (file) => {
  const source = readFileSync(file, "utf8");
  expect(source.match(/\bretry\s*:/g)).toHaveLength(1);
  expect(source).toMatch(/test:\s*\{\s*retry:\s*0,/);
});
