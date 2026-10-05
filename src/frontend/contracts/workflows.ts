import { z } from "zod";

import { ReviewerResultSchema, RaterResultSchema } from "./advisor-reports.js";

const id = z.string().min(1).max(256);

const commit = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const WorkflowIdSchema = z.enum(["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request", "approve_then_build"]);

export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

export const AdvisorProfileIdsSchema = z.object({ reviewer: id.optional(), planner_a: id.optional(), planner_b: id.optional(), rater: id.optional() }).strict();

export type AdvisorProfileIds = z.infer<typeof AdvisorProfileIdsSchema>;

export const ReviewRangeSchema = z.object({ baseSha: commit, headSha: commit, files: z.array(z.string().min(1)), commits: z.array(commit), patchDigest: z.string().optional() }).strict();

const reviewRecordBase = { sessionId: id, turnId: id, range: ReviewRangeSchema, invalidReason: z.string().nullable(), recordedAt: z.string() };

export const ReviewRecordSchema = z.discriminatedUnion("role", [
  z.object({ ...reviewRecordBase, role: z.literal("reviewer"), result: ReviewerResultSchema.nullable() }).strict(),
  z.object({ ...reviewRecordBase, role: z.literal("rater"), result: RaterResultSchema.nullable() }).strict(),
]);

export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const DeliveryWaitSchema = z.object({ headSha: z.string().min(1), fingerprint: z.string().min(1), since: z.string(), reason: z.enum(["checks", "mergeability", "merge_queue", "observation"]) }).strict();

export const WorkflowCompletionSchema = z.object({ kind: z.enum(["workflow", "external_merge"]), reviewedHead: z.string().nullable(), pullRequestNumber: z.number().int().positive().nullable(), observedAt: z.string() }).strict();

export const PublicWorkflowStateSchema = z.object({ version: z.literal(1), reviews: z.array(ReviewRecordSchema), acceptedDelivery: ReviewRangeSchema.nullable(), deliveryWait: DeliveryWaitSchema.nullable(), completion: WorkflowCompletionSchema.nullable(), planApproval: z.object({ proposed: z.string(), questionId: z.string(), approved: z.string().nullable() }).strict().optional() }).strict();
