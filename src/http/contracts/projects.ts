import { z } from "zod";

const ProjectRoleDefaultsSchema = z.object({ lead: z.string().optional(), developer: z.string().optional(), reviewer: z.string().optional() });

export const ProfileBodySchema = z.object({
  name: z.string().default(""),
  model: z.string().default(""),
  reasoningLevel: z.enum(["low", "medium", "high"]),
  servicePriority: z.enum(["standard", "priority"]),
  capacity: z.coerce.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const ProjectBodySchema = z.object({
  name: z.string().default(""),
  repositoryPath: z.string().default(""),
  worktreeRoot: z.string().default(""),
  repository: z.string().default(""),
  baseBranch: z.string().default(""),
  targetBranch: z.string().default(""),
  setupCommand: z.string().default(""),
  verificationCommand: z.string().default(""),
  requiredChecks: z.array(z.string()).default([]),
  allowedProfileIds: z.array(z.string()).default([]),
  roleDefaults: ProjectRoleDefaultsSchema.default({}),
});

export const ProfileResponseSchema = z.object({ id: z.string(), name: z.string(), provider: z.literal("codex"), model: z.string(), reasoningLevel: z.enum(["low", "medium", "high"]), servicePriority: z.enum(["standard", "priority"]), capacity: z.number(), createdAt: z.string(), updatedAt: z.string() });
export const ProfileListResponseSchema = z.object({ profiles: z.array(ProfileResponseSchema) });
export const ProjectResponseSchema = z.object({
  id: z.string(), companyId: z.string(), name: z.string(), repositoryPath: z.string(), worktreeRoot: z.string(), repository: z.string().optional(), baseBranch: z.string(), targetBranch: z.string(), setupCommand: z.string(), verificationCommand: z.string(), requiredChecks: z.array(z.string()), allowedProfileIds: z.array(z.string()), roleDefaults: ProjectRoleDefaultsSchema, status: z.enum(["draft", "active", "paused", "archived"]), activeRevisionId: z.string().optional(), configurationRevision: z.number(), configurationIdentity: z.string().optional(), baseSha: z.string().optional(), targetSha: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});
export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectResponseSchema) });
