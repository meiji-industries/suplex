import type { DeliveryFinding, DurableArtifactReference } from "../primitives.js";

export interface FinalReviewActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  roleProfiles: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  releaseId: string;
  deliveryReviewId: string;
  ciRunId: string;
  pullRequestNumber?: number;
  repository?: string;
  baseBranch?: string;
  planRevision: number;
  leadSessionRef: string;
  leadOutputArtifactId: string;
  developerExecutionId: string;
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  capacityRequestId?: string;
}

export type WorkflowFinalReviewActivityInput = Omit<FinalReviewActivityInput, "worktreePath"> & { worktreePath?: string };

export interface FinalReviewActivityResult {
  finalReviewId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256?: string;
  reviewArtifact: DurableArtifactReference;
  outcome: "approved" | "blocking";
  summary: string;
  findings: DeliveryFinding[];
  repairPlan: string | null;
  repairPlanArtifactId: string | null;
  repairPlanSha256: string | null;
}

export interface FinalReviewActivities {
  finalReview(input: WorkflowFinalReviewActivityInput): Promise<FinalReviewActivityResult>;
}
