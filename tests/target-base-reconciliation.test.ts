import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ForgeDatabase } from "../src/database.js";
import { ForwardMergeService } from "../src/forward-merge.js";
import { AcceptedProjectRevisionSchema } from "../src/projects.js";
import {
  ArtifactReferenceSchema,
  IssueWorkflowStateSchema,
  ReconcileTargetBaseActivityInputSchema,
  ReconcileTargetBaseActivityResultSchema,
} from "../src/temporal/issue-contracts.js";
import { applyTargetBaseNoDrift, applyTargetBaseRevalidation } from "../src/temporal/target-base.js";

const sha = (letter: string) => letter.repeat(40);
const artifact = { id: "artifact_forward", sha256: "a".repeat(64), kind: "forward-merge-delivery" as const };

async function gitRepository(root: string): Promise<{ base: string; head: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.name", "Forge Test"], { cwd: root });
  await run("git", ["config", "user.email", "forge@example.test"], { cwd: root });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "base.txt"), "base\n");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-m", "base"], { cwd: root });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await run("git", ["checkout", "-b", "issue/task-1"], { cwd: root });
  await writeFile(join(root, "issue.txt"), "issue\n");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-m", "issue"], { cwd: root });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { base, head };
}

describe("target-base reconciliation contracts", () => {
  test("accepts every checkpoint and discriminated outcome", () => {
    const input = ReconcileTargetBaseActivityInputSchema.parse({
      taskId: "task-1",
      companyId: "company-1",
      workflowId: "workflow-1",
      projectRevisionId: "revision-1",
      checkpoint: "pre_acceptance",
      developerExecutionId: "developer-1",
      expectedBaseSha: sha("b"),
      expectedHeadSha: sha("c"),
      expectedHeadTree: sha("d"),
      forwardMergeId: "merge-1",
      verificationOnly: true,
    });
    expect(input.checkpoint).toBe("pre_acceptance");
    expect(input).toMatchObject({ forwardMergeId: "merge-1", verificationOnly: true });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "no_drift",
      checkId: "check-1",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("b"),
      headSha: sha("c"),
      headTree: sha("d"),
    })).toMatchObject({ outcome: "no_drift" });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "revalidated",
      checkId: "check-2",
      checkpoint: "pre_final_review",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      headSha: sha("f"),
      headTree: sha("9"),
      developerExecutionId: "developer-2",
      deliveryArtifact: artifact,
      verificationArtifact: { ...artifact, id: "artifact_forward_evidence", kind: "forward-merge-verification" },
    })).toMatchObject({ outcome: "revalidated" });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "conflict",
      checkId: "check-3",
      checkpoint: "pre_acceptance",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      conflictFileCount: 1,
      conflictArtifact: { ...artifact, id: "artifact_conflict", kind: "forward-merge-conflict" },
    })).toMatchObject({ outcome: "conflict" });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "blocked",
      checkId: "check-4",
      checkpoint: "pre_release",
      code: "provider_unavailable",
      owner: "provider",
      retryable: true,
      summary: "GitHub is temporarily unavailable",
    })).toMatchObject({ outcome: "blocked" });
  });

  test("allows a recorded forward merge to repair a stale workflow execution id", () => {
    const input = ReconcileTargetBaseActivityInputSchema.parse({
      taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: "revision-1", checkpoint: "pre_release",
      developerExecutionId: "developer-stale", expectedBaseSha: sha("b"), expectedHeadSha: sha("c"), expectedHeadTree: sha("d"), forwardMergeId: "merge-1",
    });
    expect(input.forwardMergeId).toBe("merge-1");
  });

  test("rejects raw conflict material, sentinel values, unknown blockers, and oversized summaries", () => {
    expect(() => ArtifactReferenceSchema.parse({ id: "artifact", sha256: sha("a") })).toThrow();
    expect(() => ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "conflict",
      checkId: "check-1",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      conflictFileCount: 1,
      conflictArtifact: { ...artifact, conflictDiff: "raw conflict" },
      releaseId: "",
      pullRequestNumber: 0,
    })).toThrow();
    expect(() => ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "blocked",
      checkId: "check-1",
      checkpoint: "pre_release",
      code: "unknown",
      owner: "lead",
      retryable: false,
      summary: "blocked",
    })).toThrow();
    expect(() => ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "blocked",
      checkId: "check-1",
      checkpoint: "pre_release",
      code: "merge_failed",
      owner: "lead",
      retryable: false,
      summary: "x".repeat(501),
    })).toThrow();
  });

  test("invalidates current authority while preserving only published identity", () => {
    const state = IssueWorkflowStateSchema.parse({
      workflowId: "workflow-1",
      companyId: "company-1",
      projectId: "project-1",
      issueId: "task-1",
      projectRevisionId: "revision-1",
      phase: "releasing",
      revision: 4,
      owner: "lead",
      allowedCommands: ["publish_draft"],
      pendingAction: "publish",
      lastEventId: "workflow-1:4",
      continuationCount: 0,
      lastSummaryHash: null,
      targetBaseSha: sha("b"),
      developerExecutionId: "developer-old",
      resultCommit: sha("c"),
      resultTree: sha("d"),
      deliveryArtifactId: "artifact-old",
      developerEvidenceArtifactId: "artifact-old-evidence",
      deliveryReviewId: "review-old",
      ciRunId: "ci-old",
      finalReviewId: "final-old",
      acceptanceId: "accept-old",
      releaseId: "release-1",
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/acme/repo/pull/12",
    });
    const next = applyTargetBaseRevalidation(IssueWorkflowStateSchema.parse({ ...state, deliveryReviewSupersedesId: "review-blocking", repairCycle: 1 }), {
      outcome: "revalidated",
      checkId: "check-5",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      headSha: sha("f"),
      headTree: sha("9"),
      developerExecutionId: "developer-new",
      deliveryArtifact: artifact,
      verificationArtifact: { ...artifact, id: "artifact-verification", kind: "forward-merge-verification" },
    });
    expect(next).toMatchObject({
      phase: "delivery_ready",
      owner: "lead",
      allowedCommands: ["review_delivery", "cancel_issue"],
      targetBaseSha: sha("e"),
      developerExecutionId: "developer-new",
      resultCommit: sha("f"),
      resultTree: sha("9"),
      deliveryArtifactId: artifact.id,
      developerEvidenceArtifactId: "artifact-verification",
      deliveryReviewId: null,
      deliveryReviewSupersedesId: null,
      repairCycle: 0,
      ciRunId: null,
      finalReviewId: null,
      acceptanceId: null,
      releaseId: "release-1",
      pullRequestNumber: 12,
    });
    const unpublished = applyTargetBaseRevalidation(IssueWorkflowStateSchema.parse({ ...state, releaseId: null, pullRequestNumber: null, pullRequestUrl: null }), {
      outcome: "revalidated",
      checkId: "check-5b",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      headSha: sha("f"),
      headTree: sha("9"),
      developerExecutionId: "developer-new",
      deliveryArtifact: artifact,
      verificationArtifact: { ...artifact, id: "artifact-verification-b", kind: "forward-merge-verification" },
    });
    expect(unpublished).toMatchObject({ releaseId: null, pullRequestNumber: null, pullRequestUrl: null });
    const resumed = applyTargetBaseNoDrift(IssueWorkflowStateSchema.parse({ ...state, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: "Provider unavailable", targetBaseBlockerCode: "provider_unavailable", targetBaseBlockerOwner: "provider", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Provider unavailable" }), {
      outcome: "no_drift",
      checkId: "check-6",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("b"),
      headSha: sha("c"),
      headTree: sha("d"),
    });
    expect(resumed).toMatchObject({ phase: "delivery_reviewed", owner: "lead", allowedCommands: ["publish_draft", "cancel_issue"], targetBaseBlockerCode: null });
  });

  test("installs reconciliation lineage columns without replacing legacy tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-migration-"));
    const database = new ForgeDatabase(join(root, "forge.sqlite"));
    try {
      const columns = database.authQuery((db) => db.prepare("PRAGMA table_info(forge_forward_merges)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["workflow_id", "project_revision_id", "checkpoint", "operation_key", "prior_tree", "result_head", "result_tree", "developer_execution_id", "conflict_artifact_id", "verification_artifact_id", "delivery_artifact_id", "supersedes_delivery_artifact_id", "invalidated_delivery_review_id", "release_id", "failure_code", "updated_at"]));
      expect(database.authQuery((db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'forge_forward_merges_operation_key_unique'").get())).toEqual(expect.objectContaining({ sql: expect.stringContaining("operation_key") }));
      expect(database.authQuery((db) => db.prepare("PRAGMA table_info(forge_developer_executions)").all() as Array<{ name: string; dflt_value: string }>).find((column) => column.name === "execution_kind")).toMatchObject({ dflt_value: "'agent'" });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the provider-observed base and performs no Git mutation when there is no drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-no-drift-"));
    try {
      const repository = await gitRepository(root);
      const calls: string[] = [];
      const result = await new ForwardMergeService(undefined, {
        async getBranchHead() { calls.push("observe"); return repository.base; },
        async getRemoteRepository() { calls.push("remote"); return "acme/repo"; },
      }).reconcile({ worktreePath: root, repositoryPath: root, repository: "acme/repo", baseBranch: "main", branchName: "issue/task-1", expectedBaseSha: repository.base, expectedHeadSha: repository.head, expectedHeadTree: (await (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" })).trim() });
      expect(result.status).toBe("no_drift");
      expect(calls).toEqual(["remote", "observe"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a base that advances during fetch without mutating either worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-race-"));
    const remote = join(root, "remote.git");
    const repository = join(root, "repository");
    const worktreeA = join(root, "worktrees", "a");
    const worktreeB = join(root, "worktrees", "b");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const git = (args: string[], cwd: string) => run("git", args, { cwd });
    try {
      await mkdir(repository, { recursive: true });
      await git(["init", "--bare", remote], root);
      await git(["init", "-b", "main"], repository);
      await git(["config", "user.name", "Forge Test"], repository);
      await git(["config", "user.email", "forge@example.test"], repository);
      await writeFile(join(repository, "base.txt"), "base\n");
      await git(["add", "."], repository); await git(["commit", "-m", "base"], repository);
      const oldBase = (await git(["rev-parse", "HEAD"], repository)).stdout.trim();
      await git(["remote", "add", "origin", remote], repository); await git(["push", "origin", "main"], repository);
      await mkdir(join(root, "worktrees"), { recursive: true });
      await git(["worktree", "add", "-b", "issue/task-a", worktreeA, "main"], repository);
      await git(["worktree", "add", "-b", "issue/task-b", worktreeB, "main"], repository);
      await writeFile(join(worktreeA, "issue.txt"), "issue\n"); await git(["add", "issue.txt"], worktreeA); await git(["commit", "-m", "issue"], worktreeA);
      const issueHead = (await git(["rev-parse", "HEAD"], worktreeA)).stdout.trim();
      const worktreeBHead = (await git(["rev-parse", "HEAD"], worktreeB)).stdout.trim();
      await writeFile(join(repository, "base.txt"), "base one\n"); await git(["add", "base.txt"], repository); await git(["commit", "-m", "base-one"], repository);
      const firstBase = (await git(["rev-parse", "HEAD"], repository)).stdout.trim(); await git(["push", "origin", "main"], repository);
      await writeFile(join(repository, "base.txt"), "base two\n"); await git(["add", "base.txt"], repository); await git(["commit", "-m", "base-two"], repository);
      const secondBase = (await git(["rev-parse", "HEAD"], repository)).stdout.trim(); await git(["push", "origin", "main"], repository);
      const tree = (await git(["rev-parse", "HEAD^{tree}"], worktreeA)).stdout.trim();
      let observations = 0;
      await expect(new ForwardMergeService(undefined, {
        async getRemoteRepository() { return "acme/forge"; },
        async getBranchHead() { observations += 1; return observations === 1 ? firstBase : secondBase; },
      }).reconcile({ worktreePath: worktreeA, repositoryPath: repository, repository: "acme/forge", baseBranch: "main", branchName: "issue/task-a", expectedBaseSha: oldBase, expectedHeadSha: issueHead, expectedHeadTree: tree })).rejects.toMatchObject({ code: "base-advanced-again" });
      expect((await git(["rev-parse", "HEAD"], worktreeA)).stdout.trim()).toBe(issueHead);
      expect((await git(["status", "--porcelain"], worktreeA)).stdout).toBe("");
      expect((await git(["rev-parse", "HEAD"], worktreeB)).stdout.trim()).toBe(worktreeBHead);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires the complete accepted project revision for reconciliation", () => {
    const valid = {
      repositoryPath: "/repositories/forge",
      worktreeRoot: "/worktrees",
      repository: "acme/forge",
      baseBranch: "main",
      targetBranch: "main",
      baseSha: sha("b"),
      targetSha: sha("c"),
      setupCommand: "pnpm install --frozen-lockfile",
      verificationCommand: "pnpm test",
      requiredChecks: ["Tests / unit"],
    };
    expect(AcceptedProjectRevisionSchema.parse(valid)).toEqual(valid);
    expect(() => AcceptedProjectRevisionSchema.parse({ ...valid, setupCommand: undefined })).toThrow();
  });
});
