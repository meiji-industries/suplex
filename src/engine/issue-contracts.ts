import { z } from "zod";

import { DecisionIdempotencyKeySchema, PlanBlockerSubjectSchema, PlanDecisionSubjectSchema } from "../plan-governance.js";
import { durableId } from "../commands/inputs.js";
import { at } from "../issue-phases.js";

export { ContinueWorkCommandSchema, PlanCommandInputSchema, PlanRevisionCommandSchema, RecordProgressInputSchema, ResolveDecisionBlockerInputSchema, SendPlannerNoteInputSchema, StartPlanningInputSchema } from "../commands/inputs.js";
export type { ContinueWorkCommand, PlanCommandInput, PlanRevisionCommand, RecordProgressInput, ResolveDecisionBlockerInput, SendPlannerNoteInput, StartPlanningInput } from "../commands/inputs.js";
export type { LeadPlanningResult } from "../lead-contracts.js";
export { IssueCommandSchema } from "../commands/registry.js";
export type { IssueCommand } from "../commands/registry.js";
export { IssuePhaseSchema } from "../issue-phases.js";

export * from "./contracts/primitives.js";
export { IssueContinuationStateSchema, IssueWorkflowStateSchema } from "./contracts/state/index.js";
export * from "./contracts/activities/index.js";
import { IssueContinuationStateSchema, IssueWorkflowStateSchema } from "./contracts/state/index.js";

export const IssueWorkflowInputWithContinuationSchema = z.object({
  continuationState: IssueContinuationStateSchema.optional(),
  continueAsNewAfter: z.number().int().min(0).max(10_000).optional(),
});

export const IssueWorkflowInputSchema = z.object({
  workflowId: durableId,
  companyId: durableId,
  projectId: durableId,
  issueId: durableId,
  /** Historical compatibility only; ignored by snapshot readers. */
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  briefSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  imageArtifactIds: z.array(durableId).max(32),
  // A compact identity marker lets a start retry prove it refers to the same
  // creation request without putting task content in legacy workflow service history.
  requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  predecessorTaskId: durableId.optional(),
  roleProfiles: z.preprocess((value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      return { planner: v.planner ?? v.analyst ?? v.lead, builder: v.builder ?? v.implementer ?? v.developer, reviewer: v.reviewer, integrator: v.integrator };
    }
    return value;
  }, z.object({ planner: durableId.optional(), builder: durableId.optional(), reviewer: durableId.optional(), integrator: durableId.optional() })),
  supplementalReview: z.boolean(),
  repairCycleLimit: z.number().int().min(0).max(5).default(2),
  autoApprovePlan: z.boolean().optional(),
  autoApprovePlanActorUserId: durableId.optional(),
  pullRequestMode: z.enum(["draft", "ready", "auto_merge"]).optional(),
  deliveryTarget: z.enum(["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"]).optional(),
  runProjectTests: z.boolean().optional(),
  visualEvidence: z.enum(["off", "capture", "required"]).optional(),
  autoMergeActorUserId: durableId.optional(),
  repository: z.string().min(1).max(256).optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pull_request"), number: z.number().int().positive(), url: z.string().url(), headBranch: z.string().min(1), baseBranch: z.string().min(1), headSha: z.string().regex(/^[a-f0-9]{40,64}$/i), baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i) }).strict(),
    z.object({ kind: z.literal("branch"), branch: z.string().min(1), headSha: z.string().regex(/^[a-f0-9]{40,64}$/i) }).strict(),
  ]).optional(),
}).merge(IssueWorkflowInputWithContinuationSchema);


export function buildInitialIssueWorkflowState(input: IssueWorkflowInput & { stateChangedAt?: string }): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    workflowId: input.workflowId,
    companyId: input.companyId,
    projectId: input.projectId,
    issueId: input.issueId,
    projectRevisionId: input.projectRevisionId,
    ...(input.requestHash ? { requestHash: input.requestHash } : {}),
    ...(input.predecessorTaskId ? { predecessorTaskId: input.predecessorTaskId } : {}),
    ...at("backlog"),
    revision: 0,
    owner: "human",
    allowedCommands: ["start_planning"],
    pendingAction: "Start planning",
    lastEventId: `${input.workflowId}:0`,
    continuationCount: 0,
    lastSummaryHash: null,
    repairCycle: 0,
    blocker: null,
    stateChangedAt: input.stateChangedAt ?? new Date().toISOString(),
    activeOperation: null,
    processedCommandIds: [],
  });
}

export const createInitialIssueWorkflowState = buildInitialIssueWorkflowState;

export const IssueProjectionEventSchema = z.object({
  schemaVersion: z.literal(1),
  runId: durableId,
  eventId: durableId,
  state: IssueWorkflowStateSchema,
}).superRefine((event, context) => {
  if (event.eventId !== event.state.lastEventId) context.addIssue({ code: "custom", path: ["eventId"], message: "Projection event ID must match state.lastEventId" });
});

export type IssueProjectionEvent = z.infer<typeof IssueProjectionEventSchema>;

export const WorkflowPlanDecisionCommandSchema = z.object({
  actorUserId: durableId,
  decision: z.enum(["approve", "request_revision"]),
  subject: PlanDecisionSubjectSchema,
  noteStagingRef: durableId,
  idempotencyKey: DecisionIdempotencyKeySchema,
}).strict();

export const WorkflowPlanBlockerResponseCommandSchema = z.object({
  actorUserId: durableId,
  subject: PlanBlockerSubjectSchema,
  expectedWorkflowRevision: z.number().int().nonnegative(),
  answerStagingRef: durableId,
  idempotencyKey: DecisionIdempotencyKeySchema,
}).strict();

export type IssueWorkflowInput = Omit<z.output<typeof IssueWorkflowInputSchema>, "repairCycleLimit"> & { repairCycleLimit?: number };
export type IssueWorkflowState = z.infer<typeof IssueWorkflowStateSchema>;
export type WorkflowPlanDecisionCommand = z.infer<typeof WorkflowPlanDecisionCommandSchema>;
export type WorkflowPlanBlockerResponseCommand = z.infer<typeof WorkflowPlanBlockerResponseCommandSchema>;
