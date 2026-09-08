import { z } from "zod";
import { HumanQuestionOptionsSchema } from "../coordination/human-question.js";
import { TaskControlStatusSchema, TaskProfileSchema, WorktreeReferenceSchema, PullRequestReferenceSchema } from "./control.js";
import { MAX_TASK_IMAGES, MAX_TASK_IMAGE_BASE64_LENGTH } from "./limits/attachment-limits.js";
import { AdvisorProfileIdsSchema, AdvisorRoleSchema, PublicWorkflowStateSchema, WorkflowIdSchema } from "../coordination/workflows.js";
import { TaskLimitPauseSchema, TaskLimitsSchema } from "./limits/limits.js";

const id = z.string().min(1).max(256);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/i);
export const DeliveryTargetSchema = z.enum(["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"]);
export const VisualEvidenceSchema = z.enum(["off", "capture", "required"]);
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;
export type VisualEvidence = z.infer<typeof VisualEvidenceSchema>;
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
export const TaskInputSchema = z.object({
  projectId: id,
  title: z.string().trim().min(1),
  description: z.string().trim().default(""),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  images: z.array(TaskImageInputSchema).max(MAX_TASK_IMAGES).default([]),
  rootProfileId: id.optional(),
  workerProfileId: id.optional(),
  startImmediately: z.boolean().default(false),
  deliveryTarget: DeliveryTargetSchema.default("pull_request_draft"),
  runProjectTests: z.boolean().default(true),
  visualEvidence: VisualEvidenceSchema.default("off"),
  source: TaskSourceInputSchema.optional(),
  workflow: WorkflowIdSchema.default("standard"),
  advisorProfileIds: AdvisorProfileIdsSchema.default({}),
}).strict();
export type TaskInput = z.input<typeof TaskInputSchema>;
export type TaskRequest = z.output<typeof TaskInputSchema>;

export const TaskConfigurationSchema = z.object({
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
  source: TaskSourceInputSchema.nullable(),
  capturedAt: z.string().datetime(),
}).strict();
export type TaskConfiguration = z.infer<typeof TaskConfigurationSchema>;

export const TaskImageSchema = z.object({ artifactId: id, filename: z.string(), mimeType: z.string(), byteSize: z.number().int().nonnegative() }).strict();
const TaskQuestionBaseSchema = z.object({ id, text: z.string(), options: HumanQuestionOptionsSchema.default([]), requiresCommandCleanup: z.boolean() });
const TaskHumanQuestionSchema = z.discriminatedUnion("kind", [
  TaskQuestionBaseSchema.extend({ kind: z.literal("question") }).strict(),
  TaskQuestionBaseSchema.extend({ kind: z.literal("task_limit"), pause: TaskLimitPauseSchema }).strict(),
]);
export const TaskSchema = z.object({
  id, companyId: id, projectId: id,
  issueKey: z.string().nullable(),
  title: z.string(), description: z.string(),
  status: TaskControlStatusSchema,
  deliveryTarget: DeliveryTargetSchema,
  rootProfile: TaskProfileSchema,
  workerProfile: TaskProfileSchema,
  workflow: WorkflowIdSchema,
  advisorProfiles: z.partialRecord(AdvisorRoleSchema, TaskProfileSchema),
  workflowState: PublicWorkflowStateSchema,
  configuration: TaskConfigurationSchema,
  worktree: WorktreeReferenceSchema.nullable(),
  pullRequest: PullRequestReferenceSchema.nullable(),
  humanQuestion: TaskHumanQuestionSchema.nullable(),
  limits: TaskLimitsSchema.extend({ admittedTurns: z.number().int().nonnegative() }).strict(),
  wakeAt: z.string().nullable(),
  images: z.array(TaskImageSchema),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(),
}).strict();
export type Task = z.infer<typeof TaskSchema>;
