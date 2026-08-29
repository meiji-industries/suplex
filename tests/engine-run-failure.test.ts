import { expect, test } from "vitest";

import { createActivityCaller } from "../src/engine/activities.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { StructuredLogger } from "../src/logging.js";
import { IssueRun } from "../src/engine/runs.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("a rejected workflow immediately projects a human-owned rescue state and logs", async () => {
  const projected: unknown[] = [];
  const h = await createEngineHarness({
    projectIssueState: async (event) => { projected.push(event.state); return event.state; },
    observeGithubPullRequest: async () => { throw new Error("GitHub observation failed"); },
  });
  const records: Array<Record<string, unknown>> = [];
  const workflowId = "workflow-run-failure";
  const input = {
    workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "run-failure", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2,
    continuationState: {
      ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "run-failure", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      phase: "ci_waiting" as const, revision: 4, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Waiting for CI", releaseId: "release-existing", releaseRepository: "acme/forge", branchName: "forge/issue/failure", baseBranch: "main", expectedHeadSha: engineFixture.commit, expectedHeadTree: engineFixture.tree, lastEventId: `${workflowId}:4`,
    },
  };
  const caller = createActivityCaller(h.database, h.activities, h.clock.wait.bind(h.clock));
  const run = new IssueRun(input, h.database, caller, h.clock, new StructuredLogger((line) => records.push(JSON.parse(line) as Record<string, unknown>)));
  try {
    await run.ready();
    for (let attempt = 0; attempt < 20 && !run.error; attempt += 1) await Promise.resolve();
    for (let attempt = 0; attempt < 20 && (!run.error || projected.length === 0); attempt += 1) await Promise.resolve();
    expect(run.error).toBeInstanceOf(Error);
    expect(run.state).toMatchObject({ phase: "ci_waiting", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Activity observeGithubPullRequest failed", lastHandlerError: { command: "workflow", reason: "Activity observeGithubPullRequest failed" } });
    expect(projected).toContainEqual(expect.objectContaining({ owner: "human", pendingAction: "Activity observeGithubPullRequest failed" }));
    expect(records).toContainEqual(expect.objectContaining({ level: 50, message: "Issue workflow run failed", workflowId, error: "Activity observeGithubPullRequest failed" }));
  } finally { run.dispose(); await h.stop(); }
});
