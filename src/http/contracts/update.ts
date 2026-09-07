import { z } from "zod";

export const UPDATE_OPERATION_TIMEOUT_MS = 12 * 60_000;

export const UpdateOperationStatusSchema = z.object({
  operationId: z.string().min(1),
  status: z.enum(["pending", "preparing", "restarting", "succeeded", "failed"]),
  targetRevision: z.string().min(1),
  acceptedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  message: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).strict();

export const UpdateResponseSchema = z.object({
  available: z.boolean(),
  revision: z.string().min(1).optional(),
  currentRevision: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
  canRestart: z.boolean().optional(),
  operation: UpdateOperationStatusSchema.optional(),
});

export const RestartUpdateBodySchema = z.object({
  revision: z.string().trim().regex(/^[0-9a-f]{40}$/i),
});

export const UpdateRestartResponseSchema = z.object({
  accepted: z.literal(true),
  operation: UpdateOperationStatusSchema,
});

export type UpdateResponse = z.infer<typeof UpdateResponseSchema>;
export type UpdateOperationStatus = z.infer<typeof UpdateOperationStatusSchema>;
export type UpdateRestartResponse = z.infer<typeof UpdateRestartResponseSchema>;
