import { describe, expect, it } from "vitest";
import { credentialBlockedState, noProgress, repairSignature, transientRetryState, withRepairProgress } from "../src/temporal/workflow/state-transitions.js";
import { buildInitialIssueWorkflowState } from "../src/temporal/issue-contracts.js";

describe("repair progress", () => {
  it("uses a stable signature and only detects identical evidence", () => {
    const signature = repairSignature({ source: "ci", code: "failed", failingCommand: "pnpm test", firstFailingLine: "x" });
    expect(signature).toBe(repairSignature({ source: "ci", code: "failed", failingCommand: "pnpm test", firstFailingLine: "x" }));
    expect(noProgress({ signature, commit: "a", diagnosticHash: "b", repeats: 0 }, { signature, commit: "a", diagnosticHash: "b" })).toBe(true);
    expect(noProgress({ signature, commit: "a", diagnosticHash: "b", repeats: 0 }, { signature, commit: "c", diagnosticHash: "b" })).toBe(false);
  });

  it("increments repeated failures and resets changed evidence", () => {
    const initial = buildInitialIssueWorkflowState({ issueId: "issue_1", companyId: "company_1", workflowId: "workflow_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: "artifact_1", imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    const first = withRepairProgress(initial, { signature: "x", commit: null, diagnosticHash: null });
    const second = withRepairProgress(first, { signature: "x", commit: null, diagnosticHash: null });
    expect(second.repairProgress?.repeats).toBe(1);
    expect(withRepairProgress(second, { signature: "y", commit: null, diagnosticHash: null }).repairProgress?.repeats).toBe(0);
  });

  it("keeps transient failures retry-only and routes credentials to sign-in", () => {
    const initial = buildInitialIssueWorkflowState({ issueId: "issue_1", companyId: "company_1", workflowId: "workflow_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: "artifact_1", imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    expect(transientRetryState(initial, "repair_ci", "Provider unavailable")).toMatchObject({ phase: "delivery_blocked", owner: "lead", allowedCommands: ["repair_ci", "cancel_issue"], pendingAction: "Retrying after a temporary failure", blocker: null });
    const credential = credentialBlockedState(initial, "repair_ci", { artifactId: "evidence_1", kind: "attention-evidence" });
    expect(credential).toMatchObject({ phase: "delivery_blocked", owner: "human", blocker: { category: "provider_authentication" } });
    expect(credential.blocker?.actions[0]).toMatchObject({ command: "repair_ci", label: "Sign in to GitHub and retry" });
  });

  it("offers CI reconciliation after GitHub sign-in", () => {
    const initial = buildInitialIssueWorkflowState({ issueId: "issue_1", companyId: "company_1", workflowId: "workflow_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: "artifact_1", imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    const credential = credentialBlockedState(initial, "reconcile_ci", { artifactId: "evidence_1", kind: "attention-evidence" });
    expect(credential).toMatchObject({ phase: "delivery_blocked", owner: "human", allowedCommands: ["reconcile_ci", "cancel_issue"], blocker: { category: "provider_authentication" } });
    expect(credential.blocker?.actions[0]).toMatchObject({ command: "reconcile_ci", label: "Sign in to GitHub and retry" });
  });
});
