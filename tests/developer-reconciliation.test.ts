import { expect, test } from "vitest";

import { developerReconciliationSummary, independentVerificationResults, isLegacyReceiptOnlyRecovery, reconcileDeveloperDelivery } from "../src/developer-reconciliation.js";

const git = { branch: "work/issue/task_1", head: "b".repeat(40), tree: "c".repeat(40), status: "", parents: ["a".repeat(40)], commitCount: 1, isDescendant: true, changedPaths: ["README.md"] };
const report = { kind: "delivery" as const, summary: "Delivered", steps: [{ number: 1, status: "completed" as const, filesChanged: ["README.md"], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: git.head, resultTree: git.tree, dirtyState: "clean" as const, blocker: null };
const authorization = { authorizationId: "authorization_1", taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", planRevision: 1, planArtifactId: "artifact_plan", planSha256: "d".repeat(64), authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: "2026-08-11T00:00:00.000Z" };
const manifest = { version: 1 as const, authorizedPlan: authorization, projectRevision: { projectRevisionId: "revision_1", projectId: "project_1", companyId: "company_1", repositoryIdentity: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", baseBranch: "main", targetBranch: "main", baseSha: "a".repeat(40), targetSha: "a".repeat(40), setupVerificationPolicySha256: "e".repeat(64) }, entries: [{ kind: "final_plan" as const, artifactId: "artifact_plan", repositoryPath: null, sha256: authorization.planSha256, byteSize: 1, stagedFilename: "final-plan.json", planStepNumbers: [1] }], contradictionRule: "stop_before_unrelated_edits" as const, verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }], createdAt: "2026-08-11T00:00:00.000Z" };
const independentVerification = { outcome: "passed" as const, summary: "Pinned setup and verification passed", commands: [{ command: "pnpm test", argv: ["pnpm", "test"], exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" }] };

function input(overrides: Partial<Parameters<typeof reconcileDeveloperDelivery>[0]> = {}) {
  return { executionId: "developer_1", companyId: "company_1", report, independentVerification, git, startingSha: "a".repeat(40), neutralBranch: git.branch, providerBeforeSha256: "d".repeat(64), providerAfterSha256: "d".repeat(64), processExitCode: 0, developerSessionId: "raw-developer", leadSessionId: "raw-lead", authorization, manifest, requiredChecks: [], ...overrides };
}

test("accepts a valid delivery without receipt input", () => {
  const result = reconcileDeveloperDelivery(input());
  expect(result).toMatchObject({ outcome: "completed", failureCode: null, mismatches: [], policyVersion: 2, independentVerification });
  expect(result).not.toHaveProperty("receipts");
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("rechecks an existing clean delivery commit without stale execution comparisons", () => {
  const result = reconcileDeveloperDelivery(input({
    existingResult: true,
    independentVerification: null,
    report: { kind: "delivery", summary: "legacy delivery" },
    git: { ...git, branch: "renamed-branch" },
    processExitCode: 1,
    developerSessionId: null,
    leadSessionId: null,
  }));
  expect(result).toMatchObject({ outcome: "completed", failureCode: null, mismatches: [] });
});

test("accepts a delivery when unrelated provider state changes", () => {
  const result = reconcileDeveloperDelivery(input({ providerAfterSha256: "f".repeat(64) }));
  expect(result).toMatchObject({ outcome: "completed", failureCode: null });
  expect(result.mismatches).not.toContain("provider-state-changed");
  expect(result.provider).toMatchObject({ beforeSha256: "d".repeat(64), afterSha256: "f".repeat(64) });
});

test("accepts a delivery when provider observations are unavailable", () => {
  const result = reconcileDeveloperDelivery(input({ providerBeforeSha256: null, providerAfterSha256: null }));
  expect(result).toMatchObject({ outcome: "completed", failureCode: null, provider: { beforeSha256: null, afterSha256: null } });
  expect(result.mismatches).not.toContain("provider-observation-unavailable");
});

test("hashes authoritative report and verification facts, not transcript claims or timestamps", () => {
  const first = reconcileDeveloperDelivery(input({
    report: { ...report, commandsRun: ["untrusted command"], testResults: ["untrusted result"] },
    independentVerification: { ...independentVerification, commands: [{ ...independentVerification.commands[0], startedAt: "2026-08-11T01:00:00.000Z", finishedAt: "2026-08-11T01:01:00.000Z" }] },
    malformedLines: 99,
  }));
  const second = reconcileDeveloperDelivery(input({
    report: { ...report, commandsRun: ["different claim"], testResults: ["different result"] },
    independentVerification: { ...independentVerification, commands: [{ ...independentVerification.commands[0], startedAt: "2027-08-11T01:00:00.000Z", finishedAt: "2027-08-11T01:01:00.000Z" }] },
    malformedLines: 0,
  }));
  expect(first.outcome).toBe("completed");
  expect(second.outcome).toBe("completed");
  expect(first.sha256).toBe(second.sha256);
});

test("required local test failures block delivery without a CI gate", () => {
  const failed = reconcileDeveloperDelivery(input({ independentVerification: { ...independentVerification, outcome: "failed", code: "verification_failed" } }));
  const missing = reconcileDeveloperDelivery(input({ independentVerification: null }));
  expect(failed).toMatchObject({ outcome: "blocked", failureCode: "required-local-tests-failed" });
  expect(failed.mismatches).toContain("independent-verification-failed");
  expect(missing).toMatchObject({ outcome: "blocked", failureCode: "required-local-tests-failed" });
});

test("required GitHub checks make failed local verification advisory", () => {
  const failed = reconcileDeveloperDelivery(input({
    requiredChecks: ["Tests / DB-backed"],
    independentVerification: { ...independentVerification, outcome: "failed", code: "verification_failed", summary: "make test-local did not complete successfully. Output tail:\npre-existing process-flow failure", commands: [{ ...independentVerification.commands[0], exitCode: 1, stderr: "pre-existing process-flow failure" }] },
  }));
  expect(failed).toMatchObject({ outcome: "completed", failureCode: null });
  expect(failed.mismatches).toContain("independent-verification-failed");
  expect(failed.independentVerification?.commands[0]).toMatchObject({ command: "pnpm test", exitCode: 1, stderr: "pre-existing process-flow failure" });
  expect(developerReconciliationSummary(failed)).toContain("Local verification pnpm test FAILED — make test-local did not complete successfully. Output tail:\npre-existing process-flow failure");
});

test("does not accept a clean no-change delivery for an authorized plan", () => {
  const base = "a".repeat(40);
  const noChangeGit = { ...git, head: base, tree: "e".repeat(40), parents: [], commitCount: 0, changedPaths: [] };
  const noChangeReport = { ...report, resultCommit: base, resultTree: noChangeGit.tree, steps: [{ ...report.steps[0], filesChanged: [] }] };
  const result = reconcileDeveloperDelivery(input({ git: noChangeGit, report: noChangeReport }));
  expect(result).toMatchObject({ outcome: "blocked", failureCode: "developer-made-no-change" });
  expect(result.mismatches).toEqual(expect.arrayContaining(["developer-made-no-change"]));
});

test("passes missing or mismatched audit evidence to the reviewer path", () => {
  const result = reconcileDeveloperDelivery(input({
    git: { ...git, status: " M README.md", parents: ["z".repeat(40)] },
    providerAfterSha256: null,
    processExitCode: 2,
    developerSessionId: "shared-session",
    leadSessionId: "shared-session",
  }));
  expect(result).toMatchObject({ outcome: "blocked", failureCode: "dirty-final-tree" });
  expect(result.mismatches).toEqual(expect.arrayContaining(["dirty-final-tree", "process-exit-nonzero", "session-identity-conflict"]));
});

test("derives plan completion from the static manifest and report", () => {
  const duplicateManifest = { ...manifest, verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }, { stepNumber: 1, commands: ["pnpm test"] }] };
  const duplicate = reconcileDeveloperDelivery(input({ manifest: duplicateManifest }));
  expect(duplicate.mismatches).toContain("duplicate-authorized-step");

  const missing = reconcileDeveloperDelivery(input({ report: { ...report, steps: [{ ...report.steps[0], number: 2 }] } }));
  expect(missing.mismatches).toContain("plan-step-set-mismatch");

  const blocked = reconcileDeveloperDelivery(input({ report: { ...report, steps: [{ ...report.steps[0], status: "blocked" }], authorizedStepsNotCompleted: [1], blocker: "blocked" } }));
  expect(blocked.mismatches).toContain("non-completed-step");
});

test("accepts an honest partial report and surfaces the Developer blocker", () => {
  const partial = { ...report, steps: [{ ...report.steps[0], status: "incomplete" as const, notes: "blocked locally" }], authorizedStepsNotCompleted: [1], blocker: "Local environment lacks the 1Password CLI and a reachable Docker daemon." };
  const result = reconcileDeveloperDelivery(input({ report: partial }));
  expect(result.report).toEqual(partial);
  expect(result.mismatches).not.toContain("raw-report-schema-invalid");
  expect(result).toMatchObject({ outcome: "blocked", failureCode: "non-completed-step" });
  expect(developerReconciliationSummary(result)).toBe("Developer could not complete step 1: Local environment lacks the 1Password CLI and a reachable Docker daemon.");
});

test("accepts external-environment steps and includes their notes in the delivery summary", () => {
  const external = { ...report, steps: [{ ...report.steps[0], status: "not_applicable_locally" as const, notes: "Requires production kiosk hardware." }] };
  const result = reconcileDeveloperDelivery(input({ report: external }));
  expect(result).toMatchObject({ outcome: "completed", failureCode: null });
  expect(result.mismatches).not.toContain("non-completed-step");
  expect(developerReconciliationSummary(result)).toBe("Delivered\n\nNot verified locally: step 1 — Requires production kiosk hardware.");
});

test("keeps an invalid delivery report as a diagnostic when required tests pass", () => {
  const result = reconcileDeveloperDelivery(input({ report: { kind: "delivery", summary: "missing facts" } }));
  expect(result).toMatchObject({ outcome: "completed", failureCode: null });
  expect(result.mismatches).toContain("raw-report-schema-invalid");
});

test("projects verification results only from a new reconciliation artifact", () => {
  const result = reconcileDeveloperDelivery(input());
  expect(independentVerificationResults(JSON.stringify(result))).toEqual(["pnpm test: passed"]);
  expect(independentVerificationResults(JSON.stringify({ ...result, policyVersion: 1 }))).toEqual([]);
  expect(independentVerificationResults(JSON.stringify({ ...result, independentVerification: null }))).toEqual([]);
});

test("only allows receipt-era, receipt-only failures into automatic recovery", () => {
  const receipt = { eventId: "event_1", executionId: "developer_1", attempt: 1, sequence: 1, kind: "step_blocked" as const, stepNumber: 1, sourceItemId: null, occurredAt: "2026-08-11T00:00:00.000Z", summary: "receipt", exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: "receipt_1" };
  const legacy = { ...reconcileDeveloperDelivery(input()), policyVersion: undefined, independentVerification: undefined, outcome: "blocked" as const, failureCode: "delivery-reconciliation-failed", mismatches: ["receipt-outside-step"], receipts: [receipt] };
  const retiredReceiptMismatches = [
    "malformed-jsonl-output",
    "developer-receipt-invalid",
    "receipt-outside-step",
    "duplicate-step-start:1",
    "missing-step-start:1",
    "duplicate-step-terminal:1",
    "step-terminal-order:1",
    "missing-step-receipt:1",
    "receipt-step-set-mismatch",
    "missing-verification-command:1",
    "verification-command-failed:1",
    "file-change-not-in-final-tree",
    "missing-command-terminal:pnpm test",
    "command-terminal-without-start:pnpm test",
  ];
  for (const mismatch of retiredReceiptMismatches) expect(isLegacyReceiptOnlyRecovery({ ...legacy, mismatches: [mismatch] }), mismatch).toBe(true);
  expect(isLegacyReceiptOnlyRecovery({ ...legacy, mismatches: ["receipt-outside-step", "dirty-final-tree"] })).toBe(false);
  expect(isLegacyReceiptOnlyRecovery({ ...legacy, policyVersion: 2 })).toBe(false);
  expect(isLegacyReceiptOnlyRecovery({ ...legacy, receipts: [] })).toBe(false);
  expect(isLegacyReceiptOnlyRecovery({ ...legacy, outcome: "completed" })).toBe(false);
});

test("isolates final-state reconciliation gates", () => {
  const cases: Array<[string, Partial<Parameters<typeof reconcileDeveloperDelivery>[0]>, string]> = [
    ["dirty", { git: { ...git, status: " M README.md" } }, "dirty-final-tree"],
    ["branch", { git: { ...git, branch: "wrong" } }, "branch-mismatch"],
    ["paths", { git: { ...git, changedPaths: ["OTHER.md"] } }, "reported-files-mismatch"],
    ["process absent", { processExitCode: null }, "process-exit-unknown"],
    ["process failed", { processExitCode: 1 }, "process-exit-nonzero"],
    ["developer session", { developerSessionId: null }, "missing-session"],
    ["lead session", { leadSessionId: null }, "missing-lead-session"],
    ["session collision", { leadSessionId: "raw-developer" }, "session-identity-conflict"],
    ["duplicate step", { report: { ...report, steps: [...report.steps, report.steps[0]!] } }, "duplicate-plan-step"],
    ["incomplete bookkeeping", { report: { ...report, authorizedStepsNotCompleted: [1] } }, "incomplete-step-mismatch"],
    ["malformed report", { report: {} }, "raw-report-schema-invalid"],
    ["verifier failed", { independentVerification: { ...independentVerification, outcome: "failed" } }, "independent-verification-failed"],
    ["verifier timed out", { independentVerification: { ...independentVerification, outcome: "failed", code: "verification_timed_out", commands: [{ ...independentVerification.commands[0], timedOut: true, exitCode: null }] } }, "independent-verification-failed"],
    ["verifier evidence bound", { independentVerification: { ...independentVerification, outcome: "failed", code: "verification_evidence_too_large" } }, "independent-verification-failed"],
  ];
  for (const [, overrides, mismatch] of cases) expect(reconcileDeveloperDelivery(input(overrides)).mismatches).toContain(mismatch);
});
