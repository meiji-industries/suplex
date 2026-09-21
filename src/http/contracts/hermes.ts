import { z } from "zod";
import { AdvisorProfileIdsSchema } from "../../coordination/workflows.js";
import { DeliveryTargetSchema, TaskImageInputSchema, TaskQueueSchema, TaskSourceInputSchema, VisualEvidenceSchema } from "../../tasks/contracts.js";
import { MAX_TASK_IMAGES } from "../../tasks/limits/attachment-limits.js";

export const HermesAdminAgentSchema = z.object({
  id: z.string(),
  kind: z.literal("hermes"),
  name: z.string(),
  avatarSeed: z.string(),
  companyId: z.string(),
  hermesProfileId: z.string().nullable(),
  status: z.enum(["pending", "paired", "revoked"]),
  projectIds: z.array(z.string()),
  pairingExpiresAt: z.string().nullable(),
  pairedAt: z.string().nullable(),
  credentialCreatedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type HermesAdminAgent = z.infer<typeof HermesAdminAgentSchema>;

export const HermesAgentListResponseSchema = z.object({
  agents: z.array(HermesAdminAgentSchema),
});

export const HermesAdminListQuerySchema = z.object({
  companyId: z.string().optional(),
});

export const HermesAdminCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  companyId: z.string().min(1).max(128),
  projectIds: z.array(z.string().min(1).max(128)).min(1),
  avatarSeed: z.string().max(128).optional(),
});

export const HermesAdminCreateResponseSchema = z.object({
  agent: HermesAdminAgentSchema,
  pairingCode: z.string(),
  expiresAt: z.string(),
});

export const HermesAdminAgentParamsSchema = z.object({
  agentId: z.string().min(1).max(128),
});

export const HermesAdminProjectsBodySchema = z.object({
  projectIds: z.array(z.string().min(1).max(128)),
});

export const HermesAdminProjectsResponseSchema = z.object({
  agent: HermesAdminAgentSchema,
});

export const HermesAdminPairingCodeResponseSchema = z.object({
  pairingCode: z.string(),
  expiresAt: z.string(),
});

export const HermesPublicAgentSchema = z.object({
  id: z.string(),
  kind: z.literal("hermes"),
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

export type HermesPublicAgent = z.infer<typeof HermesPublicAgentSchema>;

export const HermesPairingExchangeBodySchema = z.object({
  pairingCode: z.string(),
  profileId: z.string().trim().min(1).max(128),
});

export const HermesPairingExchangeResponseSchema = z.object({
  agent: HermesPublicAgentSchema,
  credential: z.string(),
});

const taskId = z.string().min(1).max(128);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
/** bound: dependency fan-out per task */
const MAX_DEPENDENCIES = 50;

export const HermesTaskCreateBodySchema = z.object({
  projectId: z.string().min(1).max(128),
  title: z.string().trim().min(1),
  description: z.string().trim().optional().meta({ default: "" }),
  idempotencyKey: z.string().trim().min(1).max(128),
  dependsOn: z.array(taskId).max(MAX_DEPENDENCIES).optional().describe("Prerequisite task ids in this company, shown as Blocked by. A self-reference, a cycle, or an unavailable task is rejected."),
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
}).passthrough().refine(input => !(input.workflowId && input.templateId), { message: "Select either a workflow or a template" });
export type HermesTaskCreateBody = z.infer<typeof HermesTaskCreateBodySchema>;

export const HermesTaskDependenciesBodySchema = z.object({
  dependsOn: z.array(taskId).max(MAX_DEPENDENCIES).describe("The complete prerequisite set. It replaces the current set; an empty array removes every prerequisite."),
}).strict();

export const HermesTaskIdParamsSchema = z.object({
  // Fastify's default router rejects longer parameters before the request reaches this schema.
  taskId: z.string().min(1).max(100),
});

const HermesTaskStatusSchema = z.enum(["backlog", "active", "waiting_human", "cancelled", "delivered"]);

export const HermesIntegrationSchema = z.object({
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

export const HermesActionReasonCodeSchema = z.enum([
  "conflicting_pull_request", "failed_checks", "pending_checks", "pending_review", "stale_delivery",
  "pull_request_missing", "blocked_by_dependency", "waiting_human", "observation_unavailable",
]);

export const HermesActionRequiredSchema = z.object({
  owner: z.enum(["agent", "human", "forge", "upstream"]),
  reasonCode: HermesActionReasonCodeSchema,
  summary: z.string(),
  upstream: z.object({ taskId: z.string(), pullRequestNumber: z.number().int().min(1).nullable() }).strict().nullable(),
  evidenceAt: z.string(),
  suggestedCommands: z.array(z.string()),
  humanApprovalRequired: z.boolean(),
}).strict();
export const HermesTaskCommandSchema = z.enum(["start_task", "disarm_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait"]);
export const HermesTaskCommandBodySchema = z.object({
  command: HermesTaskCommandSchema,
  revision: z.string().min(1).max(256),
  idempotencyKey: z.string().trim().min(1).max(128),
  note: z.string().trim().min(1).optional(),
}).strict().superRefine((input, context) => {
  if (input.command === "send_task_note" && !input.note) context.addIssue({ code: "custom", path: ["note"], message: "A note is required" });
  if (input.command !== "send_task_note" && input.note !== undefined) context.addIssue({ code: "custom", path: ["note"], message: "Notes are only accepted by send_task_note" });
});

export const HermesProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** Identity adds the create-time policy so an agent can see what a project permits before it asks for it. */
export const HermesIdentityProjectSchema = HermesProjectSchema.extend({
  agentTaskPolicy: z.object({
    deliveryTargets: z.array(DeliveryTargetSchema),
    runProjectTests: z.boolean(),
    visualEvidence: VisualEvidenceSchema,
  }),
});

export const HermesIdentityResponseSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    profileId: z.string(),
  }),
  capabilities: z.object({
    taskDiscovery: z.literal(true),
    taskRead: z.literal(true),
    taskCreate: z.literal(true),
    taskCommands: z.array(HermesTaskCommandSchema),
  }),
  projects: z.array(HermesIdentityProjectSchema),
});

export const HermesTaskFilterSchema = z.enum(["stale_delivery", "conflicting_pull_request", "failed_checks", "pending_review", "blocked_by_dependency", "not_integrated"]);

export const HermesTaskListQuerySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  status: z.enum(["backlog", "active", "waiting_human", "cancelled", "delivered"]).optional(),
  archived: z.enum(["true", "false"]).optional(),
  attention: z.enum(["true", "false"]).optional(),
  blocker: z.enum(["true", "false"]).optional(),
  updatedSince: z.string().datetime().optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  filter: HermesTaskFilterSchema.optional(),
}).strict();

export const HermesProjectDiscoveryQuerySchema = z.object({
  projectId: z.string().min(1).max(128),
}).strict();

export const HermesWorkflowDiscoverySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  permittedForAgentTaskCreation: z.boolean(),
});

export const HermesWorkflowDiscoveryResponseSchema = z.object({
  workflows: z.array(HermesWorkflowDiscoverySchema),
});

export const HermesTemplateDiscoverySchema = HermesWorkflowDiscoverySchema;

export const HermesTemplateDiscoveryResponseSchema = z.object({
  templates: z.array(HermesTemplateDiscoverySchema),
});

export const HermesTaskDeliverySchema = z.object({
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

export const HermesSafeTaskProjectionSchema = z.object({
  id: z.string(),
  issueKey: z.string().nullable(),
  projectId: z.string(),
  project: HermesProjectSchema,
  title: z.string(),
  status: HermesTaskStatusSchema,
  queue: TaskQueueSchema.describe("startIntent is manual or queued. state separates backlog (manual), queued (waits to start by itself), running, needs_attention, delivered, and cancelled. waitingOn lists each incomplete prerequisite with its exact reason."),
  dependsOn: z.array(z.string()).describe("The ids of blockedBy, in the same order."),
  blockedBy: z.array(z.object({ id: z.string(), title: z.string(), status: HermesTaskStatusSchema }).strict()).describe("The prerequisite tasks of this task with their current title and status."),
  archived: z.boolean(),
  revision: z.string(),
  permittedCommands: z.array(HermesTaskCommandSchema),
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
  delivery: HermesTaskDeliverySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Read paths add observed delivery integration health. Command replies stay on stored task state, which needs no GitHub read. */
export const HermesTaskReadProjectionSchema = HermesSafeTaskProjectionSchema.extend({
  implementation: z.object({ status: HermesTaskStatusSchema }).strict(),
  integration: HermesIntegrationSchema,
  actionRequired: HermesActionRequiredSchema.nullable(),
});

export type HermesIntegration = z.infer<typeof HermesIntegrationSchema>;
export type HermesActionRequired = z.infer<typeof HermesActionRequiredSchema>;
export type HermesTaskFilter = z.infer<typeof HermesTaskFilterSchema>;
export type HermesSafeTaskProjection = z.infer<typeof HermesSafeTaskProjectionSchema>;

const HermesChecksSchema = z.object({
  total: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  failing: z.number().int().nonnegative(), successful: z.number().int().nonnegative(),
  runs: z.array(z.object({ name: z.string(), status: z.enum(["pending", "failing", "successful"]), url: z.string().nullable(), conclusion: z.string().optional() })),
});

export const HermesPullRequestObservationSchema = z.object({
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
  checks: HermesChecksSchema,
});

export const HermesDeliveryRefreshResponseSchema = z.object({
  taskId: z.string(),
  pullRequest: z.object({ repository: z.string(), number: z.number().int(), url: z.string(), headSha: z.string(), state: z.string(), mergedAt: z.string().nullable() }).nullable(),
  observation: HermesPullRequestObservationSchema.nullable(),
});

export const HermesDeliveryRepairResponseSchema = z.object({
  taskId: z.string(),
  attemptId: z.string(),
  observation: HermesPullRequestObservationSchema,
});

export const HermesDeliveryDecisionBodySchema = z.object({
  decision: z.enum(["wait_for_dependency", "resume"]),
}).strict();

export const HermesDeliveryDecisionResponseSchema = z.object({
  taskId: z.string(),
  decision: z.enum(["wait_for_dependency", "resume"]),
  blockingTaskIds: z.array(z.string()),
});

export const HermesMergeTrainQuerySchema = z.object({ projectId: z.string().min(1).max(128).optional() });

export const HermesMergeTrainResponseSchema = z.object({
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

export const HermesMergeApprovalBodySchema = z.object({
  pullRequestNumber: z.number().int().positive(),
  headSha: sha,
  baseSha: sha,
}).strict();

export const HermesMergeApprovalResponseSchema = z.object({
  taskId: z.string(),
  receipt: z.string(),
  expiresAt: z.string(),
  pullRequestNumber: z.number().int(),
  headSha: z.string().nullable(),
  baseSha: z.string().nullable(),
});

export const HermesMergeBodySchema = z.object({
  pullRequestNumber: z.number().int().positive(),
  expectedHeadSha: sha,
  expectedBaseSha: sha,
  approvalReceipt: z.string().min(1).max(128),
}).strict();

export const HermesMergeResponseSchema = z.object({
  taskId: z.string(),
  pullRequestNumber: z.number().int(),
  result: z.unknown(),
});

export const HermesProvenanceResponseSchema = z.object({
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
export type HermesTaskReadProjection = z.infer<typeof HermesTaskReadProjectionSchema>;

export const HermesTaskListResponseSchema = z.object({
  tasks: z.array(HermesTaskReadProjectionSchema),
  nextCursor: z.string().nullable(),
});

export const HermesRuntimeErrorSchema = z.object({
  error: z.string(),
  code: z.enum(["credential_invalid", "not_found", "resource_not_found", "idempotency_conflict", "command_in_progress", "revision_stale", "illegal_command", "request_invalid", "delivery_policy_rejected", "workflow_not_found", "workflow_not_permitted", "template_not_found", "template_not_permitted", "task_unavailable", "payload_too_large", "unsupported_media_type", "internal_error"]),
  findings: z.array(z.object({ code: z.string(), field: z.string(), message: z.string() })).optional(),
  permittedWorkflowIds: z.array(z.string()).optional(),
  permittedTemplateIds: z.array(z.string()).optional(),
});

const runtimeError = <T extends z.infer<typeof HermesRuntimeErrorSchema>["code"]>(code: T) => HermesRuntimeErrorSchema.extend({ code: z.literal(code) });

const HermesRuntimeErrorResponses = {
  requestInvalid: runtimeError("request_invalid"),
  credentialInvalid: runtimeError("credential_invalid"),
  notFound: runtimeError("not_found"),
  resourceNotFound: runtimeError("resource_not_found"),
  idempotencyConflict: runtimeError("idempotency_conflict"),
  commandInProgress: runtimeError("command_in_progress"),
  revisionStale: runtimeError("revision_stale"),
  illegalCommand: runtimeError("illegal_command"),
  deliveryPolicyRejected: runtimeError("delivery_policy_rejected"),
  workflowNotFound: runtimeError("workflow_not_found").extend({ permittedWorkflowIds: z.array(z.string()) }),
  workflowNotPermitted: runtimeError("workflow_not_permitted").extend({ permittedWorkflowIds: z.array(z.string()) }),
  templateNotFound: runtimeError("template_not_found").extend({ permittedTemplateIds: z.array(z.string()) }),
  templateNotPermitted: runtimeError("template_not_permitted").extend({ permittedTemplateIds: z.array(z.string()) }),
  taskUnavailable: runtimeError("task_unavailable"),
  payloadTooLarge: runtimeError("payload_too_large"),
  unsupportedMediaType: runtimeError("unsupported_media_type"),
  internal: runtimeError("internal_error"),
} as const;

export const HermesCapabilitiesSchema = z.object({
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
  autonomousCommands: z.array(z.enum(["create_backlog_task", "create_queued_task", "start_task", "disarm_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait", "observe_delivery", "request_delivery_repair", "decide_delivery_wait", "read_merge_train", "request_merge_approval", "merge_pull_request"])),
  humanOnlyRecords: z.array(z.literal("task_human_answer")),
  unavailableCommands: z.array(z.enum([
    "answer_human_question",
    "deliver_task",
    "merge_pull_request",
  ])),
  pagination: z.object({ supported: z.literal(false), cursor: z.literal(false) }),
});

export const HermesRuntimeOperations = {
  openApi: {
    response: { 200: z.record(z.string(), z.unknown()), 401: HermesRuntimeErrorResponses.credentialInvalid, 500: HermesRuntimeErrorResponses.internal },
  },
  capabilities: {
    response: { 200: HermesCapabilitiesSchema, 401: HermesRuntimeErrorResponses.credentialInvalid, 500: HermesRuntimeErrorResponses.internal },
  },
  workflows: {
    querystring: HermesProjectDiscoveryQuerySchema,
    response: { 200: HermesWorkflowDiscoveryResponseSchema, 401: HermesRuntimeErrorResponses.credentialInvalid, 404: HermesRuntimeErrorResponses.notFound, 500: HermesRuntimeErrorResponses.internal },
  },
  templates: {
    querystring: HermesProjectDiscoveryQuerySchema,
    response: { 200: HermesTemplateDiscoveryResponseSchema, 401: HermesRuntimeErrorResponses.credentialInvalid, 404: HermesRuntimeErrorResponses.notFound, 500: HermesRuntimeErrorResponses.internal },
  },
  createTask: {
    body: HermesTaskCreateBodySchema,
    response: {
      200: HermesTaskReadProjectionSchema,
      201: HermesTaskReadProjectionSchema,
      400: HermesRuntimeErrorResponses.requestInvalid,
      401: HermesRuntimeErrorResponses.credentialInvalid,
      404: z.union([HermesRuntimeErrorResponses.notFound, HermesRuntimeErrorResponses.resourceNotFound]),
      409: z.union([HermesRuntimeErrorResponses.idempotencyConflict, HermesRuntimeErrorResponses.taskUnavailable]),
      413: HermesRuntimeErrorResponses.payloadTooLarge,
      415: HermesRuntimeErrorResponses.unsupportedMediaType,
      422: z.union([HermesRuntimeErrorResponses.deliveryPolicyRejected, HermesRuntimeErrorResponses.workflowNotFound, HermesRuntimeErrorResponses.workflowNotPermitted, HermesRuntimeErrorResponses.templateNotFound, HermesRuntimeErrorResponses.templateNotPermitted, HermesRuntimeErrorResponses.taskUnavailable]),
      500: HermesRuntimeErrorResponses.internal,
    },
  },
  getTask: {
    params: HermesTaskIdParamsSchema,
    response: { 200: HermesTaskReadProjectionSchema, 400: HermesRuntimeErrorResponses.requestInvalid, 401: HermesRuntimeErrorResponses.credentialInvalid, 404: z.union([HermesRuntimeErrorResponses.notFound, HermesRuntimeErrorResponses.resourceNotFound]), 500: HermesRuntimeErrorResponses.internal },
  },
  setTaskDependencies: {
    params: HermesTaskIdParamsSchema,
    body: HermesTaskDependenciesBodySchema,
    response: { 200: HermesSafeTaskProjectionSchema, 400: HermesRuntimeErrorResponses.requestInvalid, 401: HermesRuntimeErrorResponses.credentialInvalid, 404: z.union([HermesRuntimeErrorResponses.notFound, HermesRuntimeErrorResponses.resourceNotFound]), 422: HermesRuntimeErrorResponses.taskUnavailable, 500: HermesRuntimeErrorResponses.internal },
  },
  commandTask: {
    params: HermesTaskIdParamsSchema,
    body: HermesTaskCommandBodySchema,
    response: { 200: HermesSafeTaskProjectionSchema, 400: HermesRuntimeErrorResponses.requestInvalid, 401: HermesRuntimeErrorResponses.credentialInvalid, 404: z.union([HermesRuntimeErrorResponses.notFound, HermesRuntimeErrorResponses.resourceNotFound]), 409: z.union([HermesRuntimeErrorResponses.idempotencyConflict, HermesRuntimeErrorResponses.commandInProgress, HermesRuntimeErrorResponses.illegalCommand, HermesRuntimeErrorResponses.taskUnavailable]), 412: HermesRuntimeErrorResponses.revisionStale, 500: HermesRuntimeErrorResponses.internal },
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
export function hermesRuntimeOpenApi(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Forge Hermes Runtime API",
      version: "v1",
      description: "Version v1 is additive-only within a major version. Pairing, credential rotation, and administration are separate provisioning APIs and are not part of this contract. Company, project grants, and creator ownership come from current server persistence, never request fields. Denied company, grant, creator, and missing-resource reads are all non-enumerating 404 responses.",
    },
    paths: {
      "/api/hermes/openapi.json": {
        get: {
          operationId: "getHermesRuntimeOpenApi",
          summary: "Read this authenticated runtime contract",
          security: [{ HermesBearer: [] }],
          responses: openApiResponses(HermesRuntimeOperations.openApi.response),
        },
      },
      "/api/hermes/capabilities": {
        get: {
          operationId: "getHermesCapabilities",
          summary: "Read paired-agent capabilities and unavailable commands",
          security: [{ HermesBearer: [] }],
          responses: openApiResponses(HermesRuntimeOperations.capabilities.response),
        },
      },
      "/api/hermes/workflows": {
        get: { operationId: "listHermesWorkflows", summary: "List workflows available to a project", security: [{ HermesBearer: [] }], parameters: [{ name: "projectId", in: "query", required: true, schema: jsonSchema(HermesRuntimeOperations.workflows.querystring.shape.projectId, "input") }], responses: openApiResponses(HermesRuntimeOperations.workflows.response) },
      },
      "/api/hermes/templates": {
        get: { operationId: "listHermesTemplates", summary: "List templates available to a project", security: [{ HermesBearer: [] }], parameters: [{ name: "projectId", in: "query", required: true, schema: jsonSchema(HermesRuntimeOperations.templates.querystring.shape.projectId, "input") }], responses: openApiResponses(HermesRuntimeOperations.templates.response) },
      },
      "/api/hermes/tasks": {
        post: {
          operationId: "createHermesBacklogTask",
          summary: "Create a backlog or queued task",
          description: "Creates a backlog task. With queue true, the task is queued: it starts now when every prerequisite is complete, and otherwise stays in the backlog with zero sessions until the last prerequisite completes. Without queue, it never starts by itself. The server defaults description to an empty string and rejects unknown fields with request_invalid. dependsOn sets the prerequisites, shown as Blocked by; every one must be a task this agent created in the same company. Idempotency is scoped to the paired agent and company. An identical replay returns 200; reuse for a different request returns 409 with idempotency_conflict. Collections are not supported, so pagination and cursors are unavailable.",
          security: [{ HermesBearer: [] }],
          requestBody: { required: true, content: { "application/json": { schema: inputSchema(HermesRuntimeOperations.createTask.body) } } },
          responses: openApiResponses(HermesRuntimeOperations.createTask.response),
        },
      },
      "/api/hermes/tasks/{taskId}": {
        get: {
          operationId: "getHermesCreatedTask",
          summary: "Read a task created by this paired agent",
          description: "Only the creating paired agent can read a task. Task states are backlog, active, waiting_human, cancelled, and delivered. queue separates a manual backlog task from a queued one and lists the exact wait reason of each incomplete prerequisite. A prerequisite is complete when it is delivered at its own delivery target; the merged target also needs the merged pull request state Forge observed from GitHub. Human questions are records only: answering them remains human authority and no agent answer command exists. The server router rejects path parameters longer than 100 characters before this authenticated operation is matched; those router-level responses are outside this contract. Collections are not supported, so pagination and cursors are unavailable.",
          security: [{ HermesBearer: [] }],
          parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(HermesRuntimeOperations.getTask.params.shape.taskId, "input") }],
          responses: openApiResponses(HermesRuntimeOperations.getTask.response),
        },
      },
      "/api/hermes/tasks/{taskId}/dependencies": {
        put: { operationId: "setHermesTaskDependencies", summary: "Replace the prerequisites of a task", description: "Replaces dependsOn, shown as Blocked by, with the complete set in the body. Every prerequisite must be a task this agent created in the same company. A self-reference, a cycle, or an unavailable task is rejected and the current set stays. Unknown fields are rejected. The response and every later read report dependsOn and blockedBy from the same stored edges.", security: [{ HermesBearer: [] }], parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(HermesRuntimeOperations.setTaskDependencies.params.shape.taskId, "input") }], requestBody: { required: true, content: { "application/json": { schema: jsonSchema(HermesRuntimeOperations.setTaskDependencies.body, "input") } } }, responses: openApiResponses(HermesRuntimeOperations.setTaskDependencies.response) },
      },
      "/api/hermes/tasks/{taskId}/commands": {
        post: { operationId: "commandHermesTask", summary: "Apply an authorized task lifecycle command", description: "Every command requires the current task revision and an idempotency key. start_task queues a manual backlog task: it starts now when every prerequisite is complete and never bypasses one. disarm_task returns a queued task to the manual backlog. Human answers, delivery, releases, and merges remain unavailable.", security: [{ HermesBearer: [] }], parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(HermesRuntimeOperations.commandTask.params.shape.taskId, "input") }], requestBody: { required: true, content: { "application/json": { schema: inputSchema(HermesRuntimeOperations.commandTask.body) } } }, responses: openApiResponses(HermesRuntimeOperations.commandTask.response) },
      },
    },
    components: {
      securitySchemes: { HermesBearer: { type: "http", scheme: "bearer", bearerFormat: "Hermes paired-agent credential" } },
    },
  };
}
