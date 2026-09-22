import { z } from "zod";

const nativeId = z.string().min(1);
const sessionId = nativeId.regex(/^ses/);
const messageId = nativeId.regex(/^msg/);
const partId = nativeId.regex(/^prt/);
const record = z.record(z.string(), z.unknown());

export const OpenCodeHealthSchema = z.object({
  healthy: z.literal(true),
  version: z.string().min(1),
}).passthrough();
export type OpenCodeHealth = z.infer<typeof OpenCodeHealthSchema>;

export const OpenCodeMcpStatusSchema = z.record(z.string(), z.object({ status: z.string(), error: z.string().optional() }).passthrough());
export type OpenCodeMcpStatus = z.infer<typeof OpenCodeMcpStatusSchema>;

// Strip provider keys and options at the HTTP boundary. Neither belongs in Suplex.
export const OpenCodeProvidersSchema = z.object({
  all: z.array(z.object({ id: z.string(), name: z.string(), models: z.record(z.string(), z.object({ id: z.string(), name: z.string() })) })),
  connected: z.array(z.string()),
  default: z.record(z.string(), z.string()),
});
export type OpenCodeProviders = z.infer<typeof OpenCodeProvidersSchema>;

export const OpenCodeModelSchema = z.object({
  id: z.string().min(1),
  providerID: z.string().min(1),
  variant: z.string().min(1).optional(),
}).passthrough();
export type OpenCodeModel = z.infer<typeof OpenCodeModelSchema>;

export const OpenCodeSessionModelSchema = z.object({
  id: z.string().min(1),
  providerID: z.string().min(1),
  variant: z.string().min(1).optional(),
}).strict();

export const OpenCodeMessageModelSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().min(1).optional(),
}).passthrough();

const nativeError = z.object({
  name: z.string().min(1),
  data: record.optional(),
}).passthrough();

const messageTime = z.object({
  created: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative().optional(),
}).passthrough();

export const OpenCodeUserMessageSchema = z.object({
  id: messageId,
  sessionID: sessionId,
  role: z.literal("user"),
  time: z.object({ created: z.number().nonnegative() }).passthrough(),
  agent: z.string().min(1),
  model: OpenCodeMessageModelSchema,
}).passthrough();
export type OpenCodeUserMessage = z.infer<typeof OpenCodeUserMessageSchema>;

export const OpenCodeAssistantMessageSchema = z.object({
  id: messageId,
  sessionID: sessionId,
  role: z.literal("assistant"),
  time: messageTime,
  error: nativeError.optional(),
  parentID: messageId,
  modelID: z.string().min(1),
  providerID: z.string().min(1),
  mode: z.string().min(1),
  agent: z.string().min(1),
  summary: z.boolean().optional(),
  path: z.object({ cwd: z.string().min(1), root: z.string().min(1) }).passthrough(),
  cost: z.number(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }).passthrough(),
  }).passthrough(),
  variant: z.string().min(1).optional(),
  finish: z.string().min(1).optional(),
}).passthrough();
export type OpenCodeAssistantMessage = z.infer<typeof OpenCodeAssistantMessageSchema>;

export const OpenCodeMessageSchema = z.discriminatedUnion("role", [
  OpenCodeUserMessageSchema,
  OpenCodeAssistantMessageSchema,
]);
export type OpenCodeMessage = z.infer<typeof OpenCodeMessageSchema>;

export const OpenCodeTextPartSchema = z.object({
  id: partId.optional(),
  sessionID: sessionId.optional(),
  messageID: messageId.optional(),
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).passthrough();

export const OpenCodeCompactionPartSchema = z.object({
  type: z.literal("compaction"),
  auto: z.boolean().optional(),
}).passthrough();

const toolState = z.object({ status: z.enum(["pending", "running", "completed", "error"]) }).passthrough();
export const OpenCodeToolPartSchema = z.object({
  id: partId.optional(),
  sessionID: sessionId.optional(),
  messageID: messageId.optional(),
  type: z.literal("tool"),
  callID: z.string().min(1),
  tool: z.string().min(1),
  state: toolState,
}).passthrough();

export const OpenCodePartSchema = z.union([
  OpenCodeTextPartSchema,
  OpenCodeToolPartSchema,
  OpenCodeCompactionPartSchema,
  z.object({ type: z.string().min(1).refine((type) => !["text", "tool", "compaction"].includes(type)) }).passthrough(),
]);
export type OpenCodePart = z.infer<typeof OpenCodePartSchema>;

export const OpenCodeMessageEnvelopeSchema = z.object({
  info: OpenCodeMessageSchema,
  parts: z.array(OpenCodePartSchema),
}).passthrough();
export type OpenCodeMessageEnvelope = z.infer<typeof OpenCodeMessageEnvelopeSchema>;

export const OpenCodeSessionSchema = z.object({
  id: sessionId,
  projectID: z.string().min(1),
  directory: z.string().min(1),
  title: z.string(),
  version: z.string().min(1),
  time: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  }).passthrough(),
  model: OpenCodeModelSchema.optional(),
  agent: z.string().min(1).optional(),
  permission: z.array(z.unknown()).optional(),
}).passthrough();
export type OpenCodeSession = z.infer<typeof OpenCodeSessionSchema>;

export const OpenCodeSessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }).passthrough(),
  z.object({
    type: z.literal("retry"),
    attempt: z.number().int().nonnegative(),
    message: z.string(),
    next: z.number().int().nonnegative(),
  }).passthrough(),
  z.object({ type: z.literal("busy") }).passthrough(),
]);
export type OpenCodeSessionStatus = z.infer<typeof OpenCodeSessionStatusSchema>;
export const OpenCodeSessionStatusMapSchema = z.record(z.string(), OpenCodeSessionStatusSchema);

export const OpenCodePermissionActionSchema = z.enum(["allow", "deny", "ask"]);
export const OpenCodePermissionRuleSchema = z.object({
  permission: z.string().min(1),
  pattern: z.string(),
  action: OpenCodePermissionActionSchema,
}).strict();
export type OpenCodePermissionRule = z.infer<typeof OpenCodePermissionRuleSchema>;

export const OpenCodeSessionCreateRequestSchema = z.object({
  title: z.string().optional(),
  agent: z.string().optional(),
  model: OpenCodeSessionModelSchema,
  metadata: record.optional(),
  permission: z.array(OpenCodePermissionRuleSchema).optional(),
}).strict();
export type OpenCodeSessionCreateRequest = z.infer<typeof OpenCodeSessionCreateRequestSchema>;

export const OpenCodePromptRequestSchema = z.object({
  messageID: messageId,
  model: z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
  }).strict(),
  agent: z.string().min(1),
  variant: z.string().min(1),
  parts: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).min(1),
  noReply: z.boolean().optional(),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
}).strict();
export type OpenCodePromptRequest = z.infer<typeof OpenCodePromptRequestSchema>;

export const OpenCodeConfigSchema = z.record(z.string(), z.unknown());
export type OpenCodeConfig = z.infer<typeof OpenCodeConfigSchema>;

export const OpenCodeEventSchema = z.object({
  type: z.string().min(1),
  properties: z.unknown(),
}).passthrough();
export type OpenCodeEvent = z.infer<typeof OpenCodeEventSchema>;

export const OPENCODE_PROMPT_STATES = [
  "admitted",
  "running",
  "completed",
  "terminal_incomplete",
  "error",
  "interrupted",
  "unknown",
] as const;
export type OpenCodePromptState = (typeof OPENCODE_PROMPT_STATES)[number];
