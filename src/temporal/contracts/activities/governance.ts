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
  /** Historical compatibility only; new callers use the staging reference. */
  noteSha256?: string;
  idempotencyKey?: string;
}

export interface PlanBlockerResponseActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  blockerArtifactId: string;
  blockerArtifactSha256?: string | undefined;
  expectedWorkflowRevision: number;
  answerStagingRef: string;
  answerSha256?: string;
  idempotencyKey: string;
}

export interface AuthorizeFinalPlanActivityInput {
  taskId: string;
  companyId: string;
  projectId: string;
  workflowId: string;
  planRevision: number;
  planArtifactId: string;
  authorizationKind: "routine_auto" | "human_approval";
  approvalDecisionId?: string | null;
}

export interface AuthorizeFinalPlanActivityResult {
  authorizationId: string;
  planRevision: number;
  planArtifactId: string;
  planArtifactSha256?: string;
  authorizationKind: "routine_auto" | "human_approval";
  approvalDecisionId: string | null;
  authorizedAt: string;
}

export interface DecisionBlockerResolutionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  blockerOutputArtifactId: string;
  blockerOutputSha256?: string;
  answerArtifactId: string;
  answerSha256?: string;
}

export interface DecisionBlockerResolutionActivityResult {
  resolutionId: string;
}

export interface GovernanceActivities {
  recordDecisionBlockerResolution(input: DecisionBlockerResolutionActivityInput): Promise<DecisionBlockerResolutionActivityResult>;
  recordPlanDecision(input: PlanDecisionActivityInput): Promise<{ decisionId: string; duplicate?: boolean; noteArtifactId?: string; noteArtifactSha256?: string }>;
  authorizeFinalPlan(input: AuthorizeFinalPlanActivityInput): Promise<AuthorizeFinalPlanActivityResult>;
  recordPlanBlockerResponse(input: PlanBlockerResponseActivityInput): Promise<{ responseId: string; duplicate?: boolean; answerArtifactId?: string; answerArtifactSha256?: string }>;
}
