import { z } from "zod";

import { TaskSessionKindSchema } from "./task-control.js";

const count = z.number().finite().nonnegative();

export const UsageTokensSchema = z.object({ input: count, output: count, reasoning: count, cache: z.object({ read: count, write: count }) });

export const TaskUsageSchema = z.object({
  sessionId: z.string(), messageId: z.string(), turnId: z.string(), role: TaskSessionKindSchema,
  provider: z.string(), model: z.string(), startedAt: z.number(), completedAt: z.number().nullable(),
  failed: z.boolean(), summary: z.boolean(), steps: count, cost: count, subsidized: z.boolean().default(false),
  tokens: UsageTokensSchema, source: z.enum(["steps", "message"]),
  generationMs: count.nullable().default(null), firstResponseMs: count.nullable().default(null),
});

export type TaskUsage = z.infer<typeof TaskUsageSchema>;
export type UsageTokens = z.infer<typeof UsageTokensSchema>;
