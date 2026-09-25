import { z } from "zod";
import { AdvisorResultSchema, AdvisorRoleSchema, RaterResultSchema, ReviewerResultSchema } from "./advisor-report-contracts.js";

const id = z.string().min(1).max(256);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/i);
export const WorkflowIdSchema = z.enum(["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request"]);
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;
export const AdvisorProfileIdsSchema = z.object({ reviewer: id.optional(), planner_a: id.optional(), planner_b: id.optional(), rater: id.optional() }).strict();
export type AdvisorProfileIds = z.infer<typeof AdvisorProfileIdsSchema>;

export const ReviewRangeSchema = z.object({ baseSha: commit, headSha: commit, files: z.array(z.string().min(1)), commits: z.array(commit), patchDigest: z.string().optional() }).strict();
export type ReviewRange = z.infer<typeof ReviewRangeSchema>;

const reviewRecordBase = { sessionId: id, turnId: id, range: ReviewRangeSchema, invalidReason: z.string().nullable(), recordedAt: z.string() };
export const ReviewRecordSchema = z.discriminatedUnion("role", [
  z.object({ ...reviewRecordBase, role: z.literal("reviewer"), result: ReviewerResultSchema.nullable() }).strict(),
  z.object({ ...reviewRecordBase, role: z.literal("rater"), result: RaterResultSchema.nullable() }).strict(),
]);
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const ReportReferenceSchema = z.object({ sessionId: id, turnId: id }).strict();
export type ReportReference = z.infer<typeof ReportReferenceSchema>;
const AdvisorWorkflowInputSchema = z.object({ kind: z.literal("advisor"), role: AdvisorRoleSchema, range: ReviewRangeSchema, evidenceDirectory: z.string().min(1), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), verificationTurnIds: z.array(id), plannerPairId: id.optional() }).strict();
const WorkerInputBase = { kind: z.literal("worker"), mode: z.enum(["planned", "direct"]), purpose: z.enum(["implementation", "verification"]), range: ReviewRangeSchema, plan: z.string().nullable(), acceptanceCriteria: z.array(z.string()), instruction: z.string() };
const LegacyWorkerWorkflowInputSchema = z.object({ ...WorkerInputBase, advisorSessionId: id.nullable(), candidateSessionIds: z.tuple([id, id]).nullable() }).strict();
export const WorkerWorkflowInputSchema = z.object({ ...WorkerInputBase, version: z.literal(2), advisorReport: ReportReferenceSchema.nullable(), candidateReports: z.tuple([ReportReferenceSchema, ReportReferenceSchema]).nullable() }).strict();
export const WorkflowInputSchema = z.union([AdvisorWorkflowInputSchema, WorkerWorkflowInputSchema, LegacyWorkerWorkflowInputSchema]);
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;
export type WorkerWorkflowInput = Extract<WorkflowInput, { kind: "worker" }>;

/** Proof that a check-only Worker ran against one committed source: identical clean endpoints before and after. */
export const VerificationRangeSchema = z.object({ before: ReviewRangeSchema, after: ReviewRangeSchema.nullable(), cleanAfter: z.boolean().nullable(), valid: z.boolean(), invalidReason: z.string().nullable() }).strict();
export type VerificationRange = z.infer<typeof VerificationRangeSchema>;

export const DeliveryWaitSchema = z.object({ headSha: z.string().min(1), fingerprint: z.string().min(1), since: z.string(), reason: z.enum(["checks", "mergeability", "merge_queue", "observation"]) }).strict();
export type DeliveryWait = z.infer<typeof DeliveryWaitSchema>;
export const WorkflowCompletionSchema = z.object({ kind: z.enum(["workflow", "external_merge"]), reviewedHead: z.string().nullable(), pullRequestNumber: z.number().int().positive().nullable(), observedAt: z.string() }).strict();
export type WorkflowCompletion = z.infer<typeof WorkflowCompletionSchema>;
export const PublicWorkflowStateSchema = z.object({ version: z.literal(1), reviews: z.array(ReviewRecordSchema), acceptedDelivery: ReviewRangeSchema.nullable(), deliveryWait: DeliveryWaitSchema.nullable(), completion: WorkflowCompletionSchema.nullable() }).strict();
export const AgentSelectionIntentSchema = z.object({ role: z.enum(["root", "worker", ...AdvisorRoleSchema.options]), expectedProfileId: z.string(), expectedSessionId: z.string().nullable(), profileId: z.string(), direction: z.string(), resume: z.boolean(), questionId: z.string().nullable() }).strict();
export const WorkflowStateSchema = PublicWorkflowStateSchema.extend({ followUp: z.boolean().optional(), deliveryHistory: z.array(z.object({ resumedAt: z.string(), acceptedDelivery: ReviewRangeSchema.nullable(), completion: WorkflowCompletionSchema.nullable() }).strict()).optional(), toolOwner: z.object({ token: z.string().min(1), pid: z.number().int().positive(), processStartTime: z.string().min(1) }).strict().nullable(), agentSelections: z.partialRecord(z.enum(["root", "worker", ...AdvisorRoleSchema.options]), AgentSelectionIntentSchema).optional(), initialRootSelectionSessionId: z.string().optional() }).strict();
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type PublicWorkflowState = z.infer<typeof PublicWorkflowStateSchema>;

/** The advisor outcome that Suplex stored inside an Advisor turn's terminal observation. */
export const AdvisorOutcomeSchema = z.object({ role: AdvisorRoleSchema, result: AdvisorResultSchema.nullable(), invalidReason: z.string().nullable() });
export type AdvisorOutcome = z.infer<typeof AdvisorOutcomeSchema>;
