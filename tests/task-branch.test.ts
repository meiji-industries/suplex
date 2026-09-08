import { expect, test } from "vitest";
import { taskBranchName } from "../src/task-branch.js";

const taskId = "task_e37a6f28b1dd43d1ac46fc97357d3d7f";

test("chooses a branch kind from title words", () => {
  expect(taskBranchName("Fix search", taskId)).toBe("fix/search-7d3d7f");
  expect(taskBranchName("Bump dependencies", taskId)).toBe("chore/dependencies-7d3d7f");
  expect(taskBranchName("Better branch names", taskId)).toBe("feature/better-branch-names-7d3d7f");
  expect(taskBranchName("Show error toast on failed save", taskId)).toBe("feature/show-error-toast-failed-7d3d7f");
});

test("removes stop words and caps slugs at four tokens", () => {
  expect(taskBranchName("Use the new task branch name for every worktree", taskId)).toBe("feature/new-task-branch-name-7d3d7f");
});

test("uses a safe fallback for empty titles", () => {
  const branch = taskBranchName("--- !!! ---", taskId);
  expect(branch).toBe("feature/task-7d3d7f");
  expect(branch).toMatch(/^(fix|feature|chore)\/[a-z0-9-]+-[a-z0-9]{6}$/);
  expect(branch).not.toContain("--");
  expect(branch.split("/")[1]).not.toMatch(/(^-|-$)/);
});
