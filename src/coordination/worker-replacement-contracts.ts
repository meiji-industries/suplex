import { z } from "zod";

export const WorkerReplacementRequestSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().trim().min(1),
  handoff: z.string().trim().optional(),
  workerProfileId: z.string().min(1).optional(),
}).strict();
export type WorkerReplacementRequest = z.infer<typeof WorkerReplacementRequestSchema>;
export const WorkerReplacementSchema = z.object({ sessionId: z.string(), reason: z.string(), handoff: z.string() });

