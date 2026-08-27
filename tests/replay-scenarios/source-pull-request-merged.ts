import { syncGithubPullRequestSignal } from "../../src/temporal/workflows.js";
import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "source_pull_request_merged",
  captureId: "source-pull-request-merged-v1",
  workflowInput: {
    repository: "example/forge",
    source: { kind: "pull_request", number: 1, url: "https://example.test/pull/1", headBranch: "feature/source", baseBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40) },
    continuationState: { phase: "delivery_blocked", revision: 5, owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Blocked delivery", lastEventId: "fixture-source_pull_request_merged:5", continuationCount: 0, lastSummaryHash: null },
  },
  activityOverrides: {
    async observeGithubPullRequest() { return { exists: true, number: 1, url: "https://example.test/pull/1", state: "merged" as const, isDraft: false, headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }; },
  },
  async script(handle, helpers) {
    await handle.signal(syncGithubPullRequestSignal);
    return helpers.waitForState(handle, (state) => state.phase === "done");
  },
} satisfies ReplayScenarioDefinition<"source_pull_request_merged">;
