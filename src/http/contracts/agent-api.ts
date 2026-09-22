import { z } from "zod";
import { AdvisorProfileIdsSchema } from "../../coordination/workflows.js";
import { DeliveryTargetSchema, TaskImageInputSchema, TaskQueueSchema, TaskSourceInputSchema, VisualEvidenceSchema } from "../../tasks/contracts.js";
import { MAX_TASK_IMAGES } from "../../tasks/limits/attachment-limits.js";

export const AgentApiAdminAgentSchema = z.object({
  id: z.string(),
  kind: z.literal("external"),
  name: z.string(),
  avatarSeed: z.string(),
  companyId: z.string(),
  clientProfileId: z.string().nullable(),
  status: z.enum(["pending", "paired", "revoked"]),
  projectIds: z.array(z.string()),
  pairingExpiresAt: z.string().nullable(),
  pairedAt: z.string().nullable(),
  credentialCreatedAt: z.string().nullable(),
  connectionKind: z.enum(["oauth", "credential"]),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AgentApiAdminAgent = z.infer<typeof AgentApiAdminAgentSchema>;

export const AgentApiAgentListResponseSchema = z.object({
  agents: z.array(AgentApiAdminAgentSchema),
});

export const AgentApiAdminListQuerySchema = z.object({
  companyId: z.string().optional(),
});

export const AgentApiAdminCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  companyId: z.string().min(1).max(128),
  projectIds: z.array(z.string().min(1).max(128)).min(1),
  avatarSeed: z.string().max(128).optional(),
});

export const AgentApiAdminCreateResponseSchema = z.object({
  agent: AgentApiAdminAgentSchema,
  pairingCode: z.string(),
  expiresAt: z.string(),
});

export const AgentApiAdminAgentParamsSchema = z.object({
  agentId: z.string().min(1).max(128),
});

export const AgentApiAdminProjectsBodySchema = z.object({
  projectIds: z.array(z.string().min(1).max(128)),
});

export const AgentApiAdminProjectsResponseSchema = z.object({
  agent: AgentApiAdminAgentSchema,
});

export const AgentApiAdminPairingCodeResponseSchema = z.object({
  pairingCode: z.string(),
  expiresAt: z.string(),
});

export const AgentApiPublicAgentSchema = z.object({
  id: z.string(),
  kind: z.literal("external"),
  name: z.string(),
  avatarSeed: z.string(),
  companyId: z.string(),
  profileId: z.string().nullable(),
  status: z.enum(["pending", "paired", "revoked"]),
  projectIds: z.array(z.string()),
  pairedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AgentApiPublicAgent = z.infer<typeof AgentApiPublicAgentSchema>;

export const AgentApiPairingExchangeBodySchema = z.object({
  pairingCode: z.string(),
  profileId: z.string().trim().min(1).max(128).optional(),
});

export const AgentApiPairingExchangeResponseSchema = z.object({
  agent: AgentApiPublicAgentSchema,
  credential: z.string(),
});

const taskId = z.string().min(1).max(128);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
/** bound: dependency fan-out per task */
const MAX_DEPENDENCIES = 50;

export const AGENT_API_PREREQUISITE_SCOPE = "Each prerequisite must be a task this agent created.";
export const AGENT_API_TASK_COMMANDS = ["start_task", "disarm_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait"] as const;
export type AgentApiTaskCommand = typeof AGENT_API_TASK_COMMANDS[number];
const AGENT_API_DELIVERY_COMMANDS = ["observe_delivery", "request_delivery_repair", "decide_delivery_wait", "read_merge_train", "request_merge_approval", "merge_pull_request"] as const;
const AGENT_API_AUTONOMOUS_COMMANDS = ["create_backlog_task", "create_queued_task", ...AGENT_API_TASK_COMMANDS, ...AGENT_API_DELIVERY_COMMANDS] as const;
const AGENT_API_UNAVAILABLE_COMMANDS = ["answer_human_question", "deliver_task", "merge_pull_request"] as const;

export const AGENT_API_RUNTIME_AUTHORITY = "Human answers remain unavailable to paired agents. The runtime API exposes delivery and merge commands only when capabilities reports them. Forge can perform delivery for a task's configured target, including a merge after review, without an agent command.";
export const AGENT_API_MCP_AUTHORITY = "MCP exposes task lifecycle commands only. It does not expose runtime delivery or merge commands. Human answers remain unavailable to paired agents. Forge can perform delivery for a task's configured target, including a merge after review, without an agent command.";
export const AGENT_API_WHOAMI_DESCRIPTION = "taskCommands lists exactly the lifecycle commands accepted by forge_command_task. autonomousCommands also includes task creation and, when enabled, runtime delivery commands.";
export const AGENT_API_CAPABILITIES_DESCRIPTION = "autonomousCommands lists every command available through the runtime API. unavailableCommands lists commands this deployment does not accept. taskCommands from forge_whoami is the lifecycle subset exposed by forge_command_task.";

export const AgentApiTaskCreateBodySchema = z.object({
  projectId: z.string().min(1).max(128),
  title: z.string().trim().min(1),
  description: z.string().trim().optional().meta({ default: "" }),
  idempotencyKey: z.string().trim().min(1).max(128),
  dependsOn: z.array(taskId).max(MAX_DEPENDENCIES).optional().describe(`${AGENT_API_PREREQUISITE_SCOPE} Shown as Blocked by. A self-reference, a cycle, or an unavailable task is rejected.`),
  queue: z.boolean().optional().describe("Queue the task: it starts now when every prerequisite is complete, and otherwise starts by itself when the last one completes. Without it, the task stays in the manual backlog."),
  images: z.array(TaskImageInputSchema).max(MAX_TASK_IMAGES).default([]),
  source: TaskSourceInputSchema.optional(),
  workflowId: z.string().min(1).max(256).optional(),
  templateId: z.string().min(1).max(256).optional(),
  rootProfileId: z.string().min(1).max(256).optional(),
  workerProfileId: z.string().min(1).max(256).optional(),
  advisorProfileIds: AdvisorProfileIdsSchema.default({}),
  deliveryTarget: DeliveryTargetSchema.optional(),
  runProjectTests: z.boolean().optional(),
  visualEvidence: VisualEvidenceSchema.optional(),
  dryRun: z.literal(true).optional().describe("Validate the request and return its projected result without creating a task or writing any state."),
}).passthrough().refine(input => !(input.workflowId && input.templateId), { message: "Select either a workflow or a template" });
export type AgentApiTaskCreateBody = z.infer<typeof AgentApiTaskCreateBodySchema>;

export const AgentApiTaskDependenciesBodySchema = z.object({
  dependsOn: z.array(taskId).max(MAX_DEPENDENCIES).describe(`${AGENT_API_PREREQUISITE_SCOPE} The complete set replaces the current set; an empty array removes every prerequisite.`),
  dryRun: z.literal(true).optional().describe("Validate the replacement and return its projected start state without changing dependencies or queue state."),
}).strict();

export const AgentApiTaskIdParamsSchema = z.object({
  // Fastify's default router rejects longer parameters before the request reaches this schema.
  taskId: z.string().min(1).max(100),
});

const AgentApiTaskStatusSchema = z.enum(["backlog", "active", "waiting_human", "cancelled", "delivered"]);

export const AgentApiIntegrationSchema = z.object({
  integrated: z.boolean(),
  pullRequest: z.object({
    state: z.enum(["absent", "open", "draft", "ready", "conflicting", "merged", "closed"]),
    number: z.number().int().min(1).nullable(),
    url: z.string().nullable(),
    targetBranch: z.string(),
    headSha: z.string().nullable(),
    baseSha: z.string().nullable(),
    mergeable: z.string().nullable(),
    mergeStateStatus: z.string().nullable(),
    reviewDecision: z.string().nullable(),
    checks: z.object({ total: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), failing: z.number().int().nonnegative(), successful: z.number().int().nonnegative() }).strict(),
  }).strict(),
  observedAt: z.string(),
  observation: z.enum(["observed", "unavailable"]),
  observationReason: z.string().nullable(),
  deployed: z.object({ included: z.boolean().nullable(), reason: z.string() }).strict(),
}).strict();

export const AgentApiActionReasonCodeSchema = z.enum([
  "conflicting_pull_request", "failed_checks", "pending_checks", "pending_review", "stale_delivery",
  "pull_request_missing", "blocked_by_dependency", "waiting_human", "observation_unavailable",
]);

export const AgentApiActionRequiredSchema = z.object({
  owner: z.enum(["agent", "task_owner", "human", "forge", "upstream"]),
  reasonCode: AgentApiActionReasonCodeSchema,
  summary: z.string(),
  upstream: z.object({ taskId: z.string(), pullRequestNumber: z.number().int().min(1).nullable() }).strict().nullable(),
  evidenceAt: z.string(),
  suggestedCommands: z.array(z.string()),
  humanApprovalRequired: z.boolean(),
}).strict();
export const AgentApiTaskCommandSchema = z.enum(AGENT_API_TASK_COMMANDS);
export const AgentApiTaskCommandBodySchema = z.object({
  command: AgentApiTaskCommandSchema,
  revision: z.string().min(1).max(256),
  idempotencyKey: z.string().trim().min(1).max(128),
  note: z.string().trim().min(1).optional(),
}).strict().superRefine((input, context) => {
  if (input.command === "send_task_note" && !input.note) context.addIssue({ code: "custom", path: ["note"], message: "A note is required" });
  if (input.command !== "send_task_note" && input.note !== undefined) context.addIssue({ code: "custom", path: ["note"], message: "Notes are only accepted by send_task_note" });
});

export const AgentApiProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** Identity adds the create-time policy so an agent can see what a project permits before it asks for it. */
export const AgentApiIdentityProjectSchema = AgentApiProjectSchema.extend({
  agentTaskPolicy: z.object({
    deliveryTargets: z.array(DeliveryTargetSchema),
    runProjectTests: z.boolean(),
    visualEvidence: VisualEvidenceSchema,
  }),
});

export const AgentApiIdentityResponseSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    profileId: z.string().nullable(),
  }),
  capabilities: z.object({
    taskDiscovery: z.literal(true),
    taskRead: z.literal(true),
    taskCreate: z.literal(true),
    taskCommands: z.array(AgentApiTaskCommandSchema).describe(AGENT_API_WHOAMI_DESCRIPTION),
  }),
  projects: z.array(AgentApiIdentityProjectSchema),
});

export const AgentApiTaskFilterSchema = z.enum(["stale_delivery", "conflicting_pull_request", "failed_checks", "pending_review", "blocked_by_dependency", "not_integrated"]);

const AgentApiTaskSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), number: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("branch"), branch: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("pull_request"), number: z.number().int().min(1) }).strict(),
]);

export const AgentApiTaskListQuerySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  status: z.enum(["backlog", "active", "waiting_human", "cancelled", "delivered"]).optional(),
  pullRequestNumber: z.coerce.number().int().positive().optional(),
  sourceBranch: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional(),
  attention: z.enum(["true", "false"]).optional(),
  blocker: z.enum(["true", "false"]).optional(),
  updatedSince: z.string().datetime().optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  filter: AgentApiTaskFilterSchema.optional(),
  view: z.enum(["summary", "full"]).optional(),
}).strict();

export const AgentApiProjectDiscoveryQuerySchema = z.object({
  projectId: z.string().min(1).max(128),
}).strict();

export const AgentApiWorkflowDiscoverySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  permittedForAgentTaskCreation: z.boolean(),
});

export const AgentApiWorkflowDiscoveryResponseSchema = z.object({
  workflows: z.array(AgentApiWorkflowDiscoverySchema),
});

export const AgentApiTemplateDiscoverySchema = AgentApiWorkflowDiscoverySchema;

export const AgentApiTemplateDiscoveryResponseSchema = z.object({
  templates: z.array(AgentApiTemplateDiscoverySchema),
});

export const AgentApiTaskDeliverySchema = z.object({
  pullRequest: z.object({
    number: z.number().int().min(1),
    url: z.string().url(),
    state: z.string(),
    mergedAt: z.string().nullable(),
  }).nullable(),
  checks: z.null(),
  waiting: z.object({
    reason: z.enum(["checks", "mergeability", "merge_queue", "observation"]),
    since: z.string(),
  }).nullable(),
  completion: z.object({
    kind: z.enum(["workflow", "external_merge"]),
    pullRequestNumber: z.number().int().min(1).nullable(),
    observedAt: z.string(),
  }).nullable(),
}).nullable();

export const AgentApiSafeTaskProjectionSchema = z.object({
  id: z.string(),
  issueKey: z.string().nullable(),
  projectId: z.string(),
  project: AgentApiProjectSchema,
  title: z.string(),
  source: z.union([AgentApiTaskSourceSchema, z.null()]),
  status: AgentApiTaskStatusSchema,
  queue: TaskQueueSchema.describe("startIntent is manual or queued. state separates backlog (manual), queued (waits to start by itself), running, needs_attention, delivered, and cancelled. waitingOn lists each incomplete prerequisite with its exact reason."),
  dependsOn: z.array(z.string()).describe("The ids of blockedBy, in the same order."),
  blockedBy: z.array(z.object({ id: z.string(), title: z.string(), status: AgentApiTaskStatusSchema }).strict()).describe("The prerequisite tasks of this task with their current title and status."),
  archived: z.boolean(),
  revision: z.string(),
  permittedCommands: z.array(AgentApiTaskCommandSchema),
  humanQuestion: z.string().nullable(),
  blocker: z.object({
    kind: z.enum(["human_question", "delivery_wait"]),
    reason: z.enum(["checks", "mergeability", "merge_queue", "observation"]).optional(),
  }).nullable(),
  workflowStage: z.string(),
  workflow: z.object({ id: z.string().nullable(), engine: z.string(), name: z.string().nullable() }).strict(),
  templateId: z.string().nullable(),
  deliveryTarget: DeliveryTargetSchema,
  runProjectTests: z.boolean(),
  visualEvidence: VisualEvidenceSchema,
  delivery: AgentApiTaskDeliverySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Read paths add observed delivery integration health. Command replies stay on stored task state, which needs no GitHub read. */
export const AgentApiTaskReadProjectionSchema = AgentApiSafeTaskProjectionSchema.extend({
  implementation: z.object({ status: AgentApiTaskStatusSchema }).strict(),
  integration: AgentApiIntegrationSchema,
  actionRequired: AgentApiActionRequiredSchema.nullable(),
});

const AgentApiDryRunStartSchema = z.object({
  wouldStart: z.enum(["now", "waiting", "backlog"]),
  blockingPrerequisiteIds: z.array(z.string()),
}).strict();

export const AgentApiTaskCreateDryRunResponseSchema = z.union([
  z.object({
    dryRun: z.literal(true),
    projectId: z.string(),
    project: AgentApiProjectSchema,
    title: z.string(),
    workflow: z.object({ id: z.string().nullable(), engine: z.string(), name: z.string().nullable() }).strict(),
    templateId: z.string().nullable(),
    deliveryTarget: DeliveryTargetSchema,
    branch: z.string(),
    dependsOn: z.array(z.string()),
  }).extend(AgentApiDryRunStartSchema.shape).strict(),
  z.object({ dryRun: z.literal(true), status: z.literal(200), existingTaskId: z.string() }).strict(),
]);

export const AgentApiTaskDependenciesDryRunResponseSchema = z.object({
  dryRun: z.literal(true),
  dependsOn: z.array(z.string()),
}).extend(AgentApiDryRunStartSchema.shape).strict();

export type AgentApiIntegration = z.infer<typeof AgentApiIntegrationSchema>;
export type AgentApiActionRequired = z.infer<typeof AgentApiActionRequiredSchema>;
export type AgentApiTaskFilter = z.infer<typeof AgentApiTaskFilterSchema>;
export type AgentApiSafeTaskProjection = z.infer<typeof AgentApiSafeTaskProjectionSchema>;

export const AgentApiTaskSummaryProjectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: AgentApiTaskStatusSchema,
  archived: z.boolean(),
  queue: TaskQueueSchema.shape.state,
  workflow: z.string().optional(),
  source: AgentApiTaskSourceSchema.optional(),
  pullRequestNumber: z.number().int().min(1).optional(),
  dependsOn: z.array(z.string()),
  updatedAt: z.string(),
}).strict();
export type AgentApiTaskSummaryProjection = z.infer<typeof AgentApiTaskSummaryProjectionSchema>;

const AgentApiChecksSchema = z.object({
  total: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  failing: z.number().int().nonnegative(), successful: z.number().int().nonnegative(),
  runs: z.array(z.object({ name: z.string(), status: z.enum(["pending", "failing", "successful"]), url: z.string().nullable(), conclusion: z.string().optional() })),
});

export const AgentApiPullRequestObservationSchema = z.object({
  exists: z.boolean(),
  number: z.number().int().nullable(),
  url: z.string().nullable(),
  state: z.enum(["open", "closed", "merged"]).nullable(),
  isDraft: z.boolean().nullable(),
  headSha: z.string().nullable(),
  baseSha: z.string().nullable(),
  mergeable: z.string().nullable(),
  mergeStateStatus: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  checks: AgentApiChecksSchema,
});

export const AgentApiDeliveryRefreshResponseSchema = z.object({
  taskId: z.string(),
  pullRequest: z.object({ repository: z.string(), number: z.number().int(), url: z.string(), headSha: z.string(), state: z.string(), mergedAt: z.string().nullable() }).nullable(),
  observation: AgentApiPullRequestObservationSchema.nullable(),
});

export const AgentApiDeliveryRepairResponseSchema = z.object({
  taskId: z.string(),
  attemptId: z.string(),
  observation: AgentApiPullRequestObservationSchema,
});

export const AgentApiDeliveryDecisionBodySchema = z.object({
  decision: z.enum(["wait_for_dependency", "resume"]),
}).strict();

export const AgentApiDeliveryDecisionResponseSchema = z.object({
  taskId: z.string(),
  decision: z.enum(["wait_for_dependency", "resume"]),
  blockingTaskIds: z.array(z.string()),
});

export const AgentApiMergeTrainQuerySchema = z.object({ projectId: z.string().min(1).max(128).optional() });

export const AgentApiMergeTrainResponseSchema = z.object({
  entries: z.array(z.object({
    taskId: z.string(),
    title: z.string(),
    status: z.string(),
    dependsOn: z.array(z.string()),
    pullRequestNumber: z.number().int().nullable(),
    headSha: z.string().nullable(),
    baseSha: z.string().nullable(),
    isDraft: z.boolean().nullable(),
    reviewDecision: z.string().nullable(),
    checks: z.object({ total: z.number().int(), pending: z.number().int(), failing: z.number().int(), successful: z.number().int() }),
    blocker: z.string().nullable(),
  })),
});

export const AgentApiMergeApprovalBodySchema = z.object({
  pullRequestNumber: z.number().int().positive(),
  headSha: sha,
  baseSha: sha,
}).strict();

export const AgentApiMergeApprovalResponseSchema = z.object({
  taskId: z.string(),
  receipt: z.string(),
  expiresAt: z.string(),
  pullRequestNumber: z.number().int(),
  headSha: z.string().nullable(),
  baseSha: z.string().nullable(),
});

export const AgentApiMergeBodySchema = z.object({
  pullRequestNumber: z.number().int().positive(),
  expectedHeadSha: sha,
  expectedBaseSha: sha,
  approvalReceipt: z.string().min(1).max(128),
}).strict();

export const AgentApiMergeResponseSchema = z.object({
  taskId: z.string(),
  pullRequestNumber: z.number().int(),
  result: z.unknown(),
});

export const AgentApiProvenanceResponseSchema = z.object({
  records: z.array(z.object({
    id: z.string(),
    attemptId: z.string().nullable(),
    kind: z.string(),
    pullRequestNumber: z.number().int().nullable(),
    originalHeadSha: z.string().nullable(),
    headSha: z.string().nullable(),
    baseSha: z.string().nullable(),
    checks: z.unknown().nullable(),
    merge: z.unknown().nullable(),
    recordedAt: z.string(),
  })),
});
export type AgentApiTaskReadProjection = z.infer<typeof AgentApiTaskReadProjectionSchema>;

export const AgentApiTaskListResponseSchema = z.object({
  tasks: z.array(z.union([AgentApiTaskReadProjectionSchema, AgentApiTaskSummaryProjectionSchema])),
  nextCursor: z.string().nullable(),
});

export const AgentApiRuntimeErrorSchema = z.object({
  error: z.string(),
  code: z.enum(["credential_invalid", "not_found", "resource_not_found", "idempotency_conflict", "command_in_progress", "revision_stale", "illegal_command", "request_invalid", "delivery_policy_rejected", "project_not_found", "dependency_not_found", "dependency_not_permitted", "root_profile_not_found", "root_profile_not_permitted", "worker_profile_not_found", "worker_profile_not_permitted", "advisor_profile_not_found", "advisor_profile_not_permitted", "source_issue_rejected", "source_pull_request_rejected", "source_branch_rejected", "workflow_not_found", "workflow_not_permitted", "template_not_found", "template_not_permitted", "task_unavailable", "payload_too_large", "unsupported_media_type", "internal_error"]),
  field: z.string().optional(),
  value: z.string().optional(),
  reason: z.string().optional(),
  findings: z.array(z.object({ code: z.string(), field: z.string(), message: z.string() })).optional(),
  permittedWorkflowIds: z.array(z.string()).optional(),
  permittedTemplateIds: z.array(z.string()).optional(),
});

const runtimeError = <T extends z.infer<typeof AgentApiRuntimeErrorSchema>["code"]>(code: T) => AgentApiRuntimeErrorSchema.extend({ code: z.literal(code) });

const AgentApiRuntimeErrorResponses = {
  requestInvalid: runtimeError("request_invalid"),
  credentialInvalid: runtimeError("credential_invalid"),
  notFound: runtimeError("not_found"),
  resourceNotFound: runtimeError("resource_not_found"),
  idempotencyConflict: runtimeError("idempotency_conflict"),
  commandInProgress: runtimeError("command_in_progress"),
  revisionStale: runtimeError("revision_stale"),
  illegalCommand: runtimeError("illegal_command"),
  deliveryPolicyRejected: runtimeError("delivery_policy_rejected"),
  projectNotFound: runtimeError("project_not_found").extend({ field: z.literal("projectId"), value: z.string(), reason: z.string() }),
  dependencyNotFound: runtimeError("dependency_not_found").extend({ field: z.literal("dependsOn"), value: z.string(), reason: z.string() }),
  dependencyNotPermitted: runtimeError("dependency_not_permitted").extend({ field: z.literal("dependsOn"), value: z.string(), reason: z.string() }),
  rootProfileNotFound: runtimeError("root_profile_not_found").extend({ field: z.literal("rootProfileId"), value: z.string(), reason: z.string() }),
  rootProfileNotPermitted: runtimeError("root_profile_not_permitted").extend({ field: z.literal("rootProfileId"), value: z.string(), reason: z.string() }),
  workerProfileNotFound: runtimeError("worker_profile_not_found").extend({ field: z.literal("workerProfileId"), value: z.string(), reason: z.string() }),
  workerProfileNotPermitted: runtimeError("worker_profile_not_permitted").extend({ field: z.literal("workerProfileId"), value: z.string(), reason: z.string() }),
  advisorProfileNotFound: runtimeError("advisor_profile_not_found").extend({ field: z.string(), value: z.string(), reason: z.string() }),
  advisorProfileNotPermitted: runtimeError("advisor_profile_not_permitted").extend({ field: z.string(), value: z.string(), reason: z.string() }),
  sourceIssueRejected: runtimeError("source_issue_rejected").extend({ field: z.literal("source.issue"), value: z.string(), reason: z.string() }),
  sourcePullRequestRejected: runtimeError("source_pull_request_rejected").extend({ field: z.literal("source.pullRequest"), value: z.string(), reason: z.string() }),
  sourceBranchRejected: runtimeError("source_branch_rejected").extend({ field: z.literal("source.branch"), value: z.string(), reason: z.string() }),
  workflowNotFound: runtimeError("workflow_not_found").extend({ field: z.literal("workflowId"), value: z.string(), reason: z.string(), permittedWorkflowIds: z.array(z.string()) }),
  workflowNotPermitted: runtimeError("workflow_not_permitted").extend({ field: z.literal("workflowId"), value: z.string(), reason: z.string(), permittedWorkflowIds: z.array(z.string()) }),
  templateNotFound: runtimeError("template_not_found").extend({ field: z.literal("templateId"), value: z.string(), reason: z.string(), permittedTemplateIds: z.array(z.string()) }),
  templateNotPermitted: runtimeError("template_not_permitted").extend({ field: z.literal("templateId"), value: z.string(), reason: z.string(), permittedTemplateIds: z.array(z.string()) }),
  taskUnavailable: runtimeError("task_unavailable"),
  payloadTooLarge: runtimeError("payload_too_large"),
  unsupportedMediaType: runtimeError("unsupported_media_type"),
  internal: runtimeError("internal_error"),
} as const;

export const AgentApiCapabilitiesSchema = z.object({
  apiVersion: z.literal("v1"),
  capabilities: z.object({
    read: z.object({ task: z.literal(true), workflows: z.literal(true), templates: z.literal(true) }),
    create: z.object({ backlogTask: z.literal(true), queuedTask: z.literal(true), deliveryTargets: z.array(DeliveryTargetSchema) }),
    taskControl: z.literal(true),
    // Delivery and merge follow the configured agent delivery surface, which a deployment can leave off.
    delivery: z.boolean(),
    merge: z.boolean(),
    humanDecisions: z.literal(false),
  }),
  autonomousCommands: z.array(z.enum(AGENT_API_AUTONOMOUS_COMMANDS)).describe(AGENT_API_CAPABILITIES_DESCRIPTION),
  humanOnlyRecords: z.array(z.literal("task_human_answer")),
  unavailableCommands: z.array(z.enum(AGENT_API_UNAVAILABLE_COMMANDS)),
  pagination: z.object({ supported: z.literal(true), cursor: z.literal(true) }),
});

export function agentApiCapabilities(agentDelivery: boolean): z.infer<typeof AgentApiCapabilitiesSchema> {
  return {
    apiVersion: "v1",
    capabilities: { read: { task: true, workflows: true, templates: true }, create: { backlogTask: true, queuedTask: true, deliveryTargets: DeliveryTargetSchema.options }, taskControl: true, delivery: agentDelivery, merge: agentDelivery, humanDecisions: false },
    autonomousCommands: [
      "create_backlog_task", "create_queued_task", ...AGENT_API_TASK_COMMANDS,
      ...(agentDelivery ? AGENT_API_DELIVERY_COMMANDS : []),
    ],
    humanOnlyRecords: ["task_human_answer"],
    unavailableCommands: agentDelivery ? AGENT_API_UNAVAILABLE_COMMANDS.filter(command => command !== "merge_pull_request") : [...AGENT_API_UNAVAILABLE_COMMANDS],
    pagination: { supported: true, cursor: true },
  };
}

export const AgentApiRuntimeOperations = {
  openApi: {
    response: { 200: z.record(z.string(), z.unknown()), 401: AgentApiRuntimeErrorResponses.credentialInvalid, 500: AgentApiRuntimeErrorResponses.internal },
  },
  capabilities: {
    response: { 200: AgentApiCapabilitiesSchema, 401: AgentApiRuntimeErrorResponses.credentialInvalid, 500: AgentApiRuntimeErrorResponses.internal },
  },
  workflows: {
    querystring: AgentApiProjectDiscoveryQuerySchema,
    response: { 200: AgentApiWorkflowDiscoveryResponseSchema, 401: AgentApiRuntimeErrorResponses.credentialInvalid, 404: AgentApiRuntimeErrorResponses.notFound, 500: AgentApiRuntimeErrorResponses.internal },
  },
  templates: {
    querystring: AgentApiProjectDiscoveryQuerySchema,
    response: { 200: AgentApiTemplateDiscoveryResponseSchema, 401: AgentApiRuntimeErrorResponses.credentialInvalid, 404: AgentApiRuntimeErrorResponses.notFound, 500: AgentApiRuntimeErrorResponses.internal },
  },
  createTask: {
    body: AgentApiTaskCreateBodySchema,
    response: {
      200: z.union([AgentApiTaskReadProjectionSchema, AgentApiTaskCreateDryRunResponseSchema]),
      201: AgentApiTaskReadProjectionSchema,
      400: AgentApiRuntimeErrorResponses.requestInvalid,
      401: AgentApiRuntimeErrorResponses.credentialInvalid,
      404: z.union([AgentApiRuntimeErrorResponses.notFound, AgentApiRuntimeErrorResponses.resourceNotFound]),
      409: z.union([AgentApiRuntimeErrorResponses.idempotencyConflict, AgentApiRuntimeErrorResponses.taskUnavailable]),
      413: AgentApiRuntimeErrorResponses.payloadTooLarge,
      415: AgentApiRuntimeErrorResponses.unsupportedMediaType,
      422: z.union([AgentApiRuntimeErrorResponses.deliveryPolicyRejected, AgentApiRuntimeErrorResponses.projectNotFound, AgentApiRuntimeErrorResponses.dependencyNotFound, AgentApiRuntimeErrorResponses.dependencyNotPermitted, AgentApiRuntimeErrorResponses.rootProfileNotFound, AgentApiRuntimeErrorResponses.rootProfileNotPermitted, AgentApiRuntimeErrorResponses.workerProfileNotFound, AgentApiRuntimeErrorResponses.workerProfileNotPermitted, AgentApiRuntimeErrorResponses.advisorProfileNotFound, AgentApiRuntimeErrorResponses.advisorProfileNotPermitted, AgentApiRuntimeErrorResponses.sourceIssueRejected, AgentApiRuntimeErrorResponses.sourcePullRequestRejected, AgentApiRuntimeErrorResponses.sourceBranchRejected, AgentApiRuntimeErrorResponses.workflowNotFound, AgentApiRuntimeErrorResponses.workflowNotPermitted, AgentApiRuntimeErrorResponses.templateNotFound, AgentApiRuntimeErrorResponses.templateNotPermitted, AgentApiRuntimeErrorResponses.taskUnavailable]),
      500: AgentApiRuntimeErrorResponses.internal,
    },
  },
  getTask: {
    params: AgentApiTaskIdParamsSchema,
    response: { 200: AgentApiTaskReadProjectionSchema, 400: AgentApiRuntimeErrorResponses.requestInvalid, 401: AgentApiRuntimeErrorResponses.credentialInvalid, 404: z.union([AgentApiRuntimeErrorResponses.notFound, AgentApiRuntimeErrorResponses.resourceNotFound]), 500: AgentApiRuntimeErrorResponses.internal },
  },
  setTaskDependencies: {
    params: AgentApiTaskIdParamsSchema,
    body: AgentApiTaskDependenciesBodySchema,
    response: { 200: z.union([AgentApiSafeTaskProjectionSchema, AgentApiTaskDependenciesDryRunResponseSchema]), 400: AgentApiRuntimeErrorResponses.requestInvalid, 401: AgentApiRuntimeErrorResponses.credentialInvalid, 404: z.union([AgentApiRuntimeErrorResponses.notFound, AgentApiRuntimeErrorResponses.resourceNotFound]), 422: z.union([AgentApiRuntimeErrorResponses.dependencyNotFound, AgentApiRuntimeErrorResponses.dependencyNotPermitted, AgentApiRuntimeErrorResponses.taskUnavailable]), 500: AgentApiRuntimeErrorResponses.internal },
  },
  commandTask: {
    params: AgentApiTaskIdParamsSchema,
    body: AgentApiTaskCommandBodySchema,
    response: { 200: AgentApiSafeTaskProjectionSchema, 400: AgentApiRuntimeErrorResponses.requestInvalid, 401: AgentApiRuntimeErrorResponses.credentialInvalid, 404: z.union([AgentApiRuntimeErrorResponses.notFound, AgentApiRuntimeErrorResponses.resourceNotFound]), 409: z.union([AgentApiRuntimeErrorResponses.idempotencyConflict, AgentApiRuntimeErrorResponses.commandInProgress, AgentApiRuntimeErrorResponses.illegalCommand, AgentApiRuntimeErrorResponses.taskUnavailable]), 412: AgentApiRuntimeErrorResponses.revisionStale, 500: AgentApiRuntimeErrorResponses.internal },
  },
} as const;

const jsonSchema = (schema: z.ZodType, io: "input" | "output"): Record<string, unknown> => z.toJSONSchema(schema, { target: "openapi-3.0", io }) as Record<string, unknown>;
const inputSchema = (schema: z.ZodType): Record<string, unknown> => {
  const result = jsonSchema(schema, "input");
  // Zod strips unknown object keys by default; OpenAPI expresses that accepted input accurately.
  if (result.type === "object") result.additionalProperties = true;
  return result;
};
const responseDescription = (status: string): string => status.startsWith("2") ? "Successful response" : "Safe error response";
const openApiResponses = (responses: Record<number, z.ZodType>): Record<string, unknown> => Object.fromEntries(Object.entries(responses).map(([status, schema]) => [status, {
  description: responseDescription(status),
  content: { "application/json": { schema: jsonSchema(schema, "output") } },
}]));

/** The authenticated runtime contract deliberately excludes pairing and administration. */
export function agentApiRuntimeOpenApi(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Forge AgentApi Runtime API",
      version: "v1",
      description: "Version v1 is additive-only within a major version. Pairing, credential rotation, and administration are separate provisioning APIs and are not part of this contract. Company, project grants, and creator ownership come from current server persistence, never request fields. Reads cover every task in the agent's currently granted projects. Commands, dependency writes, and delivery operations remain creator-only. Denied company, grant, and missing-resource reads are all non-enumerating 404 responses.",
    },
    paths: {
      "/api/agent/openapi.json": {
        get: {
          operationId: "getAgentApiRuntimeOpenApi",
          summary: "Read this authenticated runtime contract",
          security: [{ AgentApiBearer: [] }],
          responses: openApiResponses(AgentApiRuntimeOperations.openApi.response),
        },
      },
      "/api/agent/capabilities": {
        get: {
          operationId: "getAgentApiCapabilities",
          summary: "Read paired-agent capabilities and unavailable commands",
          security: [{ AgentApiBearer: [] }],
          responses: openApiResponses(AgentApiRuntimeOperations.capabilities.response),
        },
      },
      "/api/agent/workflows": {
        get: { operationId: "listAgentApiWorkflows", summary: "List workflows available to a project", security: [{ AgentApiBearer: [] }], parameters: [{ name: "projectId", in: "query", required: true, schema: jsonSchema(AgentApiRuntimeOperations.workflows.querystring.shape.projectId, "input") }], responses: openApiResponses(AgentApiRuntimeOperations.workflows.response) },
      },
      "/api/agent/templates": {
        get: { operationId: "listAgentApiTemplates", summary: "List templates available to a project", security: [{ AgentApiBearer: [] }], parameters: [{ name: "projectId", in: "query", required: true, schema: jsonSchema(AgentApiRuntimeOperations.templates.querystring.shape.projectId, "input") }], responses: openApiResponses(AgentApiRuntimeOperations.templates.response) },
      },
      "/api/agent/tasks": {
        post: {
          operationId: "createAgentApiBacklogTask",
          summary: "Create a backlog or queued task",
          description: `Creates a backlog task. With queue true, the task is queued: it starts now when every prerequisite is complete, and otherwise stays in the backlog with zero sessions until the last prerequisite completes. Without queue, it never starts by itself. dryRun true validates the same request and returns its projection without writing a task, dependency, receipt, artifact, queue state, or audit event. The server defaults description to an empty string and rejects unknown fields with request_invalid. dependsOn sets the prerequisites, shown as Blocked by. ${AGENT_API_PREREQUISITE_SCOPE} Idempotency is scoped to the paired agent and company. An identical replay returns 200; reuse for a different request returns 409 with idempotency_conflict. GET /api/agent/tasks supports opaque cursors and returns nextCursor.`,
          security: [{ AgentApiBearer: [] }],
          requestBody: { required: true, content: { "application/json": { schema: inputSchema(AgentApiRuntimeOperations.createTask.body) } } },
          responses: openApiResponses(AgentApiRuntimeOperations.createTask.response),
        },
      },
      "/api/agent/tasks/{taskId}": {
        get: {
          operationId: "getAgentApiCreatedTask",
          summary: "Read a task in a granted project",
          description: "A paired agent can read every task in its currently granted company projects. A task created by another actor reports permittedCommands as an empty array. Task states are backlog, active, waiting_human, cancelled, and delivered. queue separates a manual backlog task from a queued one and lists the exact wait reason of each incomplete prerequisite. A prerequisite is complete when it is delivered at its own delivery target; the merged target also needs the merged pull request state Forge observed from GitHub. Human questions are records only: answering them remains human authority and no agent answer command exists. The server router rejects path parameters longer than 100 characters before this authenticated operation is matched; those router-level responses are outside this contract.",
          security: [{ AgentApiBearer: [] }],
          parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(AgentApiRuntimeOperations.getTask.params.shape.taskId, "input") }],
          responses: openApiResponses(AgentApiRuntimeOperations.getTask.response),
        },
      },
      "/api/agent/tasks/{taskId}/dependencies": {
        put: { operationId: "setAgentApiTaskDependencies", summary: "Replace the prerequisites of a task", description: `Replaces dependsOn, shown as Blocked by, with the complete set in the body. ${AGENT_API_PREREQUISITE_SCOPE} dryRun true validates the replacement and reports the projected prerequisites and start state without changing dependencies, queue state, or audits. A self-reference, a cycle, or an unavailable task is rejected and the current set stays. Unknown fields are rejected. The response and every later read report dependsOn and blockedBy from the same stored edges.`, security: [{ AgentApiBearer: [] }], parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(AgentApiRuntimeOperations.setTaskDependencies.params.shape.taskId, "input") }], requestBody: { required: true, content: { "application/json": { schema: jsonSchema(AgentApiRuntimeOperations.setTaskDependencies.body, "input") } } }, responses: openApiResponses(AgentApiRuntimeOperations.setTaskDependencies.response) },
      },
      "/api/agent/tasks/{taskId}/commands": {
        post: { operationId: "commandAgentApiTask", summary: "Apply an authorized task lifecycle command", description: `Only the paired agent that created the task can send a command. Every command requires the current task revision and an idempotency key. start_task queues a manual backlog task: it starts now when every prerequisite is complete and never bypasses one. disarm_task returns a queued task to the manual backlog. ${AGENT_API_WHOAMI_DESCRIPTION} ${AGENT_API_RUNTIME_AUTHORITY}`, security: [{ AgentApiBearer: [] }], parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(AgentApiRuntimeOperations.commandTask.params.shape.taskId, "input") }], requestBody: { required: true, content: { "application/json": { schema: inputSchema(AgentApiRuntimeOperations.commandTask.body) } } }, responses: openApiResponses(AgentApiRuntimeOperations.commandTask.response) },
      },
    },
    components: {
      securitySchemes: { AgentApiBearer: { type: "http", scheme: "bearer", bearerFormat: "AgentApi paired-agent credential" } },
    },
  };
}
