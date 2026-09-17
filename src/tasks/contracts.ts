import { z } from "zod";
import { ProjectProviderPolicySchema } from "../projects/provider-policy.js";
import { ProjectIntegrationSchema } from "../projects/integration-configuration.js";
import { ProjectExecutionSchema } from "../projects/execution-configuration.js";
import { IssueAssociationSchema } from "./issue-association.js";
import { HumanQuestionOptionsSchema } from "../coordination/human-question.js";
import { TaskControlStatusSchema, TaskProfileFieldsSchema, WorktreeReferenceSchema, PullRequestReferenceSchema } from "./control.js";
import { MAX_TASK_IMAGES, MAX_TASK_IMAGE_BASE64_LENGTH } from "./limits/attachment-limits.js";
import { AdvisorProfileIdsSchema, AdvisorRoleSchema, PublicWorkflowStateSchema, WorkflowIdSchema } from "../coordination/workflows.js";
import { TaskLimitPauseSchema, TaskLimitsSchema } from "./limits/limits.js";

const id = z.string().min(1).max(256);
/** bound: dependency fan-out per task */
export const MAX_TASK_DEPENDENCIES = 50;
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
  issue: IssueAssociationSchema.nullable().optional(),
  workflow: WorkflowIdSchema.default("standard"),
  advisorProfileIds: AdvisorProfileIdsSchema.default({}),
  dependsOn: z.array(id).max(MAX_TASK_DEPENDENCIES).default([]),
  blockedByTaskId: id.optional(),
}).strict();
export type TaskInput = z.input<typeof TaskInputSchema>;
export type TaskRequest = z.output<typeof TaskInputSchema>;

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
  source: TaskSourceInputSchema.nullable(),
  capturedAt: z.string().datetime(),
}).strict();
export type TaskConfiguration = z.infer<typeof TaskConfigurationSchema>;

export const TaskImageSchema = z.object({ artifactId: id, filename: z.string(), mimeType: z.string(), byteSize: z.number().int().nonnegative() }).strict();
export const TaskReferenceSchema = z.object({ id, title: z.string(), status: TaskControlStatusSchema }).strict();
const TaskQuestionBaseSchema = z.object({ id, text: z.string(), options: HumanQuestionOptionsSchema.default([]), requiresCommandCleanup: z.boolean() });
const TaskHumanQuestionSchema = z.discriminatedUnion("kind", [
  TaskQuestionBaseSchema.extend({ kind: z.literal("question") }).strict(),
  TaskQuestionBaseSchema.extend({ kind: z.literal("task_limit"), pause: TaskLimitPauseSchema }).strict(),
]);
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
  dependsOn: z.array(id).default([]),
  configuration: TaskConfigurationSchema,
  worktree: WorktreeReferenceSchema.nullable(),
  pullRequest: PullRequestReferenceSchema.nullable(),
  humanQuestion: TaskHumanQuestionSchema.nullable(),
  blockedBy: TaskReferenceSchema.nullable(),
  startWhenBlockedByDelivered: z.boolean().optional(),
  limits: TaskLimitsSchema.extend({ admittedTurns: z.number().int().nonnegative() }).strict(),
  wakeAt: z.string().nullable(),
  images: z.array(TaskImageSchema),
  artifacts: z.array(TaskImageSchema).optional(),
  createdAt: z.string(), updatedAt: z.string(), statusChangedAt: z.string(), archivedAt: z.string().nullable(),
}).strict();
export type Task = z.infer<typeof TaskSchema>;
