import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";

import { createActivityCaller } from "../src/engine/activities.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { StructuredLogger } from "../src/logging.js";
import { IssueRun } from "../src/engine/runs.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("a failed GitHub observation keeps the workflow waiting with a backoff", async () => {
  const projected: unknown[] = [];
  const h = await createEngineHarness({
    projectIssueState: async (event) => { projected.push(event.state); return event.state; },
    observeGithubPullRequest: async () => { throw new Error("GitHub observation failed"); },
  });
  const records: Array<Record<string, unknown>> = [];
  const workflowId = h.workflowId("run-failure");
  h.seedTask("run-failure");
  const input = {
    workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "run-failure", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2,
    continuationState: {
      ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "run-failure", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      ...at("ci_waiting"), revision: 0, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Forge waits for CI", releaseId: "release-existing", releaseRepository: "acme/forge", branchName: "forge/issue/failure", baseBranch: "main", expectedHeadSha: engineFixture.commit, expectedHeadTree: engineFixture.tree, lastEventId: `${workflowId}:0`,
    },
  };
  h.database.projectIssueEvent({ schemaVersion: 1, runId: "seed-run-failure", eventId: input.continuationState.lastEventId, state: input.continuationState });
  const caller = createActivityCaller(h.database, h.activities, h.clock.wait.bind(h.clock));
  const run = new IssueRun(input, h.database, caller, h.clock, new StructuredLogger((line) => records.push(JSON.parse(line) as Record<string, unknown>)));
  try {
    await run.ready();
    for (let attempt = 0; attempt < 20 && projected.length === 0; attempt += 1) await Promise.resolve();
    expect(run.error).toBeUndefined();
    expect(run.state).toMatchObject({ step: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Forge waits for CI", ciNextPollAt: expect.any(String) });
    expect(projected).toContainEqual(expect.objectContaining({ owner: "lead", pendingAction: "Forge waits for CI", ciNextPollAt: expect.any(String) }));
    expect(records).not.toContainEqual(expect.objectContaining({ level: 50, message: "Issue workflow run failed", workflowId }));
  } finally { run.dispose(); await h.stop(); }
});
