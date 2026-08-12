import { createHash, randomBytes } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import { canonicalPlanDecisionSubject, PlanBlockerSubjectSchema, PlanDecisionSubjectSchema, PlanSubjectSchema, samePlanSubject, SupplementalReviewSubjectSchema, type PlanBlockerSubject, type PlanDecisionSubject, type PlanSubject, type SupplementalReviewSubject } from "./plan-governance.js";

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

function subjectHash(subject: PlanDecisionSubject): string {
  return createHash("sha256").update(canonicalPlanDecisionSubject(subject)).digest("hex");
}

function blockerSubjectHash(subject: PlanBlockerSubject): string {
  return createHash("sha256").update([
    subject.companyId, subject.issueId, subject.workflowId, subject.artifactId, subject.artifactSha256,
    subject.leadSessionRef, subject.leadExecutionId, subject.evidenceManifestArtifactId, subject.evidenceManifestSha256,
    subject.category, subject.resumePhase,
  ].join("\n")).digest("hex");
}

function artifact(database: ForgeDatabase, companyId: string, artifactId: string, sha256: string): { id: string; sha256: string } {
  const row = database.authQuery((db) => db.prepare("SELECT id, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(artifactId, companyId) as { id: string; sha256: string } | undefined);
  if (!row || row.sha256 !== sha256) throw new PlanGovernanceConflict("The referenced artifact is unavailable");
  return row;
}

function artifactOfKind(database: ForgeDatabase, companyId: string, artifactId: string, sha256: string, kind: string): { id: string; sha256: string } {
  const row = database.authQuery((db) => db.prepare("SELECT id, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND sha256 = ? AND kind = ?").get(artifactId, companyId, sha256, kind) as { id: string; sha256: string } | undefined);
  if (!row) throw new PlanGovernanceConflict("The referenced artifact is unavailable");
  return row;
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
  decision: "approve" | "request_revision";
  subject: PlanDecisionSubject;
  noteArtifactId: string;
  noteArtifactSha256: string;
  idempotencyKey: string;
}

export interface ExistingPlanDecision {
  decisionId: string;
  decision: "approve" | "request_revision" | "reject";
  subjectHash: string;
  noteArtifactId: string;
  noteArtifactSha256: string;
}

export interface ExistingBlockerResponse {
  responseId: string;
  subjectHash: string;
  answerArtifactId: string;
  answerArtifactSha256: string;
}

export class PlanGovernanceRepository {
  constructor(private readonly database: ForgeDatabase) {}

  findDecisionByIdempotency(workflowId: string, idempotencyKey: string): ExistingPlanDecision | undefined {
    return this.database.authQuery((db) => db.prepare("SELECT id AS decisionId, decision, subject_hash AS subjectHash, note_artifact_id AS noteArtifactId, note_artifact_sha256 AS noteArtifactSha256 FROM forge_plan_decisions WHERE workflow_id = ? AND idempotency_key = ?").get(workflowId, idempotencyKey) as ExistingPlanDecision | undefined);
  }

  findBlockerResponseByIdempotency(workflowId: string, idempotencyKey: string): ExistingBlockerResponse | undefined {
    return this.database.authQuery((db) => db.prepare("SELECT id AS responseId, subject_hash AS subjectHash, answer_artifact_id AS answerArtifactId, answer_artifact_sha256 AS answerArtifactSha256 FROM forge_plan_blocker_responses WHERE workflow_id = ? AND idempotency_key = ?").get(workflowId, idempotencyKey) as ExistingBlockerResponse | undefined);
  }

  appendPlanVersion(input: AppendPlanVersionInput): PlanSubject {
    const subject = PlanSubjectSchema.parse(input.subject);
    if (subject.finalVersion === 2 && !input.supersedesOutputId) throw new PlanGovernanceConflict("A consolidated plan must supersede the original plan");
    if (subject.finalVersion === 1 && input.supersedesOutputId) throw new PlanGovernanceConflict("The original plan cannot supersede another plan");
    artifact(this.database, subject.companyId, subject.artifactId, subject.artifactSha256);
    artifact(this.database, subject.companyId, input.evidenceArtifactId, input.evidenceArtifactSha256);
    if (input.materialityEvidenceArtifactId && input.materialityEvidenceSha256) artifact(this.database, subject.companyId, input.materialityEvidenceArtifactId, input.materialityEvidenceSha256);
    this.database.authTransaction((db) => {
      const task = db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(subject.issueId, subject.companyId, subject.workflowId);
      if (!task) throw new PlanGovernanceConflict("The plan subject is outside the current company and issue scope");
      const duplicate = db.prepare(`SELECT id, original_plan_revision AS originalPlanRevision, revision AS outputRevision, final_version AS finalVersion, output_artifact_id AS artifactId, artifact_sha256 AS artifactSha256, session_ref AS leadSessionRef, execution_id AS leadExecutionId, evidence_manifest_artifact_id AS evidenceManifestArtifactId, evidence_manifest_sha256 AS evidenceManifestSha256, kind, evidence_artifact_id AS evidenceArtifactId
        FROM forge_issue_outputs WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(subject.outputId, subject.issueId, subject.companyId, subject.workflowId) as { id: string; originalPlanRevision: number; outputRevision: number; finalVersion: 1 | 2; artifactId: string; artifactSha256: string; leadSessionRef: string; leadExecutionId: string; evidenceManifestArtifactId: string; evidenceManifestSha256: string; kind: "plan" | "decision_blocker"; evidenceArtifactId: string } | undefined;
      if (duplicate) {
        const duplicateSubject = PlanSubjectSchema.safeParse({ companyId: subject.companyId, issueId: subject.issueId, workflowId: subject.workflowId, outputId: duplicate.id, artifactId: duplicate.artifactId, artifactSha256: duplicate.artifactSha256, originalPlanRevision: duplicate.originalPlanRevision, outputRevision: duplicate.outputRevision, finalVersion: duplicate.finalVersion, leadSessionRef: duplicate.leadSessionRef, leadExecutionId: duplicate.leadExecutionId, evidenceManifestArtifactId: duplicate.evidenceManifestArtifactId, evidenceManifestSha256: duplicate.evidenceManifestSha256 });
        if (!duplicateSubject.success || !samePlanSubject(duplicateSubject.data, subject) || duplicate.kind !== input.kind || duplicate.evidenceArtifactId !== input.evidenceArtifactId) throw new PlanGovernanceConflict("The output identity is immutable and conflicts with the existing row");
        return;
      }
      const existingVersion = db.prepare("SELECT id FROM forge_issue_outputs WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND original_plan_revision = ? AND final_version = ? AND legacy_unverified = 0").get(subject.issueId, subject.companyId, subject.workflowId, subject.originalPlanRevision, subject.finalVersion);
      if (existingVersion) throw new PlanGovernanceConflict("This exact plan version already exists");
      if (subject.finalVersion === 2) {
        const original = db.prepare("SELECT id FROM forge_issue_outputs WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND original_plan_revision = ? AND final_version = 1 AND legacy_unverified = 0").get(input.supersedesOutputId, subject.issueId, subject.companyId, subject.workflowId, subject.originalPlanRevision);
        if (!original) throw new PlanGovernanceConflict("The consolidated plan must supersede the exact original plan");
      }
      db.prepare(`INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at, original_plan_revision, final_version, artifact_sha256, supersedes_output_id, evidence_manifest_artifact_id, evidence_manifest_sha256, materiality_evidence_artifact_id, materiality_evidence_sha256, legacy_unverified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(subject.outputId, subject.issueId, subject.companyId, subject.workflowId, subject.leadExecutionId, subject.outputRevision, input.kind, subject.artifactId, input.evidenceArtifactId, subject.leadSessionRef, input.summary, new Date().toISOString(), subject.originalPlanRevision, subject.finalVersion, subject.artifactSha256, input.supersedesOutputId ?? null, subject.evidenceManifestArtifactId, subject.evidenceManifestSha256, input.materialityEvidenceArtifactId ?? null, input.materialityEvidenceSha256 ?? null);
    });
    return subject;
  }

  appendSupplementalReview(input: AppendSupplementalReviewInput): SupplementalReviewSubject {
    const subject = SupplementalReviewSubjectSchema.parse(input.subject);
    artifact(this.database, subject.originalPlan.companyId, input.opinionArtifactId, input.opinionArtifactSha256);
    artifact(this.database, subject.originalPlan.companyId, input.evidenceArtifactId, input.evidenceArtifactSha256);
    this.database.authTransaction((db) => {
      const planQuery = db.prepare(`SELECT io.session_ref AS leadSessionRef FROM forge_tasks t JOIN forge_issue_outputs io ON io.task_id = t.id AND io.company_id = t.company_id AND io.workflow_id = t.workflow_id
        WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND io.id = ? AND io.kind = 'plan' AND io.original_plan_revision = ? AND io.final_version = 1 AND io.output_artifact_id = ? AND io.artifact_sha256 = ? AND io.evidence_manifest_artifact_id = ? AND io.evidence_manifest_sha256 = ? AND io.legacy_unverified = 0`);
      const plan = planQuery.get(subject.originalPlan.issueId, subject.originalPlan.companyId, subject.originalPlan.workflowId, subject.originalPlan.outputId, subject.originalPlan.originalPlanRevision, subject.originalPlan.artifactId, subject.originalPlan.artifactSha256, subject.evidenceManifestArtifactId, subject.evidenceManifestSha256) as { leadSessionRef: string } | undefined;
      if (!plan || plan.leadSessionRef === input.reviewerSessionRef) throw new PlanGovernanceConflict("The supplemental review must reference the exact original plan and a fresh reviewer session");
      const existing = db.prepare("SELECT id FROM forge_plan_reviews WHERE workflow_id = ? AND original_plan_revision = ?").get(subject.originalPlan.workflowId, subject.originalPlan.originalPlanRevision);
      if (existing) throw new PlanGovernanceConflict("A supplemental review already exists for this original plan revision");
      db.prepare(`INSERT INTO forge_plan_reviews (id, task_id, company_id, workflow_id, plan_revision, profile_id, execution_id, session_ref, opinion_artifact_id, evidence_artifact_id, summary, created_at, original_plan_revision, plan_output_id, plan_artifact_id, plan_artifact_sha256, evidence_manifest_artifact_id, evidence_manifest_sha256, opinion_artifact_sha256, legacy_unverified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(input.reviewId, subject.originalPlan.issueId, subject.originalPlan.companyId, subject.originalPlan.workflowId, subject.originalPlan.outputRevision, subject.reviewerProfileId, input.executionId, input.reviewerSessionRef, input.opinionArtifactId, input.evidenceArtifactId, input.summary, new Date().toISOString(), subject.originalPlan.originalPlanRevision, subject.originalPlan.outputId, subject.originalPlan.artifactId, subject.originalPlan.artifactSha256, subject.evidenceManifestArtifactId, subject.evidenceManifestSha256, input.opinionArtifactSha256);
    });
    return subject;
  }

  appendLeadReviewResponse(input: AppendLeadReviewResponseInput): { id: string; responseArtifactId: string; responseArtifactSha256: string } {
    artifact(this.database, input.companyId, input.responseArtifactId, input.responseArtifactSha256);
    const responseId = id("response");
    this.database.authTransaction((db) => {
      const reviewQuery = db.prepare(`SELECT r.id, r.task_id AS taskId, r.company_id AS companyId, r.workflow_id AS workflowId, r.original_plan_revision AS originalPlanRevision, io.execution_id AS planExecutionId, io.session_ref AS planSessionRef
        FROM forge_plan_reviews r JOIN forge_issue_outputs io ON io.id = r.plan_output_id AND io.task_id = r.task_id AND io.company_id = r.company_id AND io.workflow_id = r.workflow_id
        WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.original_plan_revision = ? AND r.legacy_unverified = 0`);
      const review = reviewQuery.get(input.reviewId, input.taskId, input.companyId, input.workflowId, input.originalPlanRevision) as { id: string; planSessionRef: string } | undefined;
      if (!review || review.planSessionRef !== input.leadSessionRef) throw new PlanGovernanceConflict("The Lead response is outside the exact supplemental review lineage");
      const existing = db.prepare("SELECT id, response_artifact_id AS responseArtifactId, response_artifact_sha256 AS responseArtifactSha256 FROM forge_plan_review_responses WHERE review_id = ?").get(input.reviewId) as { id: string; responseArtifactId: string; responseArtifactSha256: string } | undefined;
      if (existing) { if (existing.responseArtifactSha256 !== input.responseArtifactSha256) throw new PlanGovernanceConflict("The Lead review response is immutable"); return; }
      db.prepare("INSERT INTO forge_plan_review_responses (id, review_id, task_id, company_id, workflow_id, original_plan_revision, lead_execution_id, lead_session_ref, response_artifact_id, response_artifact_sha256, result_output_id, result_blocker_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(responseId, input.reviewId, input.taskId, input.companyId, input.workflowId, input.originalPlanRevision, input.leadExecutionId, input.leadSessionRef, input.responseArtifactId, input.responseArtifactSha256, input.resultOutputId ?? null, input.resultBlockerArtifactId ?? null, new Date().toISOString());
    });
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, response_artifact_id AS responseArtifactId, response_artifact_sha256 AS responseArtifactSha256 FROM forge_plan_review_responses WHERE review_id = ?").get(input.reviewId) as { id: string; responseArtifactId: string; responseArtifactSha256: string } | undefined);
    if (!existing) throw new PlanGovernanceConflict("Lead review response was not recorded");
    return existing;
  }

  recordDecisionIdempotently(input: RecordDecisionInput): { decisionId: string; duplicate: boolean; subjectHash: string; noteArtifactId: string; noteArtifactSha256: string } {
    const subject = PlanDecisionSubjectSchema.parse(input.subject);
    if (subject.plan.companyId !== input.companyId || subject.plan.issueId !== input.taskId || subject.plan.workflowId !== input.workflowId) throw new PlanGovernanceConflict();
    const exactPlan = this.loadExactPlanSubject({ outputId: subject.plan.outputId, companyId: input.companyId, issueId: input.taskId, workflowId: input.workflowId, artifactId: subject.plan.artifactId, artifactSha256: subject.plan.artifactSha256 });
    if (!exactPlan || JSON.stringify(exactPlan) !== JSON.stringify(subject.plan)) throw new PlanGovernanceConflict("The decision does not reference the immutable final plan");
    artifactOfKind(this.database, input.companyId, subject.materiality.artifactId, subject.materiality.artifactSha256, "materiality-evidence");
    artifact(this.database, input.companyId, input.noteArtifactId, input.noteArtifactSha256);
    const hash = hashPlanDecisionSubject(subject);
    let decisionId = id("decision");
    let duplicate = false;
    this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT id, decision, subject_hash AS subjectHash, note_artifact_id AS noteArtifactId, note_artifact_sha256 AS noteArtifactSha256 FROM forge_plan_decisions WHERE workflow_id = ? AND idempotency_key = ?").get(input.workflowId, input.idempotencyKey) as { id: string; decision: string; subjectHash: string | null; noteArtifactId: string; noteArtifactSha256: string | null } | undefined;
      if (existing) {
        if (existing.decision !== input.decision || existing.subjectHash !== hash || existing.noteArtifactSha256 !== input.noteArtifactSha256) throw new PlanGovernanceConflict("The idempotency key was reused with a different decision");
        decisionId = existing.id; duplicate = true; return;
      }
      const task = db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId);
      if (!task) throw new PlanGovernanceConflict();
      db.prepare(`INSERT INTO forge_plan_decisions (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at, original_plan_revision, final_version, plan_output_id, plan_artifact_id, plan_artifact_sha256, materiality_evidence_artifact_id, materiality_evidence_sha256, expected_workflow_revision, idempotency_key, subject_hash, note_artifact_sha256, legacy_unverified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(decisionId, input.taskId, input.companyId, input.workflowId, subject.plan.outputRevision, input.decision, input.actorUserId, input.noteArtifactId, new Date().toISOString(), subject.plan.originalPlanRevision, subject.plan.finalVersion, subject.plan.outputId, subject.plan.artifactId, subject.plan.artifactSha256, subject.materiality.artifactId, subject.materiality.artifactSha256, subject.expectedWorkflowRevision, input.idempotencyKey, hash, input.noteArtifactSha256);
    });
    const stored = this.database.authQuery((db) => db.prepare("SELECT note_artifact_id AS noteArtifactId, note_artifact_sha256 AS noteArtifactSha256 FROM forge_plan_decisions WHERE id = ? AND workflow_id = ?").get(decisionId, input.workflowId) as { noteArtifactId: string; noteArtifactSha256: string } | undefined);
    if (!stored) throw new PlanGovernanceConflict("Plan decision was not recorded");
    return { decisionId, duplicate, subjectHash: hash, noteArtifactId: stored.noteArtifactId, noteArtifactSha256: stored.noteArtifactSha256 };
  }

  recordBlockerResponseIdempotently(input: { taskId: string; companyId: string; workflowId: string; blockerArtifactId: string; blockerArtifactSha256: string; answerArtifactId: string; answerArtifactSha256: string; actorUserId: string; expectedWorkflowRevision: number; idempotencyKey: string; subjectHash: string }): { responseId: string; duplicate: boolean; subjectHash: string; answerArtifactId: string; answerArtifactSha256: string } {
    const blocker = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_tasks t JOIN forge_issue_outputs io ON io.task_id = t.id AND io.company_id = t.company_id AND io.workflow_id = t.workflow_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND io.kind = 'decision_blocker' AND io.output_artifact_id = ? AND io.artifact_sha256 = ? AND io.legacy_unverified = 0").get(input.taskId, input.companyId, input.workflowId, input.blockerArtifactId, input.blockerArtifactSha256));
    if (!blocker) throw new PlanGovernanceConflict("The blocker response does not reference the exact current blocker");
    artifact(this.database, input.companyId, input.blockerArtifactId, input.blockerArtifactSha256);
    artifact(this.database, input.companyId, input.answerArtifactId, input.answerArtifactSha256);
    let responseId = id("blocker_response");
    let answerArtifactId = input.answerArtifactId;
    let answerArtifactSha256 = input.answerArtifactSha256;
    let duplicate = false;
    this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT id, subject_hash AS subjectHash, answer_artifact_id AS answerArtifactId, answer_artifact_sha256 AS answerArtifactSha256 FROM forge_plan_blocker_responses WHERE workflow_id = ? AND idempotency_key = ?").get(input.workflowId, input.idempotencyKey) as { id: string; subjectHash: string; answerArtifactId: string; answerArtifactSha256: string } | undefined;
      if (existing) { if (existing.subjectHash !== input.subjectHash || existing.answerArtifactSha256 !== input.answerArtifactSha256) throw new PlanGovernanceConflict("The idempotency key was reused with a different blocker answer"); responseId = existing.id; answerArtifactId = existing.answerArtifactId; answerArtifactSha256 = existing.answerArtifactSha256; duplicate = true; return; }
      db.prepare("INSERT INTO forge_plan_blocker_responses (id, task_id, company_id, workflow_id, blocker_artifact_id, blocker_artifact_sha256, answer_artifact_id, answer_artifact_sha256, actor_user_id, expected_workflow_revision, idempotency_key, subject_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(responseId, input.taskId, input.companyId, input.workflowId, input.blockerArtifactId, input.blockerArtifactSha256, input.answerArtifactId, input.answerArtifactSha256, input.actorUserId, input.expectedWorkflowRevision, input.idempotencyKey, input.subjectHash, new Date().toISOString());
    });
    return { responseId, duplicate, subjectHash: input.subjectHash, answerArtifactId, answerArtifactSha256 };
  }

  loadExactPlanSubject(input: { outputId: string; companyId: string; issueId: string; workflowId: string; artifactId: string; artifactSha256: string }): PlanSubject | undefined {
    const row = this.database.authQuery((db) => db.prepare("SELECT id AS outputId, original_plan_revision AS originalPlanRevision, revision AS outputRevision, final_version AS finalVersion, output_artifact_id AS artifactId, artifact_sha256 AS artifactSha256, session_ref AS leadSessionRef, execution_id AS leadExecutionId, evidence_manifest_artifact_id AS evidenceManifestArtifactId, evidence_manifest_sha256 AS evidenceManifestSha256 FROM forge_issue_outputs WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND output_artifact_id = ? AND artifact_sha256 = ? AND legacy_unverified = 0").get(input.outputId, input.issueId, input.companyId, input.workflowId, input.artifactId, input.artifactSha256) as { outputId: string; originalPlanRevision: number; outputRevision: number; finalVersion: number; artifactId: string; artifactSha256: string; leadSessionRef: string; leadExecutionId: string; evidenceManifestArtifactId: string; evidenceManifestSha256: string } | undefined);
    return row ? PlanSubjectSchema.parse({ companyId: input.companyId, issueId: input.issueId, workflowId: input.workflowId, ...row }) : undefined;
  }

  loadGovernanceDetail(input: { companyId: string; issueId: string; workflowId: string }): { plans: PlanSubject[]; decisions: Array<{ id: string; decision: string; subjectHash: string; noteArtifactId: string }> } {
    const plans = this.database.authQuery((db) => db.prepare("SELECT original_plan_revision AS originalPlanRevision, revision AS outputRevision, final_version AS finalVersion, output_artifact_id AS artifactId, artifact_sha256 AS artifactSha256, session_ref AS leadSessionRef, execution_id AS leadExecutionId, evidence_manifest_artifact_id AS evidenceManifestArtifactId, evidence_manifest_sha256 AS evidenceManifestSha256 FROM forge_issue_outputs WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND legacy_unverified = 0 ORDER BY original_plan_revision, finalVersion, revision").all(input.issueId, input.companyId, input.workflowId) as Array<Record<string, unknown>>).map((row) => PlanSubjectSchema.parse({ companyId: input.companyId, issueId: input.issueId, workflowId: input.workflowId, ...row }));
    const decisions = this.database.authQuery((db) => db.prepare("SELECT id, decision, subject_hash AS subjectHash, note_artifact_id AS noteArtifactId FROM forge_plan_decisions WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at, id").all(input.issueId, input.companyId, input.workflowId) as Array<{ id: string; decision: string; subjectHash: string; noteArtifactId: string }>);
    return { plans, decisions };
  }
}

export function hashPlanDecisionSubject(subject: PlanDecisionSubject): string {
  return subjectHash(subject);
}

export function hashPlanBlockerSubject(subject: PlanBlockerSubject): string {
  return blockerSubjectHash(PlanBlockerSubjectSchema.parse(subject));
}
