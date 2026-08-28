import { expect, test } from "vitest";

import { buildDeveloperExecutionPrompt } from "../src/codex-developer.js";

const startingSha = "a".repeat(40);

test("fresh Developer prompt states the current base and plan-intent rules", () => {
  const prompt = buildDeveloperExecutionPrompt({ executionId: "developer_1", reuseWorktree: false, startingSha, verificationSteps: "1: pnpm test" });
  expect(prompt).toContain(`Current target base SHA: ${startingSha}.`);
  expect(prompt).toContain("The plan describes intent and scope, not an exact file manifest.");
  expect(prompt).toContain("Only report incomplete when the intent itself cannot be achieved.");
  expect(prompt).toContain("If a step requires deployment, physical devices, production access, external services, an unrelated pre-existing test failure, or a local server that cannot start, mark it `not_applicable_locally` with a one-line reason and continue with the remaining steps.");
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

test("Developer prompt includes continuation context only for a continuation", () => {
  const continued = buildDeveloperExecutionPrompt({ executionId: "developer_1", reuseWorktree: true, startingSha, verificationSteps: "1: pnpm test", continuation: { completedSteps: [1], remainingSteps: [2, 3], previousCommit: "b".repeat(40), previousDeliverySummary: "First step done" } });
  expect(continued).toContain("You already completed steps 1");
  expect(continued).toContain("Continue with steps 2, 3 in the same worktree.");
  expect(buildDeveloperExecutionPrompt({ executionId: "developer_1", reuseWorktree: false, startingSha, verificationSteps: "1: pnpm test" })).not.toContain("You already completed steps");
});
