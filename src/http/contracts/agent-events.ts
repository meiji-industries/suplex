import { z } from "zod";

export const AgentEventQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
});

export const AgentTimelineEventSchema = z.object({
  streamId: z.number().int().positive(),
  id: z.string(),
  eventType: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  executionId: z.string().nullable(),
  executionRole: z.enum(["planner", "reviewer", "builder", "integrator"]).nullable(),
  sessionId: z.string().nullable(),
  forgeTurnId: z.string().nullable(),
});

export const AgentEventHistorySchema = z.object({
  events: z.array(AgentTimelineEventSchema),
  status: z.object({ phase: z.string(), terminal: z.boolean() }),
});

export type AgentTimelineEvent = z.infer<typeof AgentTimelineEventSchema>;
