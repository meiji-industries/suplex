import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { expect, test } from "vitest";
import { queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

function continuation(h: TemporalHarness, issueId: string) { return { phase: "ci_waiting" as const, revision: 20, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Waiting for CI", lastEventId: `${issueId}-20`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: new Date().toISOString(), leadSessionRef: "session_ci_lead", leadExecutionId: "agent_ci_lead", leadOutputArtifactId: "artifact_ci_lead_output", deliveryReviewId: `delivery_${issueId}`, planRevision: 1, developerExecutionId: "developer_ci_original", developerSessionRef: "session_ci_developer", worktreePath: join(h.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_ci_delivery", developerEvidenceArtifactId: "artifact_ci_developer_evidence", releaseId: `release_${issueId}`, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", expectedHeadSha: "b".repeat(40), expectedHeadTree: "c".repeat(40), ciAttempt: 0, ciOutcome: "waiting" as const, ciNextPollAt: null }; }
async function waitForPhase(h: TemporalHarness, id: string, phase: string) { let state = await queryIssueWorkflow(h.config, id); for (let n = 0; n < 100 && state.phase !== phase; n += 1) { await new Promise((r) => setTimeout(r, 50)); state = await queryIssueWorkflow(h.config, id); } return state; }
async function startCi(h: TemporalHarness, issueId: "ci-pass" | "ci-rate" | "ci-repair" | "ci-provider-failure") { return startIssueWorkflow(h.config, { companyId: "issue-company", projectId: "issue-project", issueId, projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: h.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0, continuationState: continuation(h, issueId) }); }

test("github webhook is absent, but polling sees ci pass or merge", async () => { const h = createTemporalHarness(); await h.start(); try { const started = await startCi(h, "ci-pass"); const first = await waitForPhase(h, started.workflowId, "accepted"); expect(first).toMatchObject({ phase: "accepted", ciOutcome: "passed" }); expect(await queryIssueWorkflow(h.config, started.workflowId)).toEqual(first); expect(h.ciCalls.get("ci-pass")).toBe(1); } finally { await h.stop(); } });

test("another user pushes a clean head change to an imported pr", async () => {
  const h = createTemporalHarness(); await h.start();
  try {
    h.activityOverrides.set("reconcileMerge", async () => ({ outcome: "changed_head", observedHeadSha: "e".repeat(40), mergeObservationId: "github-head-change", completionReceiptId: null, retryAt: null, blockerCode: null, evidenceArtifactId: null, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42" }));
    const started = await startIssueWorkflow(h.config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-pass", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: h.issueRoleProfiles, supplementalReview: false, continuationState: { ...continuation(h, "ci-pass"), phase: "manual_merge", allowedCommands: ["reconcile_merge"], pendingAction: "Waiting for your merge", acceptanceId: "acceptance_imported" } });
    const first = await waitForPhase(h, started.workflowId, "delivery_ready");
    expect(first).toMatchObject({ phase: "delivery_ready", pendingAction: "Reviewing the latest changes", expectedHeadSha: "e".repeat(40), resultCommit: "e".repeat(40), blocker: null });
    expect(await queryIssueWorkflow(h.config, started.workflowId)).toEqual(first);
  } finally { await h.stop(); }
});
// Repair and merge-decision policies are deterministic workflow registration contracts.
test("ci fails from code and auto-repairs", async () => { const h = createTemporalHarness(); await h.start(); try { const x = await startCi(h, "ci-repair"); const state = await waitForPhase(h, x.workflowId, "delivery_blocked"); expect(state).toMatchObject({ developerExecutionId: "developer_ci_repair", resultCommit: "d".repeat(40) }); expect(h.ciPlanInputs).toHaveLength(1); expect(h.ciRepairInputs).toHaveLength(1); } finally { await h.stop(); } });
test("ci fails transiently and retries without attention", async () => { const h = createTemporalHarness(); await h.start(); try { const x = await startCi(h, "ci-rate"); const first = await waitForPhase(h, x.workflowId, "accepted"); expect(first).toMatchObject({ ciOutcome: "passed", ciAttempt: 2 }); expect(await queryIssueWorkflow(h.config, x.workflowId)).toEqual(first); expect(h.ciCalls.get("ci-rate")).toBe(2); } finally { await h.stop(); } });
// Lifecycle reconciliation must preserve cancellation and external-deletion history.
test("repair retries are exhausted", async () => { const h = createTemporalHarness(); await h.start(); try { const x = await startCi(h, "ci-provider-failure"); const first = await waitForPhase(h, x.workflowId, "delivery_blocked"); expect(first).toMatchObject({ blocker: expect.objectContaining({ category: "provider_connectivity_exhausted" }) }); expect(await queryIssueWorkflow(h.config, x.workflowId)).toEqual(first); } finally { await h.stop(); } });

test("github authentication is missing and produces the sign-in action", async () => {
  const h = createTemporalHarness(); await h.start();
  try {
    h.activityOverrides.set("reconcileCi", async () => {
      throw ApplicationFailure.create({ message: "GitHub login expired", type: "login-expired", nonRetryable: true, details: [{ code: "login-expired", summary: "GitHub login expired", category: "provider_authentication" }] });
    });
    const started = await startCi(h, "ci-provider-failure");
    const first = await waitForPhase(h, started.workflowId, "delivery_blocked");
    expect(first.blocker).toMatchObject({ category: "provider_authentication" });
    expect(first.blocker?.actions).toContainEqual(expect.objectContaining({ label: "Sign in to GitHub and retry" }));
    expect(await queryIssueWorkflow(h.config, started.workflowId)).toEqual(first);
  } finally { await h.stop(); }
});
