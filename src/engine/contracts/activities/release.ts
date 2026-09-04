import { z } from "zod";
import { ReleaseFailureCodeSchema } from "../../../release-failures.js";
import { ArtifactReferenceSchema, DurableArtifactReferenceSchema, sha, durableId } from "../primitives.js";

export interface PublishReleaseActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  reviewId: string;
  developerExecutionId: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  planSummary?: string;
  deliverySummary?: string;
  verificationSummary?: string;
  releaseId?: string;
  pullRequestMode?: "draft" | "ready" | "auto_merge";
}

const PublishReleaseIdentitySchema = z.object({
  repository: z.string().max(256),
  branchName: z.string().max(256),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  headTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  reused: z.boolean(),
  attempt: z.number().int().nonnegative(),
});
export const PublishReleaseActivityResultSchema = z.discriminatedUnion("outcome", [
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("completed"), releaseId: durableId, baseBranch: z.string().min(1).max(256), pullRequestNumber: z.number().int().positive(), pullRequestUrl: z.string().url().max(2_000), isDraft: z.boolean(), targetBaseSha: sha.optional() }),
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("blocked"), releaseId: durableId.nullable(), pullRequestNumber: z.null(), pullRequestUrl: z.null(), isDraft: z.boolean(), code: ReleaseFailureCodeSchema, summary: z.string(), retryAt: z.string().datetime().nullable() }),
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("base-drift-merged"), releaseId: z.null(), pullRequestNumber: z.null(), pullRequestUrl: z.null(), isDraft: z.literal(false), baseDriftMerged: z.literal(true), targetBaseSha: sha, priorHead: sha, forwardMergeId: durableId.optional(), mergeCommit: sha.optional(), tree: sha.optional() }),
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("base-drift-conflict"), releaseId: z.null(), pullRequestNumber: z.null(), pullRequestUrl: z.null(), isDraft: z.literal(false), baseDriftConflict: z.literal(true), targetBaseSha: sha, priorHead: sha, forwardMergeId: durableId.optional(), mergeConflictEvidence: DurableArtifactReferenceSchema.optional(), conflictFiles: z.array(z.string()).optional(), conflictDiff: z.string().max(80_000).optional(), priorTree: sha.optional(), conflictArtifact: ArtifactReferenceSchema.optional(), conflictFileCount: z.number().int().min(1).max(128).optional() }),
]);
export type PublishReleaseActivityResult = z.infer<typeof PublishReleaseActivityResultSchema>;

export interface AdoptPullRequestReleaseActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectRevisionId: string;
  repository: string;
  branchName: string;
  baseBranch: string;
  expectedBaseSha?: string;
  pullRequestNumber: number;
  headSha: string;
}
export interface AdoptPullRequestReleaseActivityResult {
  releaseId: string;
  repository: string;
  branchName: string;
  baseBranch: string;
  targetBaseSha: string;
  headSha: string;
  headTree: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface ReleaseActivities {
  claimDeliveryOwner(input: { taskId: string; companyId: string; workflowId: string; projectRevisionId: string; generation: number; token: string; objective?: string }): Promise<{ outcome: "owned" | "recovered" | "owned_elsewhere" | "cancelled"; wakeAt?: string | null }>;
  recordDeliveryOwnerReceipt(input: { taskId: string; companyId: string; workflowId: string; projectRevisionId: string; generation: number; token: string; receipt: unknown }): Promise<boolean>;
  cancelDeliveryOwner(input: { taskId: string; companyId: string; workflowId: string; projectRevisionId: string; generation: number }): Promise<boolean>;
  publishRelease(input: PublishReleaseActivityInput): Promise<PublishReleaseActivityResult>;
  pushDeliveryBranch(input: { taskId: string; companyId: string; workflowId: string; branchName: string; commitSha: string }): Promise<{ repository: string; branchName: string; commitSha: string }>;
  adoptPullRequestRelease(input: AdoptPullRequestReleaseActivityInput): Promise<AdoptPullRequestReleaseActivityResult>;
}
