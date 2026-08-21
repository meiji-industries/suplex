import { expect, test } from "vitest";

import { buildDeveloperExecutionPrompt } from "../src/codex-developer.js";

const startingSha = "a".repeat(40);

test("fresh Developer prompt requires the authorized change and excludes retry commit reuse", () => {
  const prompt = buildDeveloperExecutionPrompt({ executionId: "developer_1", reuseWorktree: false, startingSha, verificationSteps: "1: pnpm test" });
  expect(prompt).toContain("This is a fresh turn: the worktree is at the accepted starting SHA with no prior work; you must make the change and create exactly one commit.");
  expect(prompt).not.toContain("verify that existing commit instead of creating a duplicate");
  expect(prompt).not.toContain("git log --oneline");
});

test("linked retry prompt conditionally permits an existing direct-child commit", () => {
  const prompt = buildDeveloperExecutionPrompt({ executionId: "developer_1", reuseWorktree: true, startingSha, verificationSteps: "1: pnpm test" });
  expect(prompt).toContain(`If, and only if, \`git log --oneline ${startingSha}..HEAD\` shows a commit directly on the accepted starting SHA`);
  expect(prompt).toContain("verify that existing commit instead of creating a duplicate");
});
