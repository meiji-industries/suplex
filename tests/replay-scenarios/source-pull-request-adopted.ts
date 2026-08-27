import { syncGithubPullRequestSignal } from "../../src/temporal/workflows.js";
import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "source_pull_request_adopted",
  captureId: "source-pull-request-adopted-v1",
  workflowInput: {
    continuationState: { phase: "delivery_blocked", revision: 5, owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Blocked delivery", lastEventId: "fixture-source_pull_request_adopted:5", continuationCount: 0, lastSummaryHash: null },
  },
  activityOverrides: {
    async loadTaskSourcePullRequest() { return { repository: "example/forge", source: { number: 1, url: "https://example.test/pull/1", headBranch: "feature/source", baseBranch: "main" } }; },
    async observeGithubPullRequest() { return { exists: true, number: 1, url: "https://example.test/pull/1", state: "merged" as const, isDraft: false, headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }; },
  },
  async script(handle, helpers) {
    await handle.signal(syncGithubPullRequestSignal);
    return helpers.waitForState(handle, (state) => state.phase === "done");
  },
} satisfies ReplayScenarioDefinition<"source_pull_request_adopted">;
