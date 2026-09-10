import { z } from "zod";
import { TaskControlStatusSchema } from "../control.js";
import { TaskUsageSchema } from "../usage.js";

export const TaskAnalyticsSchema = z.object({
  id: z.string(), title: z.string(), issueKey: z.string().nullable(), projectId: z.string(),
  status: TaskControlStatusSchema, pullRequestState: z.string().optional(), deliveryTarget: z.string(), archived: z.boolean(), createdAt: z.string(),
  usage: z.array(TaskUsageSchema), sessions: z.number(), observedSessions: z.number(), staleSessions: z.number(),
  observedAt: z.string().nullable(), observationStartedAt: z.string().nullable(),
  questions: z.number(), observedWaitMs: z.number(), deliveryMs: z.number().nullable(),
});
export const AnalyticsResponseSchema = z.object({ tasks: z.array(TaskAnalyticsSchema), generatedAt: z.string() });
export type TaskAnalytics = z.infer<typeof TaskAnalyticsSchema>;
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;
export const TaskCostsResponseSchema = z.object({ tasks: z.array(z.object({ id: z.string(), cost: z.number().nullable(), partial: z.boolean(), unpriced: z.boolean(), subsidized: z.boolean() })) });
