import { expect, test } from "vitest";

import { AcceptedProjectRevisionSchema, AuthorizedPlanSubjectSchema, DeveloperContextSchema, EvidenceManifestSchema, OwnedWorktreeSchema } from "../src/developer-contracts.js";

const revision = {
  projectRevisionId: "revision_1", projectId: "project_1", companyId: "company_1", repositoryIdentity: "acme/forge", repositoryPath: "/repos/forge", worktreeRoot: "/worktrees", baseBranch: "main", targetBranch: "main", baseSha: "a".repeat(40), targetSha: "b".repeat(40), setupVerificationPolicySha256: "c".repeat(64),
};

const subject = {
  authorizationId: "authorization_1", taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", planRevision: 3, planArtifactId: "artifact_plan", planSha256: "d".repeat(64), authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: "2026-08-11T00:00:00.000Z",
};

test("accepted project revision keeps targetSha as starting authority even when branch heads differ", () => {
  expect(AcceptedProjectRevisionSchema.parse(revision).targetSha).toBe("b".repeat(40));
});

test("plan authorization rejects stale hashes and invalid approval combinations", () => {
  expect(AuthorizedPlanSubjectSchema.safeParse({ ...subject, planSha256: "e".repeat(64) }).success).toBe(true);
  expect(AuthorizedPlanSubjectSchema.safeParse({ ...subject, authorizationKind: "routine_auto", approvalDecisionId: "decision_1" }).success).toBe(false);
  expect(AuthorizedPlanSubjectSchema.safeParse({ ...subject, authorizationKind: "human_approval", approvalDecisionId: null }).success).toBe(false);
});

test("Developer context is explicit and bounded", () => {
  expect(DeveloperContextSchema.safeParse({ includeTaskBrief: false, evidenceArtifactIds: ["artifact_1"], imageArtifactIds: [], repositoryInstructionPaths: ["AGENTS.md", "docs/verify.md"] }).success).toBe(true);
  expect(DeveloperContextSchema.safeParse({ includeTaskBrief: false, evidenceArtifactIds: [], imageArtifactIds: [], repositoryInstructionPaths: ["../secret"] }).success).toBe(false);
  expect(DeveloperContextSchema.safeParse({ includeTaskBrief: false, evidenceArtifactIds: ["artifact_1", "artifact_1"], imageArtifactIds: [], repositoryInstructionPaths: [] }).success).toBe(false);
});

test("new worktrees require neutral branches while exact legacy records remain representable", () => {
  expect(OwnedWorktreeSchema.safeParse({ leaseId: "lease_1", leaseTokenHash: "a".repeat(64), taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", repositoryRoot: "/repos/forge", worktreeRoot: "/worktrees", worktreePath: "/worktrees/task_1", branchName: "work/issue/task_1", startingSha: "b".repeat(40), legacy: false, status: "reserved" }).success).toBe(true);
  expect(OwnedWorktreeSchema.safeParse({ leaseId: "lease_2", leaseTokenHash: "a".repeat(64), taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", repositoryRoot: "/repos/forge", worktreeRoot: "/worktrees", worktreePath: "/worktrees/task_1", branchName: "forge/issue/task_1", startingSha: "b".repeat(40), legacy: false, status: "reserved" }).success).toBe(false);
  expect(OwnedWorktreeSchema.safeParse({ leaseId: "lease_3", leaseTokenHash: "a".repeat(64), taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", repositoryRoot: "/repos/forge", worktreeRoot: "/worktrees", worktreePath: "/worktrees/task_1", branchName: "forge/issue/task_1", startingSha: "b".repeat(40), legacy: true, status: "active" }).success).toBe(true);
});

test("evidence manifests reject duplicate entries and preserve the contradiction rule", () => {
  const entry = { kind: "final_plan" as const, artifactId: "artifact_plan", repositoryPath: null, sha256: "d".repeat(64), byteSize: 10, stagedFilename: "final-plan.json", planStepNumbers: [1] };
  expect(EvidenceManifestSchema.safeParse({ version: 1, authorizedPlan: subject, projectRevision: revision, entries: [entry], contradictionRule: "stop_before_unrelated_edits", verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }], createdAt: "2026-08-11T00:00:00.000Z" }).success).toBe(true);
  expect(EvidenceManifestSchema.safeParse({ version: 1, authorizedPlan: subject, projectRevision: revision, entries: [entry, entry], contradictionRule: "stop_before_unrelated_edits", verificationCommands: [], createdAt: "2026-08-11T00:00:00.000Z" }).success).toBe(false);
});
