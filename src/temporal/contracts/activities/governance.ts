import type { PlanDecisionSubject } from "../../../plan-governance.js";

export interface PlanDecisionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  planRevision: number;
  actorUserId: string;
  decision: "approve" | "request_revision" | "reject";
  note?: string;
  revisionRequestId?: string;
  /** Plan identity for the recorded row; the workflow supplies it from its own state, never the caller. */
  subject?: PlanDecisionSubject;
  noteStagingRef?: string;
  idempotencyKey?: string;
}

export interface PlanBlockerResponseActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  blockerArtifactId: string;
  /** Optional recorded metadata; it never authorizes or blocks the response. */
  blockerArtifactSha256?: string | null;
  expectedWorkflowRevision: number;
  answerStagingRef: string;
  idempotencyKey: string;
}


export interface DecisionBlockerResolutionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  blockerOutputArtifactId: string;
  answerArtifactId: string;
}

export interface DecisionBlockerResolutionActivityResult {
  resolutionId: string;
}

export interface GovernanceActivities {
  recordDecisionBlockerResolution(input: DecisionBlockerResolutionActivityInput): Promise<DecisionBlockerResolutionActivityResult>;
  recordPlanDecision(input: PlanDecisionActivityInput): Promise<{ decisionId: string; duplicate?: boolean; noteArtifactId?: string }>;
  recordPlanBlockerResponse(input: PlanBlockerResponseActivityInput): Promise<{ responseId: string; duplicate?: boolean; answerArtifactId?: string }>;
}
