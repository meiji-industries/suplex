import { expect, test } from "vitest";

import { branchSyncStatus } from "../src/frontend/views/task-details.js";

const sync = { branchName: "forge/issue/task-1", worktreePath: "/tmp/task-1", remoteExists: true, ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, conflictsWithBase: false, headSha: "a".repeat(40) };

test("renders base-relative branch card states", () => {
  expect(branchSyncStatus({ ...sync, behindBase: 3 }, "main")).toBe("3 commits behind main");
  expect(branchSyncStatus(sync, "main")).toBe("Up to date with main");
  expect(branchSyncStatus({ ...sync, conflictsWithBase: true }, "main")).toBe("Conflicts with main");
});
