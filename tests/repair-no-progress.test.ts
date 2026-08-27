import { describe, expect, it } from "vitest";
import { noProgress, repairSignature, withRepairProgress } from "../src/temporal/workflow/state-transitions.js";
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
});
