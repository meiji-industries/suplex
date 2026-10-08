import { TaskProfileFieldsSchema, TaskSessionKindSchema } from "./task-control.js";

import { z } from "zod";

export const AgentProfileInputSchema = TaskProfileFieldsSchema.omit({ profileId: true, instanceHomeDirectory: true }).extend({
  name: z.string().trim().min(1),
  role: TaskSessionKindSchema,
  avatarSeed: z.string().regex(/^[a-f0-9]{32}$/),
  model: z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  providerInstanceId: z.string().min(1).nullable().optional(),
}).strict();

export const AgentProfileSchema = AgentProfileInputSchema.extend({ id: z.string(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).strict();

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
