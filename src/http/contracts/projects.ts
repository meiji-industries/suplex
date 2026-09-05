import { z } from "zod";
import { AdminCapacityLaneSchema } from "../../capacity-contracts.js";

const ProviderIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine((id) => id !== "codex" && id !== "claude", "Select an OpenCode provider");
const ProjectRoleDefaultsSchema = z.object({ planner: z.string().optional(), builder: z.string().optional(), reviewer: z.string().optional(), integrator: z.string().optional() });

const OptionalCapacitySchema = z.preprocess((value) => value === "" ? null : value, z.coerce.number().int().min(1).max(32).nullable().optional());

const AgentSettingsSchema = z.object({
  provider: ProviderIdSchema.default("openai"),
  model: z.string().default(""),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]),
  servicePriority: z.enum(["standard", "priority", "fast"]),
  capacity: OptionalCapacitySchema,
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
  roleDefaults: ProjectRoleDefaultsSchema.default({}),
});

export const AgentBodySchema = z.object({ name: z.string().min(1), role: z.enum(["planner", "builder", "reviewer", "integrator"]), avatarSeed: z.string().regex(/^[a-f0-9]{32}$/).optional() }).extend(AgentSettingsSchema.shape);
export const AgentPatchBodySchema = z.object({ name: z.string().min(1).optional(), role: z.enum(["planner", "builder", "reviewer", "integrator"]).optional(), avatarSeed: z.string().regex(/^[a-f0-9]{32}$/).optional(), archived: z.boolean().optional(), provider: ProviderIdSchema.optional(), model: z.string().optional(), reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(), servicePriority: z.enum(["standard", "priority", "fast"]).optional(), capacity: OptionalCapacitySchema });
export const AgentResponseSchema = z.object({ id: z.string(), name: z.string(), role: z.enum(["planner", "builder", "reviewer", "integrator"]), avatarSeed: z.string(), profileId: z.string(), provider: ProviderIdSchema, model: z.string(), reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]), servicePriority: z.enum(["standard", "priority", "fast"]), capacity: z.number().nullable(), effectiveCapacity: z.number().int().min(1).max(32), archivedAt: z.string().nullable(), activeCount: z.number().int().nonnegative(), lastSeenAt: z.string(), createdAt: z.string(), updatedAt: z.string() });
export const AgentListResponseSchema = z.object({ agents: z.array(AgentResponseSchema) });
export const AgentListQuerySchema = z.object({ companyId: z.string().min(1).optional(), includeArchived: z.literal("true").optional() });
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export const AgentRuntimeProjectionSchema = z.object({ agentId: z.string(), taskId: z.string(), role: z.enum(["planner", "builder", "reviewer", "integrator"]), paneId: z.string().nullable(), liveStatus: z.enum(["active", "terminal", "missing", "unavailable"]), diagnosis: z.enum(["working", "resting", "blocked", "result_missing", "recovering_runtime", "runtime_unavailable", "identity_conflict", "unknown"]), detail: z.string() });
export const AgentRuntimeListResponseSchema = z.object({ runtime: z.array(AgentRuntimeProjectionSchema) });
export type AgentRuntimeProjection = z.infer<typeof AgentRuntimeProjectionSchema>;

export const ProjectRepositoryBodySchema = z.object({
  repositoryUrl: z.string().min(1),
});

export const ProjectCreateBodySchema = z.union([ProjectRepositoryBodySchema, ProjectBodySchema]);

export const ProfileResponseSchema = z.object({ id: z.string(), name: z.string(), provider: ProviderIdSchema, model: z.string(), reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]), servicePriority: z.enum(["standard", "priority", "fast"]), capacity: z.number().nullable(), effectiveCapacity: z.number().int().min(1).max(32), createdAt: z.string(), updatedAt: z.string() });
export const ProfileListResponseSchema = z.object({ profiles: z.array(ProfileResponseSchema) });
export const AdminCapacityListResponseSchema = z.object({ lanes: z.array(AdminCapacityLaneSchema) });
export const ModelResponseSchema = z.object({ id: z.string(), provider: ProviderIdSchema, providerLabel: z.string(), displayName: z.string() });
export const ModelListResponseSchema = z.object({ models: z.array(ModelResponseSchema) });
export const ProjectCheckListResponseSchema = z.object({ checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().optional() })) });
export const ProjectRepositoryDefaultsResponseSchema = z.object({ setupCommand: z.string(), verificationCommand: z.string() });
export const ProjectResponseSchema = z.object({
  id: z.string(), companyId: z.string(), name: z.string(), repositoryPath: z.string(), worktreeRoot: z.string(), repository: z.string().optional(), baseBranch: z.string(), targetBranch: z.string(), setupCommand: z.string(), verificationCommand: z.string(), requiredChecks: z.array(z.string()), roleDefaults: ProjectRoleDefaultsSchema, createdAt: z.string(), updatedAt: z.string(),
});
export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectResponseSchema) });
export const TaskSourceQuerySchema = z.object({ kind: z.enum(["pull_request", "branch"]) });
const PullRequestTaskSourceSchema = z.object({ kind: z.literal("pull_request"), number: z.number().int().positive(), url: z.string().url(), title: z.string(), body: z.string(), author: z.string(), headBranch: z.string(), baseBranch: z.string(), headSha: z.string(), updatedAt: z.string().optional(), isDraft: z.boolean() });
const BranchTaskSourceSchema = z.object({ kind: z.literal("branch"), branch: z.string(), headSha: z.string(), subject: z.string(), author: z.string(), updatedAt: z.string() });
export const TaskSourceListResponseSchema = z.object({ available: z.boolean(), reason: z.string().optional(), sources: z.array(z.discriminatedUnion("kind", [PullRequestTaskSourceSchema, BranchTaskSourceSchema])) });
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export type ProjectCheckResponse = z.infer<typeof ProjectCheckListResponseSchema>["checks"][number];
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
