import { z } from "zod";

import { TaskSessionKindSchema } from "./task-control.js";

import { AdvisorRoleSchema } from "./advisor-reports.js";

export const TimelineTaskSchema = z.object({
  id: z.string(), projectId: z.string(), issueKey: z.string().nullable(), title: z.string(),
  activity: z.array(z.object({
    id: z.string(), role: TaskSessionKindSchema, advisorRole: AdvisorRoleSchema.nullable().optional(), label: z.string().optional(), agentId: z.string(), agentName: z.string(), avatarSeed: z.string(),
    status: z.enum(["completed", "running", "failed", "interrupted"]), attempt: z.number(),
    startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  })),
});

export const TaskTimelineResponseSchema = z.object({ tasks: z.array(TimelineTaskSchema), unavailableSessions: z.number().int().nonnegative() });

export type TimelineTask = z.infer<typeof TimelineTaskSchema>;
