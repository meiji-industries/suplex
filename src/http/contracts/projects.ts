import { z } from "zod";

import { AdminCapacityLaneSchema } from "../../capacity-contracts.js";

const ProjectRoleDefaultsSchema = z.object({ planner: z.string().optional(), builder: z.string().optional(), reviewer: z.string().optional(), integrator: z.string().optional() });

const OptionalCapacitySchema = z.preprocess((value) => value === "" ? null : value, z.coerce.number().int().min(1).max(32).nullable().optional());

export const ProfileBodySchema = z.object({
  name: z.string().default(""),
  model: z.string().default(""),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]),
  servicePriority: z.enum(["standard", "priority", "fast"]),
  capacity: OptionalCapacitySchema,
}).strict();
export const ProfileCapacityBodySchema = z.object({ capacity: OptionalCapacitySchema }).strict();

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
  roleDefaults: ProjectRoleDefaultsSchema.default({}),
}).strict();

export const AgentBodySchema = z.object({ name: z.string().min(1), role: z.enum(["planner", "builder", "reviewer", "integrator"]), avatarSeed: z.string().regex(/^[a-f0-9]{32}$/).optional(), profileId: z.string().min(1) }).strict();
export const AgentPatchBodySchema = z.object({ name: z.string().min(1).optional(), role: z.enum(["planner", "builder", "reviewer", "integrator"]).optional(), avatarSeed: z.string().regex(/^[a-f0-9]{32}$/).optional(), profileId: z.string().min(1).optional(), archived: z.boolean().optional() }).strict();
export const AgentResponseSchema = z.object({ id: z.string(), name: z.string(), role: z.enum(["planner", "builder", "reviewer", "integrator"]), avatarSeed: z.string(), profileId: z.string(), archivedAt: z.string().nullable(), activeCount: z.number().int().nonnegative(), lastSeenAt: z.string(), createdAt: z.string(), updatedAt: z.string() });
export const AgentListResponseSchema = z.object({ agents: z.array(AgentResponseSchema) });
export const AgentListQuerySchema = z.object({ companyId: z.string().min(1).optional(), includeArchived: z.literal("true").optional() });
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const ProjectRepositoryBodySchema = z.object({
  repositoryUrl: z.string().default(""),
}).strict();

export const ProjectCreateBodySchema = z.union([ProjectRepositoryBodySchema, ProjectBodySchema]);

export const ProfileResponseSchema = z.object({ id: z.string(), name: z.string(), provider: z.literal("codex"), model: z.string(), reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]), servicePriority: z.enum(["standard", "priority", "fast"]), capacity: z.number().nullable(), effectiveCapacity: z.number().int().min(1).max(32), createdAt: z.string(), updatedAt: z.string() });
export const ProfileListResponseSchema = z.object({ profiles: z.array(ProfileResponseSchema) });
export const AdminCapacityListResponseSchema = z.object({ lanes: z.array(AdminCapacityLaneSchema) });
export const ModelResponseSchema = z.object({ id: z.string(), displayName: z.string(), description: z.string(), status: z.enum(["active", "retired"]), sortOrder: z.number(), createdAt: z.string(), updatedAt: z.string() });
export const ModelListResponseSchema = z.object({ models: z.array(ModelResponseSchema) });
export const ModelBodySchema = z.object({ id: z.string().default(""), displayName: z.string().default(""), description: z.string().default(""), sortOrder: z.coerce.number().int().default(100) }).strict();
export const ModelStatusBodySchema = z.object({ status: z.enum(["active", "retired"]) }).strict();
export const ModelIdParamsSchema = z.object({ modelId: z.string() });
export const ProjectCheckListResponseSchema = z.object({ checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().optional() })) });
export const ProjectRepositoryDefaultsResponseSchema = z.object({ setupCommand: z.string(), verificationCommand: z.string() });
export const ProjectResponseSchema = z.object({
  id: z.string(), companyId: z.string(), name: z.string(), repositoryPath: z.string(), worktreeRoot: z.string(), repository: z.string().optional(), baseBranch: z.string(), targetBranch: z.string(), setupCommand: z.string(), verificationCommand: z.string(), requiredChecks: z.array(z.string()), roleDefaults: ProjectRoleDefaultsSchema, createdAt: z.string(), updatedAt: z.string(),
});
export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectResponseSchema) });
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export type ProjectCheckResponse = z.infer<typeof ProjectCheckListResponseSchema>["checks"][number];
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
