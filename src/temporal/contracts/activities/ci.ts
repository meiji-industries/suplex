export interface ReconcileCiActivityInput {
  taskId: string;
  companyId: string;
  releaseId: string;
  expectedHeadSha: string;
  attemptNumber: number;
}

export interface ReconcileCiActivityResult {
  runId: string;
  attemptId: string;
  attemptNumber: number;
  expectedHeadSha: string;
  observedHeadSha: string | null;
  evidenceArtifactId: string | null;
  evidenceArtifactSha256?: string;
  outcome: "waiting" | "passed" | "failed" | "missing_required" | "cancelled" | "timed_out" | "non_success" | "stale_head" | "rate_limited" | "provider_unavailable" | "invalid_provider_response";
  reason: string;
  owner: "system" | "lead" | "human" | null;
  repairable: boolean;
  summary: string;
  retryAt: string | null;
  nextPollAt: string | null;
  policyHash: string;
  propagationDeadline: string | null;
  overallDeadline: string | null;
}

export interface CiRepairPlanActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  leadSessionRef: string;
  ciRunId: string;
  ciAttemptId: string;
  failedHeadSha: string;
  evidenceArtifactId: string;
  requiredChecks: string[];
  localVerification: string[];
  capacityRequestId?: string;
}

export interface CiRepairPlanActivityResult {
  planId: string;
  planArtifactId: string;
  evidenceArtifactId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  summary: string;
}

export interface CiRepairActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  releaseId?: string;
  projectId: string;
  projectRevisionId: string;
  ciRunId: string;
  ciAttemptId: string;
  repairPlanId: string;
  repairPlanArtifactId: string;
  repairPlanEvidenceArtifactId: string;
  failedHeadSha: string;
  priorDeveloperExecutionId: string;
  priorDeveloperSessionRef: string;
  worktreePath: string;
  branchName: string;
  priorCommit: string;
  priorTree: string;
  capacityRequestId?: string;
}

export interface CiRepairActivityResult {
  repairId: string;
  developerExecutionId: string;
  developerSessionRef: string;
  worktreePath: string;
  branchName: string;
  priorCommit: string;
  priorTree: string;
  resultCommit: string | null;
  resultTree: string | null;
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  attentionEvidenceArtifactId?: string;
  attentionEvidenceSha256?: string;
  summary: string;
  outcome: "completed" | "blocked";
}

export type WorkflowCiRepairActivityInput = Omit<CiRepairActivityInput, "worktreePath"> & { worktreePath?: string };
export type WorkflowCiRepairActivityResult = Omit<CiRepairActivityResult, "worktreePath">;

export interface CiActivities {
  reconcileCi(input: ReconcileCiActivityInput): Promise<ReconcileCiActivityResult>;
  planCiRepair(input: CiRepairPlanActivityInput): Promise<CiRepairPlanActivityResult>;
  runCiRepair(input: WorkflowCiRepairActivityInput): Promise<WorkflowCiRepairActivityResult>;
}
