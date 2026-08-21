import { randomBytes } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import { PlanSubjectSchema, SupplementalReviewSubjectSchema, type PlanDecisionSubject, type PlanSubject, type SupplementalReviewSubject } from "./plan-governance.js";

export class PlanGovernanceConflict extends Error {
  readonly code = "plan-governance-conflict" as const;

  constructor(message = "The plan governance subject is stale or conflicting") {
    super(message);
    this.name = "PlanGovernanceConflict";
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function artifact(database: ForgeDatabase, companyId: string, artifactId: string): void {
  const row = database.authQuery((db) => db.prepare("SELECT id FROM forge_artifacts WHERE id = ? AND company_id = ?").get(artifactId, companyId));
  if (!row) throw new PlanGovernanceConflict("The referenced artifact is unavailable");
}

export interface AppendPlanVersionInput {
  subject: PlanSubject;
  kind: "plan" | "decision_blocker";
  evidenceArtifactId: string;
  evidenceArtifactSha256: string;
  materialityEvidenceArtifactId?: string;
  materialityEvidenceSha256?: string;
  summary: string;
  supersedesOutputId?: string;
}

export interface AppendSupplementalReviewInput {
  subject: SupplementalReviewSubject;
  reviewId: string;
  executionId: string;
  opinionArtifactId: string;
  opinionArtifactSha256: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256: string;
  summary: string;
  reviewerSessionRef: string;
}

export interface AppendLeadReviewResponseInput {
  reviewId: string;
  taskId: string;
  companyId: string;
  workflowId: string;
  originalPlanRevision: number;
  leadExecutionId: string;
  leadSessionRef: string;
  responseArtifactId: string;
  responseArtifactSha256: string;
  resultOutputId?: string;
  resultBlockerArtifactId?: string;
}

export interface RecordDecisionInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  decision: "approve" | "request_revision" | "reject";
  subject?: PlanDecisionSubject;
  planRevision: number;
  noteArtifactId: string;
  idempotencyKey?: string;
}

export class PlanGovernanceRepository {
  constructor(private readonly database: ForgeDatabase) {}

  findDecisionByIdempotency(workflowId: string, idempotencyKey: string): { decisionId: string; decision: string; noteArtifactId: string } | undefined {
    return this.database.authQuery((db) => db.prepare("SELECT id AS decisionId, decision, note_artifact_id AS noteArtifactId FROM forge_plan_decisions WHERE workflow_id = ? AND idempotency_key = ?").get(workflowId, idempotencyKey)) as { decisionId: string; decision: string; noteArtifactId: string } | undefined;
  }

  findBlockerResponseByIdempotency(workflowId: string, idempotencyKey: string): { responseId: string; answerArtifactId: string } | undefined {
    return this.database.authQuery((db) => db.prepare("SELECT id AS responseId, answer_artifact_id AS answerArtifactId FROM forge_plan_blocker_responses WHERE workflow_id = ? AND idempotency_key = ?").get(workflowId, idempotencyKey)) as { responseId: string; answerArtifactId: string } | undefined;
  }

  appendPlanVersion(input: AppendPlanVersionInput): PlanSubject {
    const subject = PlanSubjectSchema.parse(input.subject);
    artifact(this.database, subject.companyId, subject.artifactId);
    artifact(this.database, subject.companyId, input.evidenceArtifactId);
    this.database.authTransaction((db) => {
      const task = db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(subject.issueId, subject.companyId, subject.workflowId);
      if (!task) throw new PlanGovernanceConflict("The plan subject is outside the current company and issue scope");
      db.prepare(`INSERT OR IGNORE INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at, original_plan_revision, final_version, artifact_sha256, supersedes_output_id, evidence_manifest_artifact_id, evidence_manifest_sha256, materiality_evidence_artifact_id, materiality_evidence_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(subject.outputId, subject.issueId, subject.companyId, subject.workflowId, subject.leadExecutionId, subject.outputRevision, input.kind, subject.artifactId, input.evidenceArtifactId, subject.leadSessionRef, input.summary, new Date().toISOString(), subject.originalPlanRevision, subject.finalVersion, subject.artifactSha256, input.supersedesOutputId ?? null, subject.evidenceManifestArtifactId, subject.evidenceManifestSha256, input.materialityEvidenceArtifactId ?? null, input.materialityEvidenceSha256 ?? null);
    });
    return subject;
  }

  appendSupplementalReview(input: AppendSupplementalReviewInput): SupplementalReviewSubject {
    const subject = SupplementalReviewSubjectSchema.parse(input.subject);
    artifact(this.database, subject.originalPlan.companyId, input.opinionArtifactId);
    artifact(this.database, subject.originalPlan.companyId, input.evidenceArtifactId);
    this.database.authTransaction((db) => db.prepare(`INSERT OR IGNORE INTO forge_plan_reviews (id, task_id, company_id, workflow_id, plan_revision, profile_id, execution_id, session_ref, opinion_artifact_id, evidence_artifact_id, summary, created_at, original_plan_revision, plan_output_id, plan_artifact_id, plan_artifact_sha256, evidence_manifest_artifact_id, evidence_manifest_sha256, opinion_artifact_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.reviewId, subject.originalPlan.issueId, subject.originalPlan.companyId, subject.originalPlan.workflowId, subject.originalPlan.outputRevision, subject.reviewerProfileId, input.executionId, input.reviewerSessionRef, input.opinionArtifactId, input.evidenceArtifactId, input.summary, new Date().toISOString(), subject.originalPlan.originalPlanRevision, subject.originalPlan.outputId, subject.originalPlan.artifactId, subject.originalPlan.artifactSha256, subject.evidenceManifestArtifactId, subject.evidenceManifestSha256, input.opinionArtifactSha256));
    return subject;
  }

  appendLeadReviewResponse(input: AppendLeadReviewResponseInput): { id: string; responseArtifactId: string; responseArtifactSha256: string } {
    artifact(this.database, input.companyId, input.responseArtifactId);
    this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_plan_review_responses (id, review_id, task_id, company_id, workflow_id, original_plan_revision, lead_execution_id, lead_session_ref, response_artifact_id, response_artifact_sha256, result_output_id, result_blocker_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id("response"), input.reviewId, input.taskId, input.companyId, input.workflowId, input.originalPlanRevision, input.leadExecutionId, input.leadSessionRef, input.responseArtifactId, input.responseArtifactSha256, input.resultOutputId ?? null, input.resultBlockerArtifactId ?? null, new Date().toISOString()));
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, response_artifact_id AS responseArtifactId, response_artifact_sha256 AS responseArtifactSha256 FROM forge_plan_review_responses WHERE review_id = ?").get(input.reviewId) as { id: string; responseArtifactId: string; responseArtifactSha256: string } | undefined);
    if (!existing) throw new PlanGovernanceConflict("Lead review response was not recorded");
    return existing;
  }

  /** Idempotency is (workflow_id, idempotency_key): the same key always returns the row it first wrote. */
  recordDecisionIdempotently(input: RecordDecisionInput): { decisionId: string; duplicate: boolean; noteArtifactId: string } {
    const plan = input.subject?.plan;
    let decisionId = id("decision");
    let duplicate = false;
    let noteArtifactId = input.noteArtifactId;
    this.database.authTransaction((db) => {
      const existing = input.idempotencyKey ? db.prepare("SELECT id, note_artifact_id AS noteArtifactId FROM forge_plan_decisions WHERE workflow_id = ? AND idempotency_key = ?").get(input.workflowId, input.idempotencyKey) as { id: string; noteArtifactId: string } | undefined : undefined;
      if (existing) {
        decisionId = existing.id;
        noteArtifactId = existing.noteArtifactId;
        duplicate = true;
        return;
      }
      const task = db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId);
      if (!task) throw new PlanGovernanceConflict();
      db.prepare(`INSERT INTO forge_plan_decisions (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at, original_plan_revision, final_version, plan_output_id, plan_artifact_id, plan_artifact_sha256, materiality_evidence_artifact_id, materiality_evidence_sha256, expected_workflow_revision, idempotency_key, note_artifact_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(decisionId, input.taskId, input.companyId, input.workflowId, plan?.outputRevision ?? input.planRevision, input.decision, input.actorUserId, input.noteArtifactId, new Date().toISOString(), plan?.originalPlanRevision ?? null, plan?.finalVersion ?? null, plan?.outputId ?? null, plan?.artifactId ?? null, null, input.subject?.materiality.artifactId ?? null, null, input.subject?.expectedWorkflowRevision ?? null, input.idempotencyKey ?? null, null);
    });
    return { decisionId, duplicate, noteArtifactId };
  }

  recordBlockerResponseIdempotently(input: { taskId: string; companyId: string; workflowId: string; blockerArtifactId: string; answerArtifactId: string; actorUserId: string; expectedWorkflowRevision: number; idempotencyKey: string }): { responseId: string; duplicate: boolean; answerArtifactId: string } {
    artifact(this.database, input.companyId, input.answerArtifactId);
    let responseId = id("blocker_response");
    let answerArtifactId = input.answerArtifactId;
    let duplicate = false;
    this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT id, answer_artifact_id AS answerArtifactId FROM forge_plan_blocker_responses WHERE workflow_id = ? AND idempotency_key = ?").get(input.workflowId, input.idempotencyKey) as { id: string; answerArtifactId: string } | undefined;
      if (existing) { responseId = existing.id; answerArtifactId = existing.answerArtifactId; duplicate = true; return; }
      // subject_hash is a legacy NOT NULL column; use the stable artifact identity.
      db.prepare("INSERT INTO forge_plan_blocker_responses (id, task_id, company_id, workflow_id, blocker_artifact_id, blocker_artifact_sha256, answer_artifact_id, answer_artifact_sha256, actor_user_id, expected_workflow_revision, idempotency_key, subject_hash, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)").run(responseId, input.taskId, input.companyId, input.workflowId, input.blockerArtifactId, input.answerArtifactId, input.actorUserId, input.expectedWorkflowRevision, input.idempotencyKey, input.blockerArtifactId, new Date().toISOString());
    });
    return { responseId, duplicate, answerArtifactId };
  }
}
