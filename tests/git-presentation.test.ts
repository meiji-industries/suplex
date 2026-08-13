import { expect, test } from "vitest";

import { buildGitBranchName } from "../src/git-branch-name.js";
import { branchSlugFromTitle, fallbackGitPresentation, GitPresentationSchema } from "../src/git-presentation.js";

test("builds readable stable branch names without exposing internal task keys", () => {
  const branch = buildGitBranchName({ branchSlug: "improve-git-pr-naming", taskId: "task_0123456789abcdef01234567" });

  expect(branch).toMatch(/^work\/improve-git-pr-naming-[a-f0-9]{8}$/);
  expect(branch).not.toContain("task_");
  expect(buildGitBranchName({ branchSlug: "improve-git-pr-naming", taskId: "task_0123456789abcdef01234567" })).toBe(branch);
  expect(buildGitBranchName({ branchSlug: "improve-git-pr-naming", taskId: "task_1123456789abcdef01234567" })).not.toBe(branch);
});

test("creates useful legacy fallbacks and enforces the approved presentation format", () => {
  expect(branchSlugFromTitle("  Improve Git & PR naming!  ")).toBe("improve-git-and-pr-naming");
  expect(fallbackGitPresentation("Improve Git & PR naming")).toEqual({
    branchSlug: "improve-git-and-pr-naming",
    pullRequestTitle: "Improve Git & PR naming",
    pullRequestDescription: "Improve Git & PR naming.",
  });
  expect(GitPresentationSchema.safeParse({ branchSlug: "internal_task_123", pullRequestTitle: "Improve naming", pullRequestDescription: "Use readable names." }).success).toBe(false);
  expect(GitPresentationSchema.safeParse({ branchSlug: "improve-naming", pullRequestTitle: " Improve naming", pullRequestDescription: "Use readable names." }).success).toBe(false);
});
