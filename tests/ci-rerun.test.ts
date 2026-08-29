import { expect, test } from "vitest";

import { boundedLogTail, ciRunIdFromDetailsUrl, createGithubCiProvider, CI_FAILED_LOG_MAX_LINES } from "../src/ci.js";
import { CiRepairPlanSchema } from "../src/temporal/contracts/primitives.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/temporal/issue-contracts.js";
import { reconcile } from "../src/pull-request-reconciler.js";
import { deferCiReconciliation, CI_RERUN_LIMIT } from "../src/temporal/workflow/register-ci.js";

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

test("missing CI release evidence defers repair so a merged PR completes", () => {
  const state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId: "workflow", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
    phase: "ci_waiting", revision: 3, owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Lead diagnosis", releaseId: null, expectedHeadSha: null, lastEventId: "workflow:3",
  });
  const waiting = deferCiReconciliation(state, "2026-08-28T00:00:00.000Z");

  expect(waiting).toMatchObject({ phase: "ci_waiting", revision: 4, pendingAction: "Waiting for CI — release evidence is unavailable", lastEventId: "workflow:4" });
  expect(reconcile({ observed: { exists: true, number: 76, state: "merged", isDraft: false, headSha: "a".repeat(40), mergeable: null, checks: "failed", reviewDecision: null, autoMergeEnabled: false }, target: "merged", current: { phase: waiting.phase } }).phase).toBe("Done");
});
