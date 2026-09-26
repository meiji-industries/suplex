import { z } from "zod";

import { AdvisorRoleSchema } from "./advisor-reports.js";

export const TaskToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["pending", "running", "completed", "error"]),
  input: z.record(z.string(), z.unknown()),
  output: z.string().nullable(),
  error: z.string().nullable(),
});

export const TaskPlanItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});

export const TaskExecutionResponseSchema = z.object({
  sessions: z.array(z.object({
    id: z.string(),
    role: z.enum(["root", "worker"]),
    advisorRole: AdvisorRoleSchema.nullable().optional(),
    label: z.string().optional(),
    generation: z.number(),
    available: z.boolean(),
    limited: z.boolean(),
    tools: z.array(TaskToolSchema),
    plan: z.array(TaskPlanItemSchema).nullable(),
  })),
});

export type TaskExecution = z.infer<typeof TaskExecutionResponseSchema>;
