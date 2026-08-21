import { z } from "zod";
import {
  blockSummary, DeliveryFindingSchema, DeliveryOperationBlockCodeSchema, DeliveryReviewSubjectSchema, DurableArtifactReferenceSchema,
  RepairAuthoritySchema, sha, durableId,
} from "../primitives.js";
import type { DeliveryFinding, DurableArtifactReference } from "../primitives.js";
import type { AuthorizedPlanSubject } from "../../../developer-contracts.js";
import type { MaterialityEvidenceSubject, PlanSubject } from "../../../plan-governance.js";

export const DeveloperRepairActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  planRevision: z.number().int().nonnegative(),
  roleProfiles: z.object({ planner: durableId.optional(), builder: durableId.optional(), reviewer: durableId.optional(), integrator: durableId.optional() }),
  leadSessionRef: durableId,
  developerSessionRef: durableId,
  developerExecutionId: durableId,
  reviewId: durableId,
  repairAuthority: RepairAuthoritySchema.default("delivery_review"),
  reviewArtifact: DurableArtifactReferenceSchema.optional(),
  cycle: z.number().int().positive(),
  repairCycleLimit: z.number().int().min(0).max(5),
  worktreePath: z.string().min(1).max(1_000),
  branchName: z.string().min(1).max(256),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  blockingFindings: z.array(DeliveryFindingSchema).max(64),
  repairPlan: z.string().min(1).max(12_000).optional(),
  repairPlanArtifactId: durableId.optional(),
  repairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  capacityRequestId: durableId.optional(),
}).superRefine((value, context) => {
  if (!value.repairPlan && !value.repairPlanArtifactId) context.addIssue({ code: "custom", path: ["repairPlanArtifactId"], message: "A verified repair-plan artifact is required" });
  if (value.repairPlanArtifactId && !value.repairPlanSha256) context.addIssue({ code: "custom", path: ["repairPlanSha256"], message: "The repair-plan artifact hash is required" });
});

const repairSubject = DeliveryReviewSubjectSchema;
export const DeveloperRepairActivityResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    repairAttemptId: durableId,
    cycle: z.number().int().positive(),
    reviewId: durableId,
    subject: repairSubject,
    developerExecutionId: durableId,
    developerSessionRef: durableId,
    worktreePath: z.string().min(1).max(1_000),
    branchName: z.string().min(1).max(256),
    resultCommit: sha,
    resultTree: sha,
    dirtyState: z.literal("clean"),
    deliveryArtifactId: durableId,
    evidenceArtifactId: durableId,
    summary: z.string().min(1).max(2_000),
  }).strict(),
  z.object({
    outcome: z.literal("blocked"),
    repairAttemptId: durableId,
    cycle: z.number().int().positive(),
    reviewId: durableId,
    subject: repairSubject,
    code: DeliveryOperationBlockCodeSchema,
    summary: blockSummary,
    evidenceArtifactId: durableId,
    developerExecutionId: durableId,
    developerSessionRef: durableId,
    worktreePath: z.string().min(1).max(1_000),
    branchName: z.string().min(1).max(256),
    resultCommit: sha.nullable(),
    resultTree: sha.nullable(),
    dirtyState: z.enum(["clean", "dirty"]).nullable(),
  }).strict(),
]);
export type DeveloperRepairActivityResult = z.infer<typeof DeveloperRepairActivityResultSchema>;

export interface DeveloperExecutionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  planRevision: number;
  roleProfiles: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  leadSessionRef: string;
  leadOutputArtifactId: string;
  revisionRequestId?: string;
  executionId?: string;
  developerExecutionId?: string;
  developerAttempt?: number;
  turnKind?: DeveloperTurnKind;
  finalPlanSubject?: PlanSubject;
  materialityEvidence?: MaterialityEvidenceSubject;
  approvalDecisionId?: string;
  supersedesExecutionId?: string | undefined;
  reuseWorktree?: boolean | undefined;
  capacityRequestId?: string;
  authorization?: AuthorizedPlanSubject;
}

export interface DeveloperExecutionResult {
  developerExecutionId: string;
  developerSessionRef: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  currentStep: number | null;
  resultCommit: string | null;
  resultTree: string | null;
  dirtyState: "clean" | "dirty";
  deliveryArtifactId: string;
  deliveryArtifactSha256?: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256?: string;
  attentionEvidenceArtifactId?: string;
  attentionEvidenceSha256?: string;
  deliverySummary: string;
  outcome: "completed" | "blocked";
  failureCode?: string | null;
  reconciliationArtifactId?: string;
  providerObservationArtifactId?: string;
}

export type WorkflowDeveloperExecutionResult = Omit<DeveloperExecutionResult, "worktreePath">;

export type DeveloperTurnKind = "implementation" | "repair" | "merge_conflict_resolution";

export interface DeveloperSupervisorActivityIdentity {
  developerTurnExecutionId: string;
  developerAttempt: number;
  turnKind: DeveloperTurnKind;
}

export type DeveloperTurnActivityOutcome<T> =
  | { status: "completed"; result: T; resultHash: string }
  | { status: "interrupted"; developerExecutionId: string; reasonCode: string; summary: string; lastHeartbeatAt: string | null }
  | { status: "ownership_ambiguous"; developerExecutionId: string; reasonCode: string; summary: string; lastHeartbeatAt: string | null }
  | { status: "failed"; developerExecutionId: string; reasonCode: string; summary: string; evidenceArtifactId: string | null };

export type SupervisedDeveloperExecutionActivityInput = Omit<DeveloperExecutionActivityInput, "executionId"> & DeveloperSupervisorActivityIdentity;
export type SupervisedDeveloperRepairActivityInput = WorkflowDeveloperRepairActivityInput & DeveloperSupervisorActivityIdentity;

export type DeveloperCancellationResult =
  | { status: "cancelled" }
  | { status: "cancelled_confirmed"; executionId: string; exitCode: number | null; exitSignal: string | null; evidenceArtifactId: string | null }
  | { status: "completed_before_cancellation"; executionId: string; result: unknown; resultHash: string }
  | { status: "interrupted" | "ownership_ambiguous"; executionId: string; reasonCode: string; summary: string }
  | { status: "termination_failed"; executionId: string; reasonCode: string; summary: string; evidenceArtifactId: string | null };

export interface DeveloperOwnershipObservation {
  executionId: string;
  status: "active" | "result_ready" | "interrupted" | "ownership_ambiguous";
  reasonCode: string | null;
  summary: string;
  lastHeartbeatAt: string | null;
}

export interface DeveloperCancellationActivityInput {
  taskId: string;
  companyId: string;
  executionId: string;
}

export interface DeveloperRepairActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  planRevision: number;
  roleProfiles: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  leadSessionRef: string;
  developerSessionRef: string;
  developerExecutionId: string;
  reviewId: string;
  repairAuthority?: z.infer<typeof RepairAuthoritySchema>;
  reviewArtifact?: DurableArtifactReference;
  cycle: number;
  repairCycleLimit: number;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  blockingFindings: DeliveryFinding[];
  repairPlan?: string;
  repairPlanArtifactId?: string;
  repairPlanSha256?: string;
  capacityRequestId?: string;
}

export interface LegacyDeveloperRepairResult {
  developerExecutionId: string;
  developerSessionRef: string;
  supersedesExecutionId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  resultCommit: string;
  resultTree: string;
  dirtyState: "clean" | "dirty";
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  deliverySummary: string;
  outcome: "completed" | "blocked";
  cycle: number;
}

export type DeveloperRepairResult = DeveloperRepairActivityResult | LegacyDeveloperRepairResult;
export type WorkflowDeveloperRepairResult =
  | Omit<Extract<DeveloperRepairActivityResult, { outcome: "completed" }>, "worktreePath">
  | Omit<Extract<DeveloperRepairActivityResult, { outcome: "blocked" }>, "worktreePath">;

/** Workflow-safe repair input. Findings and the worktree remain in durable artifacts/database state. */
export type WorkflowDeveloperRepairActivityInput = Omit<DeveloperRepairActivityInput, "worktreePath" | "blockingFindings" | "repairPlan"> & {
  worktreePath?: string;
  blockingFindings?: DeliveryFinding[];
  repairPlan?: string;
};

export interface DevelopmentActivities {
  findActiveDeveloperExecution(input: { taskId: string; companyId: string; workflowId: string }): Promise<{ executionId: string; sessionRef: string } | null>;
  cancelDeveloperExecution(input: DeveloperCancellationActivityInput): Promise<DeveloperCancellationResult>;
  observeDeveloperExecution(input: DeveloperCancellationActivityInput): Promise<DeveloperOwnershipObservation>;
  reconcileDeveloperDeliveryEvidence(input: { taskId: string; companyId: string; workflowId: string; developerExecutionId: string }): Promise<WorkflowDeveloperExecutionResult | null>;
  runDeveloperExecution(input: DeveloperExecutionActivityInput): Promise<WorkflowDeveloperExecutionResult>;
  runDeveloperExecutionSupervised(input: SupervisedDeveloperExecutionActivityInput): Promise<DeveloperTurnActivityOutcome<WorkflowDeveloperExecutionResult>>;
  runDeveloperRepair(input: WorkflowDeveloperRepairActivityInput): Promise<WorkflowDeveloperRepairResult>;
  runDeveloperRepairSupervised(input: SupervisedDeveloperRepairActivityInput): Promise<DeveloperTurnActivityOutcome<WorkflowDeveloperRepairResult>>;
}
