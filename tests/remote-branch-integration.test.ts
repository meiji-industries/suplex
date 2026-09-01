import { expect, test } from "vitest";
import { integrateRemoteBranch } from "../src/remote-branch-integration.js";

test("does not run git for a branch without an owned worktree", async () => {
  let ran = false;
  const database = { authQuery: (query: (db: { prepare: () => { get: () => unknown } }) => unknown) => query({ prepare: () => ({ get: () => undefined }) }) };
  const result = await integrateRemoteBranch(database as never, { worktreeRoot: "/worktrees" } as never, {
    taskId: "task", companyId: "company", workflowId: "workflow", repository: "acme/forge", branchName: "forge/task", remoteHead: "a".repeat(40), worktreePath: "/worktrees/task", targetBaseSha: null,
  }, { git: async () => { ran = true; return { ok: true, stdout: "", stderr: "" }; } });
  expect(result).toEqual({ kind: "not_owned" });
  expect(ran).toBe(false);
});
