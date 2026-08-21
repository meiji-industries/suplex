import type { ArtifactReference } from "../primitives.js";
import type { DeveloperTurnActivityOutcome } from "./development.js";

export interface MergeConflictPlanActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  planRevision: number;
  forwardMergeId: string;
  roleProfiles?: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  leadSessionRef: string;
  leadOutputArtifactId: string;
  worktreePath: string;
  branchName: string;
  priorHead: string;
  targetBaseSha: string;
  conflictArtifact: ArtifactReference;
  conflictFileCount: number;
  capacityRequestId?: string;
}

export type WorkflowMergeConflictPlanActivityInput = Omit<MergeConflictPlanActivityInput, "worktreePath"> & {
  worktreePath?: string;
};

export interface MergeConflictPlanActivityResult {
  planId: string;
  planArtifactId: string;
  evidenceArtifactId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  summary: string;
}

export interface MergeConflictResolutionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  planRevision: number;
  forwardMergeId: string;
  developerExecutionId: string;
  developerSessionRef: string;
  worktreePath: string;
  branchName: string;
  priorHead: string;
  targetBaseSha: string;
  conflictArtifact: ArtifactReference;
  conflictFileCount: number;
  planArtifactId: string;
  capacityRequestId?: string;
}

export type WorkflowMergeConflictResolutionActivityInput = Omit<MergeConflictResolutionActivityInput, "worktreePath"> & {
  worktreePath?: string;
};

export interface MergeConflictResolutionActivitySuccess {
  developerExecutionId: string;
  developerSessionRef: string;
  resultCommit: string;
  resultTree: string;
  deliveryArtifactId: string;
  deliveryArtifactSha256: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256: string;
  verificationArtifactId: string;
  verificationArtifactSha256: string;
  summary: string;
}

export interface MergeConflictResolutionVerificationBlocked {
  outcome: "verification_blocked";
  developerExecutionId: string;
  developerSessionRef: string;
  resultCommit: string;
  resultTree: string;
  evidenceArtifactId: string;
  verificationArtifact: ArtifactReference;
  code: "verification_failed" | "verification_timed_out" | "verification_evidence_too_large";
  summary: string;
}

export type MergeConflictResolutionActivityResult = MergeConflictResolutionActivitySuccess | MergeConflictResolutionVerificationBlocked;

export type SupervisedMergeConflictResolutionActivityInput = WorkflowMergeConflictResolutionActivityInput & import("./development.js").DeveloperSupervisorActivityIdentity;

export interface ReconcileMergeActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  acceptanceId: string;
}

export interface ReconcileMergeActivityResult {
  outcome: "open" | "merged" | "closed_without_merge" | "changed_head" | "changed_base" | "provider_unavailable";
  pullRequestNumber: number;
  pullRequestUrl: string;
  mergeObservationId: string | null;
  completionReceiptId: string | null;
  observedAt: string;
  mergedAt: string | null;
  retryAt: string | null;
  blockerCode?: string;
  blockerSummary?: string;
  evidenceArtifactId?: string | null;
  evidenceArtifactSha256?: string;
}

export interface MergeConflictActivities {
  reconcileMerge(input: ReconcileMergeActivityInput): Promise<ReconcileMergeActivityResult>;
  planMergeConflict(input: WorkflowMergeConflictPlanActivityInput): Promise<MergeConflictPlanActivityResult>;
  resolveMergeConflict(input: WorkflowMergeConflictResolutionActivityInput): Promise<MergeConflictResolutionActivityResult>;
  resolveMergeConflictSupervised(input: SupervisedMergeConflictResolutionActivityInput): Promise<DeveloperTurnActivityOutcome<MergeConflictResolutionActivityResult>>;
}
