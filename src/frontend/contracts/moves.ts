import { z } from "zod";

export const MoveRunnerSchema = z.enum(["prompt", "script", "pull_request_tasks"]);

export const MoveBodySchema = z.object({
  projectId: z.string().min(1).max(256),
  name: z.string().trim().min(1),
  prompt: z.string().max(20_000),
  runner: MoveRunnerSchema,
  profileId: z.string().min(1).max(256).nullable().optional(),
  confirm: z.boolean(),
}).strict();

export type MoveBody = z.infer<typeof MoveBodySchema>;

export const MoveRunBodySchema = z.object({
  inputs: z.record(z.string().min(1).max(64), z.string().max(4000)),
  excludedPullRequests: z.array(z.number().int().positive()).max(200),
  idempotencyKey: z.string().min(1).max(256),
}).strict();

export type MoveRunBody = z.infer<typeof MoveRunBodySchema>;
