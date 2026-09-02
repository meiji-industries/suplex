import { randomBytes } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import { PlanSubjectSchema, type PlanSubject } from "./plan-governance.js";

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
  taskId: string;
  companyId: string;
  workflowId: string;
  leadExecutionId: string;
  kind: "plan" | "decision_blocker";
  evidenceArtifactId: string;
  summary: string;
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
  resultOutputId?: string;
  resultBlockerArtifactId?: string;
}

export interface RecordDecisionInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  decision: "approve" | "request_revision" | "reject";
  planRevision: number;
  artifactId: string;
  noteArtifactId: string;
}

export class PlanGovernanceRepository {
  constructor(private readonly database: ForgeDatabase) {}

  findBlockerResponseByIdempotency(workflowId: string, idempotencyKey: string): { responseId: string; answerArtifactId: string } | undefined {
    return this.database.authQuery((db) => db.prepare("SELECT id AS responseId, answer_artifact_id AS answerArtifactId FROM forge_plan_blocker_responses WHERE workflow_id = ? AND idempotency_key = ?").get(workflowId, idempotencyKey)) as { responseId: string; answerArtifactId: string } | undefined;
  }

  appendPlanVersion(input: AppendPlanVersionInput): PlanSubject {
    const subject = PlanSubjectSchema.parse(input.subject);
    artifact(this.database, input.companyId, subject.artifactId);
    artifact(this.database, input.companyId, input.evidenceArtifactId);
    this.database.authTransaction((db) => {
      const task = db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId);
      if (!task) throw new PlanGovernanceConflict("The plan subject is outside the current company and issue scope");
      const updated = db.prepare(`UPDATE forge_agent_executions
        SET output_kind = ?, output_artifact_id = ?, output_revision = ?, output_summary = ?,
            evidence_artifact_id = COALESCE(evidence_artifact_id, ?), session_ref = COALESCE(session_ref, ?)
        WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).run(input.kind, subject.artifactId, subject.planRevision, input.summary, input.evidenceArtifactId, subject.leadSessionRef, input.leadExecutionId, input.taskId, input.companyId, input.workflowId);
      if (updated.changes !== 1) throw new PlanGovernanceConflict("The Lead execution is unavailable");
    });
    return subject;
  }

  appendLeadReviewResponse(input: AppendLeadReviewResponseInput): { id: string; responseArtifactId: string } {
    artifact(this.database, input.companyId, input.responseArtifactId);
    this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_plan_review_responses (id, review_id, task_id, company_id, workflow_id, original_plan_revision, lead_execution_id, lead_session_ref, response_artifact_id, result_output_id, result_blocker_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id("response"), input.reviewId, input.taskId, input.companyId, input.workflowId, input.originalPlanRevision, input.leadExecutionId, input.leadSessionRef, input.responseArtifactId, input.resultOutputId ?? null, input.resultBlockerArtifactId ?? null, new Date().toISOString()));
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, response_artifact_id AS responseArtifactId FROM forge_plan_review_responses WHERE review_id = ?").get(input.reviewId) as { id: string; responseArtifactId: string } | undefined);
    if (!existing) throw new PlanGovernanceConflict("Lead review response was not recorded");
    return existing;
  }

  recordDecision(input: RecordDecisionInput): { decisionId: string; noteArtifactId: string } {
    const decisionId = id("decision");
    this.database.authTransaction((db) => {
      const task = db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId);
      if (!task) throw new PlanGovernanceConflict();
      db.prepare(`INSERT INTO forge_plan_decisions (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at, plan_artifact_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(decisionId, input.taskId, input.companyId, input.workflowId, input.planRevision, input.decision, input.actorUserId, input.noteArtifactId, new Date().toISOString(), input.artifactId);
    });
    return { decisionId, noteArtifactId: input.noteArtifactId };
  }

  recordBlockerResponseIdempotently(input: { taskId: string; companyId: string; workflowId: string; blockerArtifactId: string; blockerArtifactSha256?: string | null; answerArtifactId: string; answerArtifactSha256?: string | null; actorUserId: string; expectedWorkflowRevision: number; idempotencyKey: string }): { responseId: string; duplicate: boolean; answerArtifactId: string } {
    artifact(this.database, input.companyId, input.answerArtifactId);
    let responseId = id("blocker_response");
    let answerArtifactId = input.answerArtifactId;
    let duplicate = false;
    this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT id, answer_artifact_id AS answerArtifactId FROM forge_plan_blocker_responses WHERE workflow_id = ? AND idempotency_key = ?").get(input.workflowId, input.idempotencyKey) as { id: string; answerArtifactId: string } | undefined;
      if (existing) { responseId = existing.id; answerArtifactId = existing.answerArtifactId; duplicate = true; return; }
      db.prepare("INSERT INTO forge_plan_blocker_responses (id, task_id, company_id, workflow_id, blocker_artifact_id, blocker_artifact_sha256, answer_artifact_id, answer_artifact_sha256, actor_user_id, expected_workflow_revision, idempotency_key, subject_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(responseId, input.taskId, input.companyId, input.workflowId, input.blockerArtifactId, input.blockerArtifactSha256, input.answerArtifactId, input.answerArtifactSha256, input.actorUserId, input.expectedWorkflowRevision, input.idempotencyKey, input.blockerArtifactSha256, new Date().toISOString());
    });
    return { responseId, duplicate, answerArtifactId };
  }
}
