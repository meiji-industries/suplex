import { expect, test } from "vitest";

import { buildDeveloperExecutionPrompt } from "../src/codex-developer.js";

const startingSha = "a".repeat(40);

test("fresh Developer prompt states the current base and plan-intent rules", () => {
  const prompt = buildDeveloperExecutionPrompt({ executionId: "developer_1", reuseWorktree: false, startingSha, verificationSteps: "1: pnpm test" });
  expect(prompt).toContain(`Current target base SHA: ${startingSha}.`);
  expect(prompt).toContain("The plan describes intent and scope, not an exact file manifest.");
  expect(prompt).toContain("Only report incomplete when the intent itself cannot be achieved.");
  expect(prompt).toContain("Create one or more ordinary local commits for the authorized work when new commits are required");
  expect(prompt).not.toContain("git merge-base --is-ancestor");
});

test("linked retry prompt rebases preserved work onto the current target base", () => {
  const prompt = buildDeveloperExecutionPrompt({ executionId: "developer_1", reuseWorktree: true, startingSha, verificationSteps: "1: pnpm test" });
  expect(prompt).toContain("preserved work on this branch is yours to continue.");
  expect(prompt).toContain(`If \`git merge-base --is-ancestor ${startingSha} HEAD\` fails, bring the branch up to date first: \`git rebase ${startingSha}\` (preferred; resolve conflicts) or, if the rebase is messy, \`git merge ${startingSha}\`.`);
  expect(prompt).toContain("Never discard preserved commits; never reset to the base.");
  expect(prompt).toContain("Do not amend or rewrite commits that already exist on the branch unless rebasing onto the target base requires it.");
  expect(prompt).not.toContain("directly on the accepted starting SHA");
});
