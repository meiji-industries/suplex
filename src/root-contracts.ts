import { z } from "zod";

const opaqueId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const RootIdentitySchema = z.object({
  taskId: opaqueId,
  sessionId: opaqueId,
  generation: z.number().int().positive(),
}).strict();

export type RootIdentity = z.infer<typeof RootIdentitySchema>;

export const DeliveryOperationSchema = z.enum([
  "push_branch",
  "create_or_adopt_pull_request",
  "observe_pull_request",
  "observe_checks",
  "rerun_or_diagnose_checks",
  "request_review",
  "merge_after_approval",
]);
export type DeliveryOperation = z.infer<typeof DeliveryOperationSchema>;

export const RootToolSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observe") }).strict(),
  z.object({ kind: z.literal("delegate_worker"), instruction: z.string().min(1).max(20_000) }).strict(),
  z.object({ kind: z.literal("request_delivery"), operation: DeliveryOperationSchema, expectedHead: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("ask_human"), question: z.string().min(1).max(4_000) }).strict(),
]);

export type RootTool = z.infer<typeof RootToolSchema>;

export const RootBridgeConfigSchema = z.object({
  version: z.literal(1),
  root: RootIdentitySchema,
  databasePath: z.string().min(1).optional(),
  server: z.object({ command: z.string().min(1), args: z.array(z.string()) }).strict(),
}).strict();

export type RootBridgeConfig = z.infer<typeof RootBridgeConfigSchema>;
