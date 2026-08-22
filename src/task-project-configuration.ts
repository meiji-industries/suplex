import { z } from "zod";

const RoleAssignmentsSchema = z.object({
  planner: z.string().min(1).optional(),
  builder: z.string().min(1),
  reviewer: z.string().min(1).optional(),
  integrator: z.string().min(1).optional(),
}).strict();

export const TaskProjectConfigurationSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  setupCommand: z.string().min(1),
  verificationCommand: z.string().min(1),
  requiredChecks: z.array(z.string().min(1)).max(32),
  roleAgents: RoleAssignmentsSchema,
  roleProfiles: RoleAssignmentsSchema,
  capturedAt: z.string().datetime(),
}).strict();

export type TaskProjectConfiguration = z.infer<typeof TaskProjectConfigurationSchema>;

export function parseTaskProjectConfiguration(value: string | unknown): TaskProjectConfiguration {
  try {
    return TaskProjectConfigurationSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    throw new Error("Task project configuration is unavailable");
  }
}
