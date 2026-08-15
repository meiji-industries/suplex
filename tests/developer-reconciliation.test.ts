import { expect, test } from "vitest";

import { reconcileDeveloperDelivery, rereconcileDeveloperDelivery } from "../src/developer-reconciliation.js";

const git = { branch: "work/issue/task_1", head: "b".repeat(40), tree: "c".repeat(40), status: "", parents: ["a".repeat(40)], commitCount: 1, isDescendant: true, changedPaths: ["README.md"] };
const receipt = (kind: "step_started" | "step_completed" | "command_started" | "command_finished", sequence: number, exitCode: number | null = null, sourceItemId: string | null = null) => ({ eventId: `event_${sequence}`, executionId: "developer_1", attempt: 1, sequence, kind, stepNumber: 1, sourceItemId, occurredAt: "2026-08-11T00:00:00.000Z", summary: kind === "command_finished" ? "pnpm test" : kind, exitCode, artifactId: null, artifactSha256: null, idempotencyKey: `key_${sequence}` });
const report = { kind: "delivery" as const, summary: "Delivered", steps: [{ number: 1, status: "completed" as const, filesChanged: ["README.md"], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: git.head, resultTree: git.tree, dirtyState: "clean" as const, blocker: null };
const authorization = { authorizationId: "authorization_1", taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", planRevision: 1, planArtifactId: "artifact_plan", planSha256: "d".repeat(64), authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: "2026-08-11T00:00:00.000Z" };
const manifest = { version: 1 as const, authorizedPlan: authorization, projectRevision: { projectRevisionId: "revision_1", projectId: "project_1", companyId: "company_1", repositoryIdentity: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", baseBranch: "main", targetBranch: "main", baseSha: "a".repeat(40), targetSha: "a".repeat(40), setupVerificationPolicySha256: "e".repeat(64) }, entries: [{ kind: "final_plan" as const, artifactId: "artifact_plan", repositoryPath: null, sha256: authorization.planSha256, byteSize: 1, stagedFilename: "final-plan.json", planStepNumbers: [1] }], contradictionRule: "stop_before_unrelated_edits" as const, verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }], createdAt: "2026-08-11T00:00:00.000Z" };

function input(overrides: Partial<Parameters<typeof reconcileDeveloperDelivery>[0]> = {}) {
  return { executionId: "developer_1", companyId: "company_1", report, receipts: [receipt("step_started", 1), receipt("command_finished", 2, 0), receipt("step_completed", 3)], git, startingSha: "a".repeat(40), neutralBranch: git.branch, providerBeforeSha256: "d".repeat(64), providerAfterSha256: "d".repeat(64), processExitCode: 0, malformedLines: 0, developerSessionId: "raw-developer", leadSessionId: "raw-lead", authorization, manifest, verificationCommands: manifest.verificationCommands, ...overrides };
}

test("reconciliation is blocked by provider drift, dirty state, wrong parent, or missing receipts", () => {
  const result = reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), receipt("step_completed", 2)], git: { ...git, status: " M README.md", parents: ["z".repeat(40)] }, providerAfterSha256: "e".repeat(64) }));
  expect(result.outcome).toBe("blocked");
  expect(result.mismatches).toEqual(expect.arrayContaining(["dirty-final-tree", "commit-parent-mismatch", "provider-state-changed"]));
});

test("reconciliation accepts only an exact clean one-commit delivery with passing verification", () => {
  const result = reconcileDeveloperDelivery(input());
  expect(result.outcome).toBe("completed");
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.receipts).toHaveLength(3);
  expect(result.manifest).toEqual(manifest);
});

test("reconciliation matches current Codex shell-wrapped verification commands", () => {
  const wrapped = { ...receipt("command_finished", 2, 0), summary: "/bin/zsh -lc 'pnpm test'\npassed" };
  const result = reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), wrapped, receipt("step_completed", 3)] }));
  expect(result.outcome).toBe("completed");
  const quotedTree = { ...receipt("command_finished", 2, 0), summary: "/bin/zsh -lc \"git rev-parse 'HEAD^{tree}'\"\nb68399" };
  const treeVerification = [{ stepNumber: 1, commands: ["git rev-parse HEAD^{tree}"] }];
  expect(reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), quotedTree, receipt("step_completed", 3)], verificationCommands: treeVerification, manifest: { ...manifest, verificationCommands: treeVerification } })).outcome).toBe("completed");
  const adjacentQuotes = { ...quotedTree, summary: "/bin/zsh -lc 'git rev-parse HEAD''^{tree}'\nb68399" };
  expect(reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), adjacentQuotes, receipt("step_completed", 3)], verificationCommands: treeVerification, manifest: { ...manifest, verificationCommands: treeVerification } })).outcome).toBe("completed");
});

test("reconciliation allowlists only read-only staged-context bootstrap commands before the first step", () => {
  const bootstrapStarted = { ...receipt("command_started", 1, null, "bootstrap"), stepNumber: null, summary: "/bin/zsh -lc \"sed -n '1,240p' .forge-context/execution/final-plan.json\"" };
  const bootstrapFinished = { ...receipt("command_finished", 2, 0, "bootstrap"), stepNumber: null, summary: `${bootstrapStarted.summary}\n{}` };
  const valid = reconcileDeveloperDelivery(input({ receipts: [bootstrapStarted, bootstrapFinished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] }));
  expect(valid.outcome).toBe("completed");
  const unsafe = { ...bootstrapFinished, summary: "/bin/zsh -lc 'touch escaped.txt'\n" };
  expect(reconcileDeveloperDelivery(input({ receipts: [bootstrapStarted, unsafe, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] })).mismatches).toContain("receipt-outside-step");
  const compoundStarted = { ...bootstrapStarted, summary: "/bin/zsh -lc \"find .forge-context -type f -print -exec sh -c 'sed -n 1,20p $1' _ {} \\; && git status --short\"" };
  const compoundFinished = { ...bootstrapFinished, summary: `${compoundStarted.summary}\n` };
  expect(reconcileDeveloperDelivery(input({ receipts: [compoundStarted, compoundFinished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] })).outcome).toBe("completed");
  const checksummedStarted = { ...bootstrapStarted, summary: "/bin/zsh -lc 'sha256sum -c .forge-context/execution/.manifest.sha256 && file .forge-context/execution/brief.bin && sed -n 1,20p .forge-context/execution/brief.bin'" };
  const checksummedFinished = { ...bootstrapFinished, summary: `${checksummedStarted.summary}\n` };
  expect(reconcileDeveloperDelivery(input({ receipts: [checksummedStarted, checksummedFinished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] })).outcome).toBe("completed");
  const loopStarted = { ...bootstrapStarted, summary: "/bin/zsh -lc 'for path in .forge-context/execution/a .forge-context/execution/b; do echo \"$path\"; cat \"$path\"; done'" };
  const loopFinished = { ...bootstrapFinished, summary: `${loopStarted.summary}\n` };
  expect(reconcileDeveloperDelivery(input({ receipts: [loopStarted, loopFinished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] })).outcome).toBe("completed");
  // Real linked-retry inspection: merge-base and friends are read-only.
  const gitInspectionStarted = { ...bootstrapStarted, summary: "/bin/zsh -lc 'ls -la .forge-context/execution; git status --porcelain=v1; git rev-parse HEAD''^; git merge-base HEAD origin/main; git diff --stat HEAD''^ HEAD; git diff HEAD''^ HEAD -- README.md'" };
  const gitInspectionFinished = { ...bootstrapFinished, summary: `${gitInspectionStarted.summary}\n` };
  expect(reconcileDeveloperDelivery(input({ receipts: [gitInspectionStarted, gitInspectionFinished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] })).outcome).toBe("completed");
  const currentBranchStarted = { ...bootstrapStarted, summary: "/bin/zsh -lc 'sed -n 1,20p README.md && git branch --show-current && git log -1 --oneline'" };
  const currentBranchFinished = { ...bootstrapFinished, summary: `${currentBranchStarted.summary}\nwork/issue/task_1` };
  expect(reconcileDeveloperDelivery(input({ receipts: [currentBranchStarted, currentBranchFinished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] })).outcome).toBe("completed");
  const branchMutation = { ...bootstrapFinished, summary: "/bin/zsh -lc 'git branch escaped'\n" };
  expect(reconcileDeveloperDelivery(input({ receipts: [bootstrapStarted, branchMutation, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] })).mismatches).toContain("receipt-outside-step");
});

test("reconciliation accepts a read-only hex inspection before the first step and reports one finding per command", () => {
  const started = { ...receipt("command_started", 1, null, "inspect-brief"), stepNumber: null, summary: "/bin/zsh -lc 'xxd -g 1 .forge-context/execution/task_brief-artifact_1.md'" };
  const finished = { ...receipt("command_finished", 2, 0, "inspect-brief"), stepNumber: null, summary: `${started.summary}\n00000000: 23 20 42 72 69 65 66` };
  const receipts = [started, finished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)];

  expect(reconcileDeveloperDelivery(input({ receipts })).outcome).toBe("completed");

  const unsafe = receipts.map((item) => item.sourceItemId === "inspect-brief" ? { ...item, summary: "/bin/zsh -lc 'touch escaped.txt'" } : item);
  expect(reconcileDeveloperDelivery(input({ receipts: unsafe })).mismatches.filter((code) => code === "receipt-outside-step")).toHaveLength(1);
});

test("stored policy-only failures can be reconciled without another Developer turn", () => {
  const started = { ...receipt("command_started", 1, null, "inspect-brief"), stepNumber: null, summary: "/bin/zsh -lc 'xxd -g 1 .forge-context/execution/task_brief-artifact_1.md'" };
  const finished = { ...receipt("command_finished", 2, 0, "inspect-brief"), stepNumber: null, summary: `${started.summary}\n00000000: 23 20 42 72 69 65 66` };
  const current = reconcileDeveloperDelivery(input({ receipts: [started, finished, receipt("step_started", 3), receipt("command_finished", 4, 0), receipt("step_completed", 5)] }));
  const { observations: _observations, ...legacy } = current;
  const prior = { ...legacy, outcome: "blocked", failureCode: "delivery-reconciliation-failed", mismatches: ["receipt-outside-step", "receipt-outside-step"] };

  expect(rereconcileDeveloperDelivery(prior)).toMatchObject({ outcome: "completed", mismatches: [] });
});

test("reconciliation accepts only read-only Git verification after the final step", () => {
  const command = "/bin/zsh -lc 'git status --porcelain=v1 && git rev-parse HEAD^{commit} && git rev-parse HEAD^{tree}'";
  const finalStarted = { ...receipt("command_started", 4, null, "final-git"), stepNumber: null, summary: command };
  const finalFinished = { ...receipt("command_finished", 5, 0, "final-git"), stepNumber: null, summary: `${command}\n${git.head}\n${git.tree}` };
  expect(reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), receipt("command_finished", 2, 0), receipt("step_completed", 3), finalStarted, finalFinished] })).outcome).toBe("completed");

  const mutation = { ...finalFinished, summary: "/bin/zsh -lc 'git commit --allow-empty -m escaped'" };
  expect(reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), receipt("command_finished", 2, 0), receipt("step_completed", 3), finalStarted, mutation] })).mismatches).toContain("receipt-outside-step");

  const commitStarted = { ...receipt("command_started", 4, null, "final-commit"), stepNumber: null, summary: "/bin/zsh -lc 'git add README.md && git commit -m \"Finish delivery\"'" };
  const commitFinished = { ...receipt("command_finished", 5, 0, "final-commit"), stepNumber: null, summary: `${commitStarted.summary}\ncommitted` };
  const inspectStarted = { ...receipt("command_started", 6, null, "final-inspect"), stepNumber: null, summary: "/bin/zsh -lc 'git rev-parse HEAD && git status --short && rg -n Delivered README.md'" };
  const inspectFinished = { ...receipt("command_finished", 7, 0, "final-inspect"), stepNumber: null, summary: `${inspectStarted.summary}\nclean` };
  expect(reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), receipt("command_finished", 2, 0), receipt("step_completed", 3), commitStarted, commitFinished, inspectStarted, inspectFinished] })).outcome).toBe("completed");
});

test("reconciliation accepts successful combined verification commands", () => {
  const verificationCommands = [{ stepNumber: 1, commands: ["pnpm test", "git diff --check"] }];
  const combined = { ...receipt("command_finished", 2, 0), summary: "/bin/zsh -lc 'pnpm test && git diff --check'\npassed" };
  expect(reconcileDeveloperDelivery(input({ receipts: [receipt("step_started", 1), combined, receipt("step_completed", 3)], verificationCommands, manifest: { ...manifest, verificationCommands } })).outcome).toBe("completed");
});

test("reconciliation accepts a TDD verification that fails first and passes in a later step", () => {
  const verificationCommands = [{ stepNumber: 1, commands: ["pnpm test"] }, { stepNumber: 2, commands: [] }];
  const later = (kind: Parameters<typeof receipt>[0], sequence: number, exitCode: number | null = null) => ({ ...receipt(kind, sequence, exitCode), stepNumber: 2 });
  const tddReport = { ...report, steps: [report.steps[0], { number: 2, status: "completed" as const, filesChanged: [], notes: "implementation complete" }] };
  const receipts = [receipt("step_started", 1), receipt("command_finished", 2, 1), receipt("step_completed", 3), later("step_started", 4), later("command_finished", 5, 0), later("step_completed", 6)];

  expect(reconcileDeveloperDelivery(input({ report: tddReport, receipts, verificationCommands, manifest: { ...manifest, verificationCommands } })).outcome).toBe("completed");
});

test("reconciliation blocks omitted or blocked authorized steps", () => {
  const blockedReport = { ...report, steps: [{ ...report.steps[0], status: "blocked" as const }], authorizedStepsNotCompleted: [1], blocker: "verification failed" };
  const result = reconcileDeveloperDelivery(input({ report: blockedReport, receipts: [receipt("step_started", 1), receipt("step_completed", 2)] }));
  expect(result.outcome).toBe("blocked");
  expect(result.mismatches).toContain("non-completed-step");

  const missingReport = { ...report, steps: [{ ...report.steps[0], number: 2 }] };
  const missing = reconcileDeveloperDelivery(input({ report: missingReport, verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }, { stepNumber: 2, commands: [] }], manifest: { ...manifest, verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }, { stepNumber: 2, commands: [] }] } }));
  expect(missing.outcome).toBe("blocked");
  expect(missing.mismatches).toContain("plan-step-set-mismatch");
});

test("reconciliation blocks a nonzero process and an unterminated command", () => {
  const result = reconcileDeveloperDelivery(input({
    processExitCode: 1,
    receipts: [receipt("step_started", 1), receipt("command_started", 2, null, "cmd_1"), receipt("step_completed", 3), receipt("command_finished", 4, 0, "cmd_2")],
  }));
  expect(result.outcome).toBe("blocked");
  expect(result.mismatches).toEqual(expect.arrayContaining(["process-exit-nonzero", "missing-command-terminal:cmd_1", "command-terminal-without-start:cmd_2"]));
});

test("malformed final delivery remains a durable blocked reconciliation", () => {
  const result = reconcileDeveloperDelivery(input({ report: { kind: "delivery", summary: "incomplete" }, developerSessionId: null }));
  expect(result.outcome).toBe("blocked");
  expect(result.report).toBeNull();
  expect(result.mismatches).toEqual(expect.arrayContaining(["raw-report-schema-invalid", "missing-session"]));
});

test("reconciliation blocks the same underlying Lead and Developer session", () => {
  const result = reconcileDeveloperDelivery(input({ developerSessionId: "raw-shared", leadSessionId: "raw-shared" }));
  expect(result.outcome).toBe("blocked");
  expect(result.mismatches).toContain("session-identity-conflict");
});
