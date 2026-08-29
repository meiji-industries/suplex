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
  outcome: "waiting" | "passed" | "failed" | "missing_required" | "cancelled" | "timed_out" | "non_success" | "stale_head" | "rate_limited" | "provider_unavailable" | "invalid_provider_response";
  reason: string;
  owner: "system" | "integrator" | "human" | null;
  repairable: boolean;
  summary: string;
  retryAt: string | null;
  nextPollAt: string | null;
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
  roleProfiles?: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  executionRole?: "planner" | "integrator";
  capacityRequestId?: string;
}

export interface CiRepairPlanActivityResult {
  planId: string;
  planArtifactId: string;
  evidenceArtifactId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  summary: string;
  /** "rerun": the Lead judged the failure unrelated to this delivery, so re-run the provider jobs. */
  disposition?: "repair" | "rerun";
}

export interface RerunCiActivityInput {
  taskId: string;
  companyId: string;
  ciRunId: string;
  ciAttemptId: string;
}

export interface RerunCiActivityResult {
  rerunRunIds: string[];
  summary: string;
}

export interface UpdateCiFromBaseActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectRevisionId: string;
  releaseId: string;
  developerExecutionId: string;
  branchName: string;
  expectedBaseSha: string;
  expectedHeadSha: string;
  expectedHeadTree: string;
  ciRunId: string;
}

export type UpdateCiFromBaseActivityResult =
  | { outcome: "no_drift"; summary: string }
  | { outcome: "updated"; baseSha: string; headSha: string; headTree: string; summary: string }
  | { outcome: "conflict"; forwardMergeId: string; priorHead: string; priorTree: string; baseSha: string; conflictArtifactId: string; conflictFileCount: number; summary: string };

export interface CiRepairActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  releaseId?: string;
  projectId: string;
  projectRevisionId: string;
  planRevision: number;
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
  summary: string;
  outcome: "completed" | "blocked";
}

export type WorkflowCiRepairActivityInput = Omit<CiRepairActivityInput, "worktreePath"> & import("./development.js").DeveloperSupervisorActivityIdentity & { worktreePath?: string };
export type WorkflowCiRepairActivityResult = Omit<CiRepairActivityResult, "worktreePath">;

export interface CiActivities {
  reconcileCi(input: ReconcileCiActivityInput): Promise<ReconcileCiActivityResult>;
  planCiRepair(input: CiRepairPlanActivityInput): Promise<CiRepairPlanActivityResult>;
  rerunCi(input: RerunCiActivityInput): Promise<RerunCiActivityResult>;
  updateCiFromBase(input: UpdateCiFromBaseActivityInput): Promise<UpdateCiFromBaseActivityResult>;
  runCiRepair(input: WorkflowCiRepairActivityInput): Promise<WorkflowCiRepairActivityResult>;
}
