import type { ReleaseActivities, PublishReleaseActivityInput, AdoptPullRequestReleaseActivityInput } from "../contracts/activities/release.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ActivityContext } from "./context.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { jsonRequired } from "../../task-utils.js";
import { proveForwardMergeLineage } from "./forward-merge-lineage.js";

const LegacyReleaseDeliverySchema = z.object({
  summary: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  commandsRun: z.array(z.string()).optional(),
  testResults: z.array(z.string()).optional(),
  steps: z.array(z.object({
    notes: z.string().optional(),
    filesChanged: z.array(z.string()).optional(),
    commandsRun: z.array(z.string()).optional(),
    testResults: z.array(z.string()).optional(),
  }).passthrough()).default([]),
}).passthrough();

export function releaseDeliveryProjection(value: unknown): { summary?: string; changes?: string[]; filesChanged?: string[]; commandsRun?: string[]; testResults?: string[] } {
  const legacy = LegacyReleaseDeliverySchema.parse(value);
  return {
    ...(legacy.summary ? { summary: legacy.summary } : {}),
    changes: legacy.steps.flatMap((step) => step.notes ? [step.notes] : []),
    filesChanged: [...(legacy.filesChanged ?? []), ...legacy.steps.flatMap((step) => step.filesChanged ?? [])],
    commandsRun: [...(legacy.commandsRun ?? []), ...legacy.steps.flatMap((step) => step.commandsRun ?? [])],
    testResults: [...(legacy.testResults ?? []), ...legacy.steps.flatMap((step) => step.testResults ?? [])],
  };
}

type ReleaseContextInput = {
  taskId: string;
  companyId: string;
  workflowId: string;
  branchName: string;
  subjectCommit: string;
} & ({ kind: "push" } | {
  kind: "publish";
  reviewId: string;
  developerExecutionId: string;
  targetBaseSha: string;
  subjectTree: string;
});

type DeliveryArtifactContext = {
  id: string;
  storagePath: string;
  sha256: string;
};

type ReleaseContext = {
  developerExecutionId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string | null;
  reviewId: string | null;
  title: string;
  delivery: DeliveryArtifactContext | null;
};

type ForwardMergeReleaseCandidate = {
  title: string;
  forwardMergeId: string;
  projectRevisionId: string;
  checkpoint: string;
  expectedBaseSha: string;
  currentBaseSha: string;
  priorHead: string;
  priorTree: string | null;
  mergeCommit: string | null;
  mergeTree: string | null;
  resultHead: string | null;
  resultTree: string | null;
  developerExecutionId: string;
  developerStatus: string;
  branchName: string;
  worktreePath: string;
  developerTargetBaseSha: string;
  developerResultCommit: string | null;
  developerResultTree: string | null;
  reviewId: string;
  reviewBaseSha: string;
  reviewSubjectCommit: string;
  reviewSubjectTree: string;
};

function sameRevision(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function deliveryArtifactFromLineage(db: Database.Database, input: ReleaseContextInput, executionId: string): DeliveryArtifactContext | undefined {
  const visited = new Set<string>();
  let currentId: string | null = executionId;
  while (currentId) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const execution = db.prepare(`SELECT delivery_artifact_id AS deliveryArtifactId, supersedes_execution_id AS supersedesExecutionId
      FROM forge_developer_executions
      WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(currentId, input.taskId, input.companyId, input.workflowId) as { deliveryArtifactId: string | null; supersedesExecutionId: string | null } | undefined;
    if (!execution) return undefined;
    if (execution.deliveryArtifactId) {
      return db.prepare(`SELECT id, storage_path AS storagePath, sha256
        FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'developer-delivery'`).get(execution.deliveryArtifactId, input.companyId) as DeliveryArtifactContext | undefined;
    }
    currentId = execution.supersedesExecutionId;
  }
  return undefined;
}

function directReleaseContext(db: Database.Database, input: ReleaseContextInput): ReleaseContext | undefined {
  if (input.kind === "push") {
    const direct = db.prepare(`SELECT d.id AS developerExecutionId, d.worktree_path AS worktreePath, d.branch_name AS branchName,
        d.target_base_sha AS targetBaseSha, d.result_commit AS subjectCommit, d.result_tree AS subjectTree, t.title
      FROM forge_tasks t
      JOIN forge_developer_executions d
        ON d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id
        AND d.branch_name = ? AND lower(d.result_commit) = lower(?) AND d.status = 'completed'
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).get(input.branchName, input.subjectCommit, input.taskId, input.companyId, input.workflowId) as Omit<ReleaseContext, "delivery" | "reviewId"> | undefined;
    return direct ? { ...direct, reviewId: null, delivery: null } : undefined;
  }
  const findCompletedExecution = (developerExecutionId: string | null) => db.prepare(`SELECT d.id AS developerExecutionId, d.worktree_path AS worktreePath, d.branch_name AS branchName,
      d.target_base_sha AS targetBaseSha, d.result_commit AS subjectCommit, d.result_tree AS subjectTree,
      da.id AS deliveryArtifactId, da.storage_path AS deliveryStoragePath, da.sha256 AS deliverySha,
      r.id AS reviewId, t.title
    FROM forge_tasks t
    JOIN forge_developer_executions d
      ON (? IS NULL OR d.id = ?) AND d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id
      AND d.status = 'completed' AND d.branch_name = ?
      AND lower(d.target_base_sha) = lower(?) AND lower(d.result_commit) = lower(?) AND lower(d.result_tree) = lower(?)
    JOIN forge_delivery_reviews r
      ON r.id = ? AND r.task_id = t.id AND r.company_id = t.company_id AND r.workflow_id = t.workflow_id
      AND lower(r.base_sha) = lower(?) AND lower(r.subject_commit) = lower(?) AND lower(r.subject_tree) = lower(?)
      AND (r.outcome = 'approved' OR EXISTS (SELECT 1 FROM forge_delivery_decisions dd WHERE dd.task_id = t.id AND dd.workflow_id = t.workflow_id AND dd.created_at >= r.created_at))
    JOIN forge_artifacts da
      ON da.id = d.delivery_artifact_id AND da.company_id = d.company_id
      AND da.kind IN ('developer-delivery', 'developer-repair', 'forward-merge-delivery')
    WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).all(developerExecutionId, developerExecutionId, input.branchName, input.targetBaseSha, input.subjectCommit, input.subjectTree, input.reviewId, input.targetBaseSha, input.subjectCommit, input.subjectTree, input.taskId, input.companyId, input.workflowId) as Array<Omit<ReleaseContext, "delivery"> & { deliveryArtifactId: string; deliveryStoragePath: string; deliverySha: string }>;
  const direct = findCompletedExecution(input.developerExecutionId);
  const fallback = direct.length === 0 ? findCompletedExecution(null) : [];
  const context = direct.length === 1 ? direct[0] : fallback.length === 1 ? fallback[0] : undefined;
  if (!context) return undefined;
  return { ...context, delivery: { id: context.deliveryArtifactId, storagePath: context.deliveryStoragePath, sha256: context.deliverySha } };
}

function forwardMergeReleaseContext(db: Database.Database, input: ReleaseContextInput): ReleaseContext | undefined {
  const candidates = db.prepare(`SELECT t.title, m.id AS forwardMergeId, m.project_revision_id AS projectRevisionId,
      m.checkpoint, m.expected_base_sha AS expectedBaseSha,
      m.current_base_sha AS currentBaseSha, m.prior_head AS priorHead, m.prior_tree AS priorTree,
      m.merge_commit AS mergeCommit, m.tree AS mergeTree, m.result_head AS resultHead, m.result_tree AS resultTree,
      d.id AS developerExecutionId, d.status AS developerStatus, d.branch_name AS branchName,
      d.worktree_path AS worktreePath, d.target_base_sha AS developerTargetBaseSha,
      d.result_commit AS developerResultCommit, d.result_tree AS developerResultTree,
      r.id AS reviewId, r.base_sha AS reviewBaseSha, r.subject_commit AS reviewSubjectCommit,
      r.subject_tree AS reviewSubjectTree
    FROM forge_tasks t
    JOIN forge_forward_merges m
      ON m.task_id = t.id AND m.company_id = t.company_id AND m.workflow_id = t.workflow_id
      AND m.status = 'merged' AND lower(m.result_head) = lower(?)
      AND m.project_revision_id = t.project_configuration_artifact_id AND m.checkpoint = 'pre_release'
    JOIN forge_developer_executions d
      ON d.id = m.developer_execution_id AND d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id
      AND d.branch_name = ?
    JOIN forge_delivery_reviews r
      ON r.task_id = t.id AND r.company_id = t.company_id AND r.workflow_id = t.workflow_id
      AND r.outcome = 'approved' AND lower(r.subject_commit) = lower(?)
    JOIN forge_artifacts verification
      ON verification.id = m.verification_artifact_id AND verification.company_id = m.company_id
      AND verification.kind = 'forward-merge-verification'
    WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?
    ORDER BY COALESCE(m.updated_at, m.created_at) DESC, m.id DESC`).all(input.subjectCommit, input.branchName, input.subjectCommit, input.taskId, input.companyId, input.workflowId) as ForwardMergeReleaseCandidate[];
  const contexts: ReleaseContext[] = [];
  const provenMergeIds = new Set<string>();
  for (const candidate of candidates) {
    const lineage = proveForwardMergeLineage(db, { currentMergeId: candidate.forwardMergeId, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: candidate.projectRevisionId, checkpoint: candidate.checkpoint, developerExecutionId: candidate.developerExecutionId });
    if (!sameRevision(candidate.resultHead, input.subjectCommit)
      || !sameRevision(candidate.mergeCommit, candidate.resultHead)
      || !sameRevision(candidate.mergeTree, candidate.resultTree)
      || !sameRevision(candidate.reviewSubjectCommit, candidate.resultHead)
      || !sameRevision(candidate.reviewSubjectTree, candidate.resultTree)
      || !sameRevision(candidate.reviewBaseSha, candidate.currentBaseSha)
      || !["completed", "blocked"].includes(candidate.developerStatus)
      || !lineage
      || lineage.developer.id !== candidate.developerExecutionId || lineage.developer.status !== candidate.developerStatus
      || !sameRevision(lineage.developer.targetBaseSha, candidate.developerTargetBaseSha)
      || !sameRevision(lineage.developer.resultHead, candidate.developerResultCommit) || !sameRevision(lineage.developer.resultTree, candidate.developerResultTree)
      || lineage.current.id !== candidate.forwardMergeId
      || !sameRevision(lineage.current.expectedBaseSha, candidate.expectedBaseSha) || !sameRevision(lineage.current.currentBaseSha, candidate.currentBaseSha)
      || !sameRevision(lineage.current.priorHead, candidate.priorHead) || !sameRevision(lineage.current.priorTree, candidate.priorTree)
      || !sameRevision(lineage.current.resultHead, candidate.resultHead) || !sameRevision(lineage.current.resultTree, candidate.resultTree)
      || input.kind === "publish" && (candidate.developerExecutionId !== input.developerExecutionId
        || candidate.reviewId !== input.reviewId
        || !sameRevision(candidate.resultTree, input.subjectTree)
        || !sameRevision(candidate.currentBaseSha, input.targetBaseSha))) continue;
    const delivery = deliveryArtifactFromLineage(db, input, candidate.developerExecutionId);
    if (!delivery) continue;
    provenMergeIds.add(candidate.forwardMergeId);
    contexts.push({ developerExecutionId: candidate.developerExecutionId, worktreePath: candidate.worktreePath, branchName: candidate.branchName, targetBaseSha: candidate.currentBaseSha, subjectCommit: candidate.resultHead!, subjectTree: candidate.resultTree, reviewId: candidate.reviewId, title: candidate.title, delivery });
  }
  const [context] = contexts;
  if (!context || provenMergeIds.size !== 1) return undefined;
  const identity = [context.developerExecutionId, context.worktreePath, context.branchName, context.targetBaseSha, context.subjectCommit, context.subjectTree, context.reviewId, context.delivery!.id].join("|");
  return contexts.every((candidate) => [candidate.developerExecutionId, candidate.worktreePath, candidate.branchName, candidate.targetBaseSha, candidate.subjectCommit, candidate.subjectTree, candidate.reviewId, candidate.delivery!.id].join("|") === identity) ? context : undefined;
}

function resolveReleaseContext(db: Database.Database, input: ReleaseContextInput): ReleaseContext | undefined {
  return directReleaseContext(db, input) ?? forwardMergeReleaseContext(db, input);
}

export function createReleaseActivities(ctx: ActivityContext): ReleaseActivities {
  const { database, createHash, randomBytes, ApplicationFailure, GithubReleaseFailure, PublishReleaseActivityResultSchema, githubRelease, artifacts, release } = ctx;
  return {
    async pushDeliveryBranch(input) {
      try {
      const context = database.authQuery((db) => resolveReleaseContext(db, { kind: "push", taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, branchName: input.branchName, subjectCommit: input.commitSha }));
      if (!context) throw new GithubReleaseFailure("stale-reviewed-revision", "The reviewed revision does not match a completed build");
      let pinned: ReturnType<ActivityContext["pinnedProjectRevision"]>;
      try { pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); } catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "The task project configuration is incomplete"); }
      await release.pushBranch({ repository: pinned.repository, worktreePath: context.worktreePath, branchName: input.branchName, commitSha: input.commitSha });
        return { repository: pinned.repository, branchName: input.branchName, commitSha: input.commitSha };
      } catch (error) {
        if (error instanceof GithubReleaseFailure) throw ApplicationFailure.nonRetryable(error.summary, error.code, { code: error.code, summary: error.summary });
        throw error;
      }
    },
    async adoptPullRequestRelease(input: AdoptPullRequestReleaseActivityInput) {
      if (!githubRelease.getCommitTree) throw new GithubReleaseFailure("provider-unavailable", "GitHub commit inspection is unavailable");
      const pullRequest = await githubRelease.getPullRequest({ repository: input.repository, number: input.pullRequestNumber });
      if (pullRequest.state !== "open" || pullRequest.repository.toLowerCase() !== input.repository.toLowerCase() || pullRequest.headBranch !== input.branchName || pullRequest.headSha.toLowerCase() !== input.headSha.toLowerCase() || pullRequest.baseBranch !== input.baseBranch || (input.expectedBaseSha && pullRequest.baseSha.toLowerCase() !== input.expectedBaseSha.toLowerCase())) throw new GithubReleaseFailure("stale-reviewed-revision", "The pull request no longer matches the observed CI identity");
      const headTree = await githubRelease.getCommitTree({ repository: input.repository, commitSha: input.headSha });
      const releaseKey = createHash("sha256").update([input.workflowId, input.projectRevisionId, input.repository, input.branchName, input.baseBranch, input.headSha, headTree].join("|"), "utf8").digest("hex");
      const now = new Date().toISOString();
      const releaseId = `release_${randomBytes(12).toString("hex")}`;
      database.authTransaction((db) => {
        db.prepare(`INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, reused, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 1, ?, ?, ?)
          ON CONFLICT(release_key) DO UPDATE SET repository = excluded.repository, head_branch = excluded.head_branch, base_branch = excluded.base_branch, base_sha = excluded.base_sha, head_sha = excluded.head_sha, head_tree = excluded.head_tree, status = 'ready', pr_number = excluded.pr_number, pr_url = excluded.pr_url, reused = 1, title = excluded.title, updated_at = excluded.updated_at`)
          .run(releaseId, input.taskId, input.companyId, input.workflowId, releaseKey, input.repository, input.branchName, input.baseBranch, pullRequest.baseSha, input.headSha, headTree, pullRequest.number, pullRequest.url, pullRequest.title || `Pull request #${pullRequest.number}`, now, now);
      });
      const release = database.authQuery((db) => db.prepare("SELECT id FROM forge_releases WHERE release_key = ?").get(releaseKey) as { id: string });
      return { releaseId: release.id, repository: input.repository, branchName: input.branchName, baseBranch: input.baseBranch, targetBaseSha: pullRequest.baseSha, headSha: input.headSha, headTree, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.url };
    },
    async publishRelease(input: PublishReleaseActivityInput) {
      let identity = { repository: "", branchName: input.branchName, headSha: input.subjectCommit, headTree: input.subjectTree };
      try {
        const context = database.authQuery((db) => resolveReleaseContext(db, { kind: "publish", taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, branchName: input.branchName, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree, reviewId: input.reviewId, developerExecutionId: input.developerExecutionId }));
        if (!context?.delivery || !context.reviewId || !context.subjectTree) throw new GithubReleaseFailure("stale-reviewed-revision", "The exact approved Developer revision is unavailable");
        identity = { repository: "", branchName: context.branchName, headSha: context.subjectCommit, headTree: context.subjectTree };
        let pinned: ReturnType<ActivityContext["pinnedProjectRevision"]> & { artifactId: string };
        try { pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); } catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "The task project configuration is incomplete"); }
        identity.repository = pinned.repository;
        let delivery: ReturnType<typeof releaseDeliveryProjection>;
        try { delivery = releaseDeliveryProjection(jsonRequired(artifacts.getArtifactSync({ companyId: input.companyId, storagePath: context.delivery.storagePath, sha256: context.delivery.sha256 }).toString("utf8"))); }
        catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "Completed delivery artifact is unavailable"); }
        const result = await release.publish({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, ...(input.releaseId ? { releaseId: input.releaseId } : {}), coordinates: { projectRevisionId: pinned.artifactId, repositoryPath: pinned.repositoryPath, worktreePath: context.worktreePath, repository: pinned.repository, owner: pinned.repository.split("/")[0]!, headBranch: context.branchName, baseBranch: pinned.baseBranch, expectedBaseSha: context.targetBaseSha }, reviewedRevision: { reviewId: context.reviewId, developerExecutionId: context.developerExecutionId, commitSha: context.subjectCommit, treeSha: context.subjectTree }, taskTitle: context.title, delivery });
        if (input.pullRequestMode !== undefined && input.pullRequestMode !== "draft") await release.markReadyForReview({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, releaseId: result.releaseId, repository: result.repository, pullRequestNumber: result.pullRequest.number });
        return PublishReleaseActivityResultSchema.parse({ outcome: "completed", releaseId: result.releaseId, repository: result.repository, branchName: result.branchName, baseBranch: result.baseBranch, headSha: result.headSha, headTree: result.headTree, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url, isDraft: input.pullRequestMode === undefined || input.pullRequestMode === "draft" ? result.pullRequest.isDraft : false, reused: result.reused, attempt: result.attempt, targetBaseSha: context.targetBaseSha });
      } catch (error) {
        const failure = error instanceof GithubReleaseFailure ? error : new GithubReleaseFailure("provider-unavailable", `Could not open the pull request: ${error instanceof Error ? error.message : String(error)}`);
        const operation = database.authQuery((db) => db.prepare("SELECT MAX(COALESCE(attempt, 0)) AS attempt FROM forge_provider_operations WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND kind IN ('push', 'create-draft-pr', 'update-draft-pr')").get(input.taskId, input.companyId, input.workflowId) as { attempt: number | null });
        return PublishReleaseActivityResultSchema.parse({ outcome: "blocked", releaseId: null, ...identity, pullRequestNumber: null, pullRequestUrl: null, isDraft: true, reused: false, code: failure.code, summary: failure.summary, retryAt: failure.retryAt, attempt: operation.attempt ?? 0 });
      }
    },
  };
}
