import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type { ArtifactStore } from "../../artifacts.js";
import type { ForgeDatabase } from "../../database.js";
import type { GithubReleaseAdapter } from "../../github-release.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import {
  RecoverRevalidatedDeliveryReviewResultSchema,
  type RecoverRevalidatedDeliveryReviewInput,
  type RecoverRevalidatedDeliveryReviewResult,
} from "../contracts/activities/delivery-review.js";
import { proveForwardMergeLineage } from "./forward-merge-lineage.js";

const SUBJECT_SUMMARY = "The approved delivery history no longer matches this task. Restore the task records, then retry the review.";
const WORKTREE_SUMMARY = "The task worktree changed or is busy. Restore the reviewed branch, then retry the review.";
const ACTIVE_TURN_STATUSES = ["created", "dispatching", "waiting", "blocked", "awaiting_human", "validating", "correction_required"];

type ArtifactRow = {
  id: string;
  kind: string;
  taskId: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  mimeType: string;
};

type MergeRow = {
  id: string;
  checkpoint: "pre_release" | "pre_final_review" | "pre_acceptance" | "ci_update_from_base";
  expectedBaseSha: string;
  currentBaseSha: string;
  priorHead: string;
  priorTree: string;
  mergeCommit: string;
  mergeTree: string;
  resultHead: string;
  resultTree: string;
  developerExecutionId: string;
  verificationArtifactId: string;
  verificationArtifactSha256: string | null;
  deliveryArtifactId: string;
  deliveryArtifactSha256: string | null;
  status: string;
};

type DeveloperRow = {
  id: string;
  planRevision: number;
  status: string;
  executionKind: string;
  branchName: string;
  worktreePath: string;
  targetBaseSha: string;
  sessionRef: string | null;
  finishedAt: string | null;
  resultCommit: string | null;
  resultTree: string | null;
  dirtyState: string | null;
  deliveryArtifactId: string | null;
  evidenceArtifactId: string | null;
};

type ReviewRow = {
  attemptId: string;
  correctionAttempts: number | null;
  attemptPlanRevision: number;
  attemptBaseSha: string;
  attemptSubjectCommit: string;
  attemptSubjectTree: string;
  attemptDeveloperExecutionId: string | null;
  attemptDeliveryArtifactId: string | null;
  attemptDeveloperEvidenceArtifactId: string | null;
  attemptLeadExecutionId: string;
  attemptLeadSessionRef: string;
  attemptDeveloperSessionRef: string | null;
  attemptEvidenceArtifactId: string | null;
  attemptCompletedReviewId: string | null;
  attemptSupersedesReviewId: string | null;
  attemptFinishedAt: string | null;
  reviewId: string;
  reviewPlanRevision: number;
  reviewBaseSha: string;
  reviewSubjectCommit: string;
  reviewSubjectTree: string;
  reviewLeadExecutionId: string;
  reviewSessionRef: string;
  reviewOutcome: string;
  reviewSummary: string;
  opinionArtifactId: string;
  reviewEvidenceArtifactId: string;
  reviewSupersedesReviewId: string | null;
  leadStatus: string;
  leadSessionRef: string | null;
  leadEvidenceArtifactId: string | null;
  leadFinishedAt: string | null;
};

function same(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

function blocked(code: "subject-changed" | "worktree-unsafe", summary: string): RecoverRevalidatedDeliveryReviewResult {
  return RecoverRevalidatedDeliveryReviewResultSchema.parse({ outcome: "blocked", code, summary });
}

async function verifiedArtifact(
  database: ForgeDatabase,
  artifacts: ArtifactStore,
  input: RecoverRevalidatedDeliveryReviewInput,
  artifactId: string,
  kind: string,
): Promise<ArtifactRow> {
  const row = database.authQuery((db) => db.prepare(`SELECT id, kind, task_id AS taskId, byte_size AS byteSize,
      sha256, storage_path AS storagePath, mime_type AS mimeType
    FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = ?`).get(artifactId, input.companyId, kind) as ArtifactRow | undefined);
  if (!row || row.taskId && row.taskId !== input.taskId) throw new Error("Scoped artifact is unavailable");
  const bytes = await artifacts.getArtifact({ companyId: input.companyId, storagePath: row.storagePath, sha256: row.sha256 });
  if (bytes.byteLength !== row.byteSize || createHash("sha256").update(bytes).digest("hex") !== row.sha256.toLowerCase()) throw new Error("Scoped artifact bytes do not match");
  return row;
}

export async function recoverReviewedDelivery(
  database: ForgeDatabase,
  artifacts: ArtifactStore,
  githubRelease: GithubReleaseAdapter,
  input: RecoverRevalidatedDeliveryReviewInput,
): Promise<RecoverRevalidatedDeliveryReviewResult> {
  let merge: MergeRow;
  let developer: DeveloperRow;
  let review: ReviewRow;
  let opinionArtifact: ArtifactRow;
  let pinned: ReturnType<typeof loadTaskConfiguration>;
  try {
    const task = database.authQuery((db) => db.prepare(`SELECT id FROM forge_tasks
      WHERE id = ? AND company_id = ? AND workflow_id = ? AND project_id = ?
        AND project_revision_id = ? AND project_configuration_artifact_id = ?`).get(
      input.taskId, input.companyId, input.workflowId, input.projectId,
      input.projectRevisionId, input.projectRevisionId,
    ));
    if (!task) throw new Error("Task scope does not match");

    await verifiedArtifact(database, artifacts, input, input.projectRevisionId, "task-project-configuration");
    await verifiedArtifact(database, artifacts, input, input.leadOutputArtifactId, "lead-plan");
    pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input));
    if (pinned.artifactId !== input.projectRevisionId || pinned.projectId !== input.projectId) throw new Error("Task configuration does not match");

    merge = database.authQuery((db) => db.prepare(`SELECT id, checkpoint, expected_base_sha AS expectedBaseSha,
        current_base_sha AS currentBaseSha, prior_head AS priorHead, prior_tree AS priorTree,
        merge_commit AS mergeCommit, tree AS mergeTree, result_head AS resultHead, result_tree AS resultTree,
        developer_execution_id AS developerExecutionId, verification_artifact_id AS verificationArtifactId,
        verification_artifact_sha256 AS verificationArtifactSha256, delivery_artifact_id AS deliveryArtifactId,
        delivery_artifact_sha256 AS deliveryArtifactSha256, status
      FROM forge_forward_merges
      WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND project_revision_id = ?`).get(
      input.forwardMergeId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId,
    ) as MergeRow | undefined) as MergeRow;
    if (!merge || merge.status !== "merged" || !merge.checkpoint || !merge.priorTree || !merge.mergeCommit || !merge.mergeTree
      || !merge.resultHead || !merge.resultTree || !merge.verificationArtifactId || !merge.deliveryArtifactId
      || merge.developerExecutionId !== input.developerExecutionId
      || !same(merge.priorHead, input.forwardMergePriorHead) || !same(merge.priorTree, input.forwardMergePriorTree)
      || !same(merge.currentBaseSha, input.forwardMergeTargetBaseSha)
      || !same(merge.mergeCommit, merge.resultHead) || !same(merge.mergeTree, merge.resultTree)) throw new Error("Merge record does not match");

    const lineage = database.authQuery((db) => proveForwardMergeLineage(db, {
      currentMergeId: merge.id,
      taskId: input.taskId,
      companyId: input.companyId,
      workflowId: input.workflowId,
      projectRevisionId: input.projectRevisionId,
      checkpoint: merge.checkpoint,
      developerExecutionId: input.developerExecutionId,
    }));
    if (!lineage || lineage.current.id !== merge.id || lineage.developer.id !== input.developerExecutionId
      || !same(lineage.current.priorHead, merge.priorHead) || !same(lineage.current.priorTree, merge.priorTree)
      || !same(lineage.current.currentBaseSha, merge.currentBaseSha)
      || !same(lineage.current.resultHead, merge.resultHead) || !same(lineage.current.resultTree, merge.resultTree)) throw new Error("Merge history is unavailable");

    developer = database.authQuery((db) => db.prepare(`SELECT id, plan_revision AS planRevision, status,
        execution_kind AS executionKind, branch_name AS branchName, worktree_path AS worktreePath,
        target_base_sha AS targetBaseSha, session_ref AS sessionRef, finished_at AS finishedAt,
        result_commit AS resultCommit, result_tree AS resultTree, dirty_state AS dirtyState,
        delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId
      FROM forge_developer_executions
      WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(
      input.developerExecutionId, input.taskId, input.companyId, input.workflowId,
    ) as DeveloperRow | undefined) as DeveloperRow;
    if (!developer || developer.status !== "completed" || developer.executionKind !== "forward_merge" || !developer.finishedAt
      || developer.branchName !== input.branchName || developer.worktreePath !== input.worktreePath
      || developer.sessionRef !== input.developerSessionRef || developer.dirtyState !== "clean"
      || developer.deliveryArtifactId !== input.deliveryArtifactId || developer.evidenceArtifactId !== input.developerEvidenceArtifactId
      || merge.deliveryArtifactId !== developer.deliveryArtifactId
      || !same(developer.targetBaseSha, merge.currentBaseSha)
      || !same(developer.resultCommit, merge.resultHead) || !same(developer.resultTree, merge.resultTree)) throw new Error("Developer record does not match");

    const activeDeveloper = database.authQuery((db) => db.prepare(`SELECT id FROM forge_developer_executions
      WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND worktree_path = ?
        AND status IN ('starting', 'running', 'cancelling') LIMIT 1`).get(
      input.taskId, input.companyId, input.workflowId, input.worktreePath,
    ));
    const activeTurn = database.authQuery((db) => db.prepare(`SELECT turn.turn_id FROM forge_herdr_turns turn
      JOIN forge_herdr_role_sessions session
        ON session.id = turn.role_session_id AND session.task_id = turn.task_id AND session.is_current = 1
      JOIN forge_developer_executions execution
        ON turn.ledger = 'developer' AND execution.id = turn.execution_id AND execution.task_id = turn.task_id
      WHERE turn.task_id = ? AND execution.company_id = ? AND execution.workflow_id = ?
        AND execution.worktree_path = ? AND turn.execution_role IN ('builder', 'integrator')
        AND turn.status IN (${ACTIVE_TURN_STATUSES.map(() => "?").join(", ")}) LIMIT 1`).get(
      input.taskId, input.companyId, input.workflowId, input.worktreePath, ...ACTIVE_TURN_STATUSES,
    ));
    if (activeDeveloper || activeTurn) return blocked("worktree-unsafe", WORKTREE_SUMMARY);

    const reviews = database.authQuery((db) => db.prepare(`SELECT
        attempt.id AS attemptId, attempt.correction_attempts AS correctionAttempts,
        attempt.plan_revision AS attemptPlanRevision, attempt.base_sha AS attemptBaseSha,
        attempt.subject_commit AS attemptSubjectCommit, attempt.subject_tree AS attemptSubjectTree,
        attempt.developer_execution_id AS attemptDeveloperExecutionId,
        attempt.delivery_artifact_id AS attemptDeliveryArtifactId,
        attempt.developer_evidence_artifact_id AS attemptDeveloperEvidenceArtifactId,
        attempt.lead_execution_id AS attemptLeadExecutionId,
        attempt.lead_session_ref AS attemptLeadSessionRef,
        attempt.developer_session_ref AS attemptDeveloperSessionRef,
        attempt.evidence_artifact_id AS attemptEvidenceArtifactId,
        attempt.completed_review_id AS attemptCompletedReviewId,
        attempt.supersedes_review_id AS attemptSupersedesReviewId,
        attempt.finished_at AS attemptFinishedAt,
        review.id AS reviewId, review.plan_revision AS reviewPlanRevision,
        review.base_sha AS reviewBaseSha, review.subject_commit AS reviewSubjectCommit,
        review.subject_tree AS reviewSubjectTree, review.lead_execution_id AS reviewLeadExecutionId,
        review.session_ref AS reviewSessionRef, review.outcome AS reviewOutcome,
        review.summary AS reviewSummary, review.opinion_artifact_id AS opinionArtifactId,
        review.evidence_artifact_id AS reviewEvidenceArtifactId,
        review.supersedes_review_id AS reviewSupersedesReviewId,
        lead.status AS leadStatus, lead.session_ref AS leadSessionRef,
        lead.evidence_artifact_id AS leadEvidenceArtifactId, lead.finished_at AS leadFinishedAt
      FROM forge_delivery_review_attempts attempt
      JOIN forge_delivery_reviews review
        ON review.id = attempt.completed_review_id AND review.task_id = attempt.task_id
        AND review.company_id = attempt.company_id AND review.workflow_id = attempt.workflow_id
      JOIN forge_agent_executions lead
        ON lead.id = review.lead_execution_id AND lead.task_id = review.task_id
        AND lead.company_id = review.company_id AND lead.workflow_id = review.workflow_id
      WHERE attempt.task_id = ? AND attempt.company_id = ? AND attempt.workflow_id = ?
        AND attempt.status = 'completed' AND lower(attempt.base_sha) = lower(?)
        AND lower(attempt.subject_commit) = lower(?) AND lower(attempt.subject_tree) = lower(?)
        AND lower(review.base_sha) = lower(?) AND lower(review.subject_commit) = lower(?)
        AND lower(review.subject_tree) = lower(?)`).all(
      input.taskId, input.companyId, input.workflowId,
      merge.currentBaseSha, merge.resultHead, merge.resultTree,
      merge.currentBaseSha, merge.resultHead, merge.resultTree,
    ) as ReviewRow[]);
    if (reviews.length !== 1) throw new Error("Review record is missing or duplicated");
    review = reviews[0]!;
    if (review.reviewOutcome !== "approved" || !review.attemptFinishedAt || !review.leadFinishedAt
      || review.leadStatus !== "completed" || review.correctionAttempts === null
      || review.correctionAttempts < 0 || review.correctionAttempts > 1
      || review.attemptPlanRevision !== developer.planRevision || review.reviewPlanRevision !== developer.planRevision
      || review.attemptDeveloperExecutionId !== developer.id
      || review.attemptDeliveryArtifactId !== developer.deliveryArtifactId
      || review.attemptDeveloperEvidenceArtifactId !== developer.evidenceArtifactId
      || review.attemptLeadSessionRef !== input.leadSessionRef
      || review.attemptDeveloperSessionRef !== input.developerSessionRef
      || review.attemptCompletedReviewId !== review.reviewId
      || review.attemptLeadExecutionId !== review.reviewLeadExecutionId
      || review.leadSessionRef !== review.reviewSessionRef
      || review.attemptEvidenceArtifactId !== review.reviewEvidenceArtifactId
      || review.leadEvidenceArtifactId !== review.reviewEvidenceArtifactId
      || review.attemptSupersedesReviewId !== review.reviewSupersedesReviewId) throw new Error("Review record does not match");

    const deliveryArtifact = await verifiedArtifact(database, artifacts, input, input.deliveryArtifactId, "forward-merge-delivery");
    await verifiedArtifact(database, artifacts, input, input.developerEvidenceArtifactId, "agent-evidence");
    const verificationArtifact = await verifiedArtifact(database, artifacts, input, merge.verificationArtifactId, "forward-merge-verification");
    opinionArtifact = await verifiedArtifact(database, artifacts, input, review.opinionArtifactId, "delivery-review");
    await verifiedArtifact(database, artifacts, input, review.reviewEvidenceArtifactId, "agent-evidence");
    if (merge.verificationArtifactSha256 && !same(merge.verificationArtifactSha256, verificationArtifact.sha256)
      || merge.deliveryArtifactSha256 && !same(merge.deliveryArtifactSha256, deliveryArtifact.sha256)) throw new Error("Merge artifact does not match");
  } catch {
    return blocked("subject-changed", SUBJECT_SUMMARY);
  }

  try {
    const [worktreeRoot, worktreePath] = await Promise.all([realpath(pinned.worktreeRoot), realpath(input.worktreePath)]);
    if (!inside(worktreeRoot, worktreePath)) return blocked("worktree-unsafe", WORKTREE_SUMMARY);
    const repository = await githubRelease.getRemoteRepository({ cwd: input.worktreePath });
    if (repository.toLowerCase() !== pinned.repository.toLowerCase()) return blocked("worktree-unsafe", WORKTREE_SUMMARY);
    const local = await githubRelease.inspectLocalRevision({ cwd: input.worktreePath });
    if (local.branch !== input.branchName) return blocked("worktree-unsafe", WORKTREE_SUMMARY);
  } catch {
    return blocked("worktree-unsafe", WORKTREE_SUMMARY);
  }

  const findings = database.authQuery((db) => db.prepare(`SELECT id AS findingId, severity, rationale,
      evidence_ref AS evidenceRef, disposition, repair_instruction AS repairInstruction
    FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id`).all(
    review.reviewId, input.taskId, input.companyId,
  ));
  return RecoverRevalidatedDeliveryReviewResultSchema.parse({
    outcome: "recovered",
    forwardMergeId: merge.id,
    checkpoint: merge.checkpoint,
    developerExecutionId: developer.id,
    targetBaseSha: merge.currentBaseSha,
    subjectCommit: merge.resultHead,
    subjectTree: merge.resultTree,
    review: {
      outcome: "completed",
      attemptId: review.attemptId,
      correctionAttempts: review.correctionAttempts,
      subject: {
        planRevision: developer.planRevision,
        targetBaseSha: merge.currentBaseSha,
        subjectCommit: merge.resultHead,
        subjectTree: merge.resultTree,
        developerExecutionId: developer.id,
        deliveryArtifactId: developer.deliveryArtifactId,
        developerEvidenceArtifactId: developer.evidenceArtifactId,
        leadSessionRef: input.leadSessionRef,
        developerSessionRef: input.developerSessionRef,
      },
      review: {
        reviewId: review.reviewId,
        leadExecutionId: review.reviewLeadExecutionId,
        leadSessionRef: review.reviewSessionRef,
        opinionArtifactId: review.opinionArtifactId,
        evidenceArtifactId: review.reviewEvidenceArtifactId,
        opinion: "approved",
        summary: review.reviewSummary,
        findings,
        supersedesReviewId: review.reviewSupersedesReviewId,
        reviewArtifact: {
          artifactId: opinionArtifact.id,
          companyId: input.companyId,
          kind: "delivery-review",
          byteSize: opinionArtifact.byteSize,
          mimeType: opinionArtifact.mimeType,
        },
      },
    },
  });
}
