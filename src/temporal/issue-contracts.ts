import { z } from "zod";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const IssuePhaseSchema = z.enum(["backlog", "planning"]);

export const IssueContinuationStateSchema = z.object({
  phase: IssuePhaseSchema,
  revision: z.number().int().nonnegative(),
  owner: z.enum(["human", "lead"]),
  allowedCommands: z.array(z.enum(["start_planning", "record_progress"])),
  pendingAction: z.string().max(200).nullable(),
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});

export const IssueWorkflowInputWithContinuationSchema = z.object({
  continuationState: IssueContinuationStateSchema.optional(),
  continueAsNewAfter: z.number().int().min(0).max(10_000).optional(),
});

export const IssueWorkflowInputSchema = z.object({
  workflowId: durableId,
  companyId: durableId,
  projectId: durableId,
  issueId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  briefSha256: z.string().regex(/^[a-f0-9]{64}$/),
  imageArtifactIds: z.array(durableId).max(32),
  roleProfiles: z.object({ lead: durableId.optional(), developer: durableId.optional(), reviewer: durableId.optional() }),
  supplementalReview: z.boolean(),
}).merge(IssueWorkflowInputWithContinuationSchema);

export const IssueWorkflowStateSchema = z.object({
  workflowId: durableId,
  companyId: durableId,
  projectId: durableId,
  issueId: durableId,
  projectRevisionId: durableId,
  phase: IssuePhaseSchema,
  revision: z.number().int().nonnegative(),
  owner: z.enum(["human", "lead"]),
  allowedCommands: z.array(z.enum(["start_planning", "record_progress"])),
  pendingAction: z.string().max(200).nullable(),
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});

export const StartPlanningInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
});

export const RecordProgressInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  summaryHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type IssueWorkflowInput = z.infer<typeof IssueWorkflowInputSchema>;
export type IssueWorkflowState = z.infer<typeof IssueWorkflowStateSchema>;
export type StartPlanningInput = z.infer<typeof StartPlanningInputSchema>;
export type RecordProgressInput = z.infer<typeof RecordProgressInputSchema>;

export interface IssueActivities {
  projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState>;
}
