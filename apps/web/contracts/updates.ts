import { z } from "zod";

export const UpdateStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }).strict(),
  z.object({ kind: z.literal("checking") }).strict(),
  z.object({ kind: z.literal("current") }).strict(),
  z.object({ kind: z.literal("available") }).strict(),
  z.object({ kind: z.literal("applying"), step: z.enum(["fetch", "stop", "merge", "install", "build", "start"]), message: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("failed"), action: z.enum(["check", "apply"]), message: z.string().min(1), error: z.string().min(1) }).strict(),
]).readonly();

export const UpdateResponseSchema = z.object({
  status: UpdateStatusSchema,
  currentRevision: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  availableRevision: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  currentVersion: z.string().min(1).optional(),
  availableVersion: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
  canRestart: z.boolean(),
}).strict();

export const UpdateRestartResponseSchema = z.object({ accepted: z.literal(true), status: UpdateStatusSchema }).strict();

export type UpdateResponse = z.infer<typeof UpdateResponseSchema>;
