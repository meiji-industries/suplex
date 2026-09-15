import { WorkerReplacementRequestSchema, WorkerReplacementSchema } from "../../coordination/worker-replacement-contracts.js";
import { z } from "zod";
import { DeliveryTargetSchema as DeliveryTarget, TaskInputSchema, TaskSchema, VisualEvidenceSchema as VisualEvidence } from "../../tasks/contracts.js";
import { TaskSessionKindSchema, TaskTurnStatusSchema } from "../../tasks/control.js";
import { AdvisorProfileIdsSchema, AdvisorRoleSchema, WorkflowIdSchema } from "../../coordination/workflows.js";
import { TaskLimitDecisionSchema } from "../../tasks/limits/limits.js";
export { SessionHistoryPageSchema } from "../../tasks/history/contracts.js";

export { DeliveryTargetSchema, VisualEvidenceSchema } from "../../tasks/contracts.js";
export { MAX_TASK_REQUEST_BYTES } from "../../tasks/limits/attachment-limits.js";
export const TaskBodySchema = TaskInputSchema;
export const TaskResponseSchema = TaskSchema.strip();
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export const TaskListResponseSchema = z.object({ tasks: z.array(TaskResponseSchema) });
export type TaskListTask = TaskResponse;
/** The fields the Edit task dialog may change. Every field is optional and carries no default, so an edit only writes what it names. */
export const TaskDetailsBodySchema = z.object({
  title: TaskInputSchema.shape.title,
  description: z.string().trim(),
  rootProfileId: z.string().min(1).max(256),
  workerProfileId: z.string().min(1).max(256),
  deliveryTarget: DeliveryTarget,
  runProjectTests: z.boolean(),
  visualEvidence: VisualEvidence,
  workflow: WorkflowIdSchema,
  advisorProfileIds: AdvisorProfileIdsSchema,
}).partial().strict();
export const TaskBlockedByBodySchema = z.object({ blockedByTaskId: z.string().min(1).max(256).nullable() }).strict();
export const TaskRenameBodySchema = TaskInputSchema.pick({ title: true });
export const TaskDependenciesBodySchema = TaskInputSchema.pick({ dependsOn: true }).required().strict();
export const TaskArchiveBodySchema = z.object({ confirmDiscardDirty: z.boolean().optional() }).strict();
export const TaskArchiveResponseSchema = z.union([TaskResponseSchema, z.object({
  status: z.literal("confirmation_required"),
  dirtyFileCount: z.number().int().nonnegative(),
  dirtyFilePaths: z.array(z.string()),
})]);
export const TaskAnswerBodySchema = z.union([
  z.object({ questionId: z.string().min(1), answer: z.string().trim().min(1), confirmCommandsStopped: z.boolean().optional() }).strict(),
  z.object({ questionId: z.string().min(1), limitDecision: TaskLimitDecisionSchema }).strict(),
]);
export const TaskWorkerReplacementBodySchema = WorkerReplacementRequestSchema;
export const TaskNoteBodySchema = z.object({ note: z.string().trim().min(1).max(20_000) }).strict(); // bound: task note transport limit
export const TaskHarnessKindSchema = z.enum(["claude-code", "codex", "opencode", "devin"]);
export const TaskActivityResponseSchema = z.object({
  sessions: z.array(z.object({ id: z.string(), kind: TaskSessionKindSchema, advisorRole: AdvisorRoleSchema.nullable(), label: z.string(), profileId: z.string(), harness: TaskHarnessKindSchema.optional(), generation: z.number(), nativeSessionId: z.string().nullable(), paneId: z.string().nullable(), current: z.boolean(), replacement: WorkerReplacementSchema.nullable().optional() })),
  turns: z.array(z.object({ id: z.string(), sessionId: z.string(), prompt: z.string(), status: TaskTurnStatusSchema, result: z.string().nullable() })),
  shellPaneId: z.string().nullable(),
});
export const TaskSessionHistoryParamsSchema = z.object({ taskId: z.string().min(1), sessionId: z.string().min(1) });
export const TaskSessionHistoryQuerySchema = z.object({ before: z.string().min(1).max(512).optional() });

export const TaskDiffResponseSchema = z.object({ available: z.boolean(), patch: z.string(), truncated: z.boolean() });
export const TaskDiffSummaryResponseSchema = z.object({ available: z.boolean(), files: z.number().int().nonnegative() });
export const TaskAgentStatusSchema = z.enum(["queued", "working", "retrying", "idle", "waiting_human", "stopped", "unknown"]);
export const TaskAgentsResponseSchema = z.object({ agents: z.array(z.object({ id: z.string(), role: TaskSessionKindSchema, advisorRole: AdvisorRoleSchema.nullable().optional(), label: z.string().optional(), paneId: z.string().nullable(), status: TaskAgentStatusSchema, statusChangedAt: z.string().datetime().nullable() })) });
export const TaskChecksResponseSchema = z.object({
  available: z.boolean(),
  pullRequestState: z.enum(["draft", "ready", "closed", "merged"]).nullable().optional(),
  runs: z.array(z.object({ name: z.string(), status: z.enum(["pending", "failing", "successful"]), url: z.string().nullable(), conclusion: z.string().optional(), workflow: z.string().nullable().optional(), startedAt: z.string().datetime().nullable().optional(), completedAt: z.string().datetime().nullable().optional() })),
});
export const WorktreeAppSchema = z.enum(["finder", "cursor", "vscode", "ghostty", "terminal"]);
export const WorktreeAppsResponseSchema = z.object({ apps: z.array(z.object({ id: WorktreeAppSchema, label: z.string() })) });
