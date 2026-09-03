import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { boundedLogTail, ciRunIdFromDetailsUrl, createGithubCiProvider, CI_FAILED_LOG_MAX_LINES } from "../src/ci.js";
import { CiRepairPlanSchema } from "../src/engine/contracts/primitives.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";
import { reconcile } from "../src/pull-request-reconciler.js";
import { adoptCiPullRequestRelease, ciDeadlineBlockedState, deferCiReconciliation, CI_RERUN_LIMIT } from "../src/engine/workflow/register-ci.js";

test("extracts the Actions run id from a check-run details url", () => {
  expect(ciRunIdFromDetailsUrl("https://github.com/o/r/actions/runs/32485824288/job/96781973569?pr=479")).toBe("32485824288");
  expect(ciRunIdFromDetailsUrl("https://example.invalid/other")).toBeNull();
  expect(ciRunIdFromDetailsUrl(null)).toBeNull();
});

test("bounds and redacts a failing job log tail", () => {
  const tail = boundedLogTail(Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n"));
  expect(tail.split("\n")).toHaveLength(CI_FAILED_LOG_MAX_LINES);
  expect(tail.split("\n").at(-1)).toBe("line 499");
  expect(Buffer.byteLength(boundedLogTail("x".repeat(400_000)), "utf8")).toBeLessThanOrEqual(16 * 1024);
});

test("rerunFailedRuns re-runs only the failed jobs of each distinct run", async () => {
  const calls: string[][] = [];
  const provider = createGithubCiProvider({ runner: async (args) => { calls.push(args); return { stdout: "", stderr: "" }; } });
  expect(await provider.rerunFailedRuns!({ repository: "meiji-industries/sampler", runIds: ["32485824288", "not-a-run"] })).toEqual(["32485824288"]);
  expect(calls).toEqual([["run", "rerun", "32485824288", "--failed", "-R", "meiji-industries/sampler"]]);
});

test("a missing job log is not a CI observation failure", async () => {
  const provider = createGithubCiProvider({ runner: async () => { throw new Error("log expired"); } });
  expect(await provider.fetchFailedRunLog!({ repository: "meiji-industries/sampler", runId: "32485824288" })).toBeNull();
});

test("a CI repair plan defaults to repair and accepts rerun", () => {
  const base = { kind: "ci-repair-plan", ciRunId: "ci_0123456789abcdef01234567", ciAttemptId: "ci_attempt_0123456789abcdef01234567", failedHeadSha: "0".repeat(40), rootCause: "windows flake", failedChecks: [{ name: "test (windows)", evidenceArtifactId: "artifact_0123456789abcdef0123456789abcdef", diagnosis: "unrelated timing flake" }], steps: [{ number: 1, instruction: "re-run", verification: "checks pass" }], localVerification: ["cargo test"], unresolvedQuestions: [] };
  expect(CiRepairPlanSchema.parse(base).disposition).toBe("repair");
  expect(CiRepairPlanSchema.parse({ ...base, disposition: "rerun" }).disposition).toBe("rerun");
  expect(CiRepairPlanSchema.safeParse({ ...base, disposition: "ignore" }).success).toBe(false);
});

test("reruns are bounded per CI cycle", () => {
  expect(CI_RERUN_LIMIT).toBe(2);
});

test("missing CI head evidence defers to human reconciliation controls", () => {
  const state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId: "workflow", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("ci_waiting"), revision: 3, owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "The Planner inspects the CI failure", releaseId: null, expectedHeadSha: null, lastEventId: "workflow:3",
  });
  const waiting = deferCiReconciliation(state, "2026-08-28T00:00:00.000Z");

  expect(waiting).toMatchObject({ ...at("ci_waiting"), owner: "human", blocker: { unblockOwner: "human" }, revision: 4, allowedCommands: ["reconcile_ci", "repair_ci", "cancel_issue"], pendingAction: "Forge waits for CI — release evidence is unavailable", lastEventId: "workflow:4" });
  expect(reconcile({ observed: { exists: true, number: 76, state: "merged", isDraft: false, headSha: "a".repeat(40), mergeable: null, checks: "failed", reviewDecision: null, autoMergeEnabled: false }, target: "merged", current: { step: waiting.step } }).phase).toBe("Done");
});

test("CI recovery adopts an observed pull request release without publishing", () => {
  const state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId: "workflow", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("ci_waiting"), revision: 3, owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Forge waits for CI", releaseId: null, releaseRepository: "acme/forge", branchName: "forge/issue/adopt", baseBranch: "main", expectedHeadSha: null, expectedHeadTree: null, lastEventId: "workflow:3",
  });
  const adopted = adoptCiPullRequestRelease(state, { releaseId: "release-adopted", repository: "acme/forge", baseBranch: "main", targetBaseSha: "a".repeat(40), pullRequestNumber: 42, pullRequestUrl: "https://github.test/42", headSha: "b".repeat(40), headTree: "c".repeat(40) });

  expect(adopted).toMatchObject({ releaseId: "release-adopted", expectedHeadSha: "b".repeat(40), expectedHeadTree: "c".repeat(40), resultCommit: "b".repeat(40), resultTree: "c".repeat(40) });
});

test("a failed CI deadline requires human repair controls", () => {
  const state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId: "workflow", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("ci_waiting"), revision: 3, owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Forge waits for CI", lastEventId: "workflow:3",
  });
  expect(ciDeadlineBlockedState(state, "Required check failed: Test suite", "2026-08-28T00:00:00.000Z")).toMatchObject({ ...at("ci_waiting"), owner: "human", blocker: { unblockOwner: "human" }, allowedCommands: ["repair_ci", "reconcile_ci", "cancel_issue"], pendingAction: "Required check failed: Test suite" });
});
