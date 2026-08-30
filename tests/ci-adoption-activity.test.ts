import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { createReleaseActivities } from "../src/engine/activities/release.js";

const headSha = "a".repeat(40);
const pinnedBaseSha = "b".repeat(40);
const changedBaseSha = "c".repeat(40);

test("adoption rejects authoritative base drift before persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-ci-adoption-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  let commitTreeReads = 0;
  const activities = createReleaseActivities(createActivityContext(database, config, {
    githubRelease: {
      getPullRequest: async () => ({ number: 42, url: "https://github.test/42", repository: "acme/forge", headBranch: "forge/issue/task", baseBranch: "main", headSha, baseSha: changedBaseSha, isDraft: false, state: "open" as const, mergedAt: null }),
      getCommitTree: async () => { commitTreeReads += 1; return "d".repeat(40); },
    } as never,
  }));

  try {
    await expect(activities.adoptPullRequestRelease({ taskId: "task", companyId: "company", workflowId: "workflow", projectRevisionId: "revision", repository: "acme/forge", branchName: "forge/issue/task", baseBranch: "main", expectedBaseSha: pinnedBaseSha, pullRequestNumber: 42, headSha })).rejects.toMatchObject({ code: "stale-reviewed-revision" });
    expect(commitTreeReads).toBe(0);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_releases").get())).toEqual({ count: 0 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
