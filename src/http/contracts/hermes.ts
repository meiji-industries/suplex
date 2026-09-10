import { z } from "zod";
import { AdvisorProfileIdsSchema } from "../../coordination/workflows.js";
import { DeliveryTargetSchema, TaskImageInputSchema, TaskSourceInputSchema, VisualEvidenceSchema } from "../../tasks/contracts.js";
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

export const HermesTaskCreateBodySchema = z.object({
  projectId: z.string().min(1).max(128),
  title: z.string().trim().min(1),
  description: z.string().trim().optional().meta({ default: "" }),
  idempotencyKey: z.string().trim().min(1).max(128),
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
export const HermesTaskCommandSchema = z.enum(["start_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait"]);
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
  projects: z.array(HermesProjectSchema),
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
  archived: z.boolean(),
  revision: z.string(),
  permittedCommands: z.array(HermesTaskCommandSchema),
  humanQuestion: z.string().nullable(),
  blocker: z.object({
    kind: z.enum(["human_question", "delivery_wait"]),
    reason: z.enum(["checks", "mergeability", "merge_queue", "observation"]).optional(),
  }).nullable(),
  workflowStage: z.string(),
  workflow: z.string(),
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
export type HermesTaskReadProjection = z.infer<typeof HermesTaskReadProjectionSchema>;

export const HermesTaskListResponseSchema = z.object({
  tasks: z.array(HermesTaskReadProjectionSchema),
  nextCursor: z.string().nullable(),
});

export const HermesRuntimeErrorSchema = z.object({
  error: z.string(),
  code: z.enum(["credential_invalid", "not_found", "resource_not_found", "idempotency_conflict", "command_in_progress", "revision_stale", "illegal_command", "request_invalid", "task_unavailable", "payload_too_large", "unsupported_media_type", "internal_error"]),
  findings: z.array(z.object({ code: z.string(), field: z.string(), message: z.string() })).optional(),
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
  taskUnavailable: runtimeError("task_unavailable"),
  payloadTooLarge: runtimeError("payload_too_large"),
  unsupportedMediaType: runtimeError("unsupported_media_type"),
  internal: runtimeError("internal_error"),
} as const;

export const HermesCapabilitiesSchema = z.object({
  apiVersion: z.literal("v1"),
  capabilities: z.object({
    read: z.object({ task: z.literal(true) }),
    create: z.object({ backlogTask: z.literal(true) }),
    taskControl: z.literal(true),
    delivery: z.literal(false),
    merge: z.literal(false),
    humanDecisions: z.literal(false),
  }),
  autonomousCommands: z.array(z.enum(["create_backlog_task", "start_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait"])),
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
      422: HermesRuntimeErrorResponses.taskUnavailable,
      500: HermesRuntimeErrorResponses.internal,
    },
  },
  getTask: {
    params: HermesTaskIdParamsSchema,
    response: { 200: HermesTaskReadProjectionSchema, 400: HermesRuntimeErrorResponses.requestInvalid, 401: HermesRuntimeErrorResponses.credentialInvalid, 404: z.union([HermesRuntimeErrorResponses.notFound, HermesRuntimeErrorResponses.resourceNotFound]), 500: HermesRuntimeErrorResponses.internal },
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
      "/api/hermes/tasks": {
        post: {
          operationId: "createHermesBacklogTask",
          summary: "Create a backlog task without starting it",
          description: "Creates a backlog task and never starts execution. The server defaults description to an empty string and ignores unknown fields. Idempotency is scoped to the paired agent and company. An identical replay returns 200; reuse for a different request returns 409 with idempotency_conflict. Collections are not supported, so pagination and cursors are unavailable.",
          security: [{ HermesBearer: [] }],
          requestBody: { required: true, content: { "application/json": { schema: inputSchema(HermesRuntimeOperations.createTask.body) } } },
          responses: openApiResponses(HermesRuntimeOperations.createTask.response),
        },
      },
      "/api/hermes/tasks/{taskId}": {
        get: {
          operationId: "getHermesCreatedTask",
          summary: "Read a task created by this paired agent",
          description: "Only the creating paired agent can read a task. Task states are backlog, active, waiting_human, cancelled, and delivered. Human questions are records only: answering them remains human authority and no agent answer command exists. The server router rejects path parameters longer than 100 characters before this authenticated operation is matched; those router-level responses are outside this contract. Collections are not supported, so pagination and cursors are unavailable.",
          security: [{ HermesBearer: [] }],
          parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(HermesRuntimeOperations.getTask.params.shape.taskId, "input") }],
          responses: openApiResponses(HermesRuntimeOperations.getTask.response),
        },
      },
      "/api/hermes/tasks/{taskId}/commands": {
        post: { operationId: "commandHermesTask", summary: "Apply an authorized task lifecycle command", description: "Every command requires the current task revision and an idempotency key. Human answers, delivery, releases, and merges remain unavailable.", security: [{ HermesBearer: [] }], parameters: [{ name: "taskId", in: "path", required: true, schema: jsonSchema(HermesRuntimeOperations.commandTask.params.shape.taskId, "input") }], requestBody: { required: true, content: { "application/json": { schema: inputSchema(HermesRuntimeOperations.commandTask.body) } } }, responses: openApiResponses(HermesRuntimeOperations.commandTask.response) },
      },
    },
    components: {
      securitySchemes: { HermesBearer: { type: "http", scheme: "bearer", bearerFormat: "Hermes paired-agent credential" } },
    },
  };
}
