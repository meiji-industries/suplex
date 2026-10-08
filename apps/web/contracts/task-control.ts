import { z } from "zod";

import { HarnessKindSchema } from "./harness-kind.js";

export const TaskControlStatusSchema = z.enum(["backlog", "queued", "active", "waiting_human", "cancelled", "delivered"]);

export const TaskSessionKindSchema = z.enum(["root", "worker"]);

export const TaskTurnStatusSchema = z.enum(["pending_prompt", "prompted", "unknown", "completed", "cancelled"]);

export const TaskProfileFieldsSchema = z.object({ profileId: z.string().min(1), provider: HarnessKindSchema, model: z.string().min(1), reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]), serviceTier: z.enum(["default", "priority"]), providerInstanceId: z.string().nullable().optional(), instanceHomeDirectory: z.string().nullable().optional() }).strict();

export const WorktreeReferenceSchema = z.object({
  path: z.string().min(1), branch: z.string().min(1), baseSha: z.string().min(1), headSha: z.string().min(1), dirty: z.boolean(),
}).strict();

export const PullRequestReferenceSchema = z.object({
  repository: z.string().min(1), number: z.number().int().positive(), url: z.string().url(), headSha: z.string().min(1), state: z.string().min(1), mergedAt: z.string().datetime().nullable(),
}).strict();

export type PullRequestReference = z.infer<typeof PullRequestReferenceSchema>;

export type TaskControlStatus = z.infer<typeof TaskControlStatusSchema>;
