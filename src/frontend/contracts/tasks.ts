import { z } from "zod";
import type { TaskResponse } from "./generated/TaskResponse.js";

import { MAX_TASK_IMAGE_BASE64_LENGTH, MAX_TASK_IMAGES } from "./attachment-limits.js";

import { IssueAssociationSchema } from "./issues.js";

import { WorkflowIdSchema, AdvisorProfileIdsSchema, PublicWorkflowStateSchema } from "./workflows.js";

import { TaskControlStatusSchema, TaskProfileFieldsSchema, WorktreeReferenceSchema, PullRequestReferenceSchema } from "./task-control.js";

import { AdvisorRoleSchema } from "./advisor-reports.js";

import { ProjectProviderPolicySchema } from "./provider-policy.js";

import { ProjectIntegrationSchema } from "./project-integration.js";

import { ProjectExecutionSchema } from "./project-execution.js";

import { HumanQuestionOptionsSchema } from "./questions.js";

import { TaskLimitPauseSchema, TaskLimitsSchema } from "./task-limits.js";

const id = z.string().min(1).max(256);

export const MAX_TASK_DEPENDENCIES = 50;

const commit = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const DeliveryTargetSchema = z.enum(["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"]);

export const VisualEvidenceSchema = z.enum(["off", "capture", "required"]);

export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;

export const TaskSourceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("branch"), branch: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("pull_request"), number: z.number().int().positive() }).strict(),
]);

export const TaskImageInputSchema = z.object({
  filename: z.string().min(1).max(255).refine(name => !/[\\/]/.test(name) && !name.includes("..")),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  base64: z.string().min(1).max(MAX_TASK_IMAGE_BASE64_LENGTH),
}).strict();

export const PullRequestDependencyInputSchema = z.object({ number: z.number().int().positive() }).strict();

export const TaskInputSchema = z.object({
  projectId: id,
  title: z.string().trim().min(1),
  description: z.string().trim().default(""),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  images: z.array(TaskImageInputSchema).max(MAX_TASK_IMAGES).default([]),
  rootProfileId: id.optional(),
  workerProfileId: id.optional(),
  /** Queues the task: it starts now when every prerequisite is complete, and otherwise when the last one completes. */
  startImmediately: z.boolean().default(false),
  deliveryTarget: DeliveryTargetSchema.default("pull_request_draft"),
  runProjectTests: z.boolean().default(true),
  visualEvidence: VisualEvidenceSchema.default("off"),
  source: TaskSourceInputSchema.optional(),
  issue: IssueAssociationSchema.nullable().optional(),
  workflow: WorkflowIdSchema.default("standard"),
  advisorProfileIds: AdvisorProfileIdsSchema.default({}),
  /** Prerequisite task ids, shown as "Blocked by". With startImmediately, the task is queued: it starts when every one is complete. A prerequisite with a pull request delivery target is complete when its pull request merges. */
  dependsOn: z.array(id).max(MAX_TASK_DEPENDENCIES).default([]),
  /** Pull requests in this project's repository. A queued task starts only after every one merges. */
  blockedByPullRequests: z.array(PullRequestDependencyInputSchema).max(MAX_TASK_DEPENDENCIES).default([]),
}).strict();

export type TaskInput = z.input<typeof TaskInputSchema>;

export const TaskConfigurationSchema = z.object({
  providerPolicy: ProjectProviderPolicySchema.nullable().optional(),
  integration: ProjectIntegrationSchema.optional(),
  execution: ProjectExecutionSchema.optional(),
  repository: z.string().min(1),
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  baselineSha: commit,
  startingSha: commit,
  setupCommand: z.string(),
  verificationCommand: z.string(),
  runProjectTests: z.boolean(),
  visualEvidence: VisualEvidenceSchema,
  // Persisted compatibility key. Renaming it would make existing task configurations unreadable.
  hermesSelection: z.object({
    workflowId: z.string().min(1).max(256).nullable(),
    workflowName: z.string().min(1).max(80).nullable(),
    templateId: z.string().min(1).max(256).nullable(),
  }).strict().optional(),
  source: TaskSourceInputSchema.nullable(),
  capturedAt: z.string().datetime(),
}).strict();

export const TaskImageSchema = z.object({ artifactId: id, filename: z.string(), mimeType: z.string(), byteSize: z.number().int().nonnegative() }).strict();

export const TaskReferenceSchema = z.object({ id, title: z.string(), status: TaskControlStatusSchema }).strict();

export const TaskBlockedBySchema = TaskReferenceSchema.extend({ kind: z.enum(["task", "pull_request"]).optional(), number: z.number().int().min(1).optional(), state: z.enum(["open", "closed", "merged"]).optional(), url: z.string().url().optional(), observedAt: z.string().datetime().optional() }).strict();

export const TaskQueueWaitReasonSchema = z.enum(["prerequisite_not_started", "prerequisite_running", "prerequisite_needs_human", "prerequisite_cancelled", "prerequisite_archived", "prerequisite_merge_unobserved", "prerequisite_pull_request_open", "prerequisite_pull_request_closed"]);

export const TaskQueueWaitSchema = z.object({ kind: z.enum(["task", "pull_request"]).optional(), id, title: z.string(), status: TaskControlStatusSchema, deliveryTarget: DeliveryTargetSchema, number: z.number().int().min(1).optional(), state: z.enum(["open", "closed", "merged"]).optional(), url: z.string().url().optional(), reason: TaskQueueWaitReasonSchema, summary: z.string() }).strict();

export const TaskQueueSchema = z.object({
  projectConcurrencyLimited: z.boolean(),
  waitingOn: z.array(TaskQueueWaitSchema),
}).strict();

const TaskQuestionBaseSchema = z.object({ id, text: z.string(), options: HumanQuestionOptionsSchema.default([]), requiresCommandCleanup: z.boolean() });

export const TaskHumanQuestionSchema = z.discriminatedUnion("kind", [
  TaskQuestionBaseSchema.extend({ kind: z.literal("question") }).strict(),
  TaskQuestionBaseSchema.extend({ kind: z.literal("task_limit"), pause: TaskLimitPauseSchema }).strict(),
]);

// Test-side validator of server output. Application code uses the generated Task type.
export const TaskSchema = z.object({
  id, companyId: id, projectId: id,
  issueKey: z.string().nullable(),
  issue: IssueAssociationSchema.nullable().optional(),
  title: z.string(), description: z.string(),
  status: TaskControlStatusSchema,
  deliveryTarget: DeliveryTargetSchema,
  rootProfile: TaskProfileFieldsSchema,
  workerProfile: TaskProfileFieldsSchema,
  workflow: WorkflowIdSchema,
  advisorProfiles: z.partialRecord(AdvisorRoleSchema, TaskProfileFieldsSchema),
  workflowState: PublicWorkflowStateSchema,
  /** The ids of blockedBy, in the same order. */
  dependsOn: z.array(id).default([]),
  configuration: TaskConfigurationSchema,
  worktree: WorktreeReferenceSchema.nullable(),
  pullRequest: PullRequestReferenceSchema.nullable(),
  humanQuestion: TaskHumanQuestionSchema.nullable(),
  blockedBy: z.array(TaskBlockedBySchema),
  queue: TaskQueueSchema,
  limits: TaskLimitsSchema.extend({ admittedTurns: z.number().int().nonnegative() }).strict(),
  wakeAt: z.string().nullable(),
  images: z.array(TaskImageSchema),
  artifacts: z.array(TaskImageSchema).optional(),
  createdAt: z.string(), updatedAt: z.string(), statusChangedAt: z.string(), archivedAt: z.string().nullable(),
}).strict();

export type Task = TaskResponse;
