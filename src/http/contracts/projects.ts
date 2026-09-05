import { z } from "zod";
import { AgentProfileInputSchema, AgentProfilePatchSchema, AgentProfileSchema } from "../../agent-profile-contracts.js";

export const ProjectBodySchema = z.object({
  name: z.string().min(1),
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  setupCommand: z.string(),
  verificationCommand: z.string(),
  rootProfileId: z.string().min(1),
  workerProfileId: z.string().min(1),
}).strict();
export const ProjectRepositoryBodySchema = z.object({ repositoryUrl: z.string().min(1) }).strict();
export const ProjectCreateBodySchema = z.union([ProjectRepositoryBodySchema, ProjectBodySchema]);
export const ProjectResponseSchema = ProjectBodySchema.extend({
  id: z.string(), companyId: z.string(), repository: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
}).strip();
export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectResponseSchema) });
export const ProjectRepositoryDefaultsResponseSchema = z.object({ setupCommand: z.string(), verificationCommand: z.string() });
export const ProfileBodySchema = AgentProfileInputSchema;
export const ProfilePatchBodySchema = AgentProfilePatchSchema;
export const ProfileListQuerySchema = z.object({ includeArchived: z.literal("true").optional() }).strict();
export const ProfileResponseSchema = AgentProfileSchema.strip();
export const ProfileListResponseSchema = z.object({ profiles: z.array(ProfileResponseSchema) });
export const ModelResponseSchema = z.object({ id: z.string(), provider: z.string(), providerLabel: z.string(), displayName: z.string() });
export const ModelListResponseSchema = z.object({ models: z.array(ModelResponseSchema) });
export const TaskSourceQuerySchema = z.object({ kind: z.enum(["pull_request", "branch"]) });
const PullRequestTaskSourceSchema = z.object({ kind: z.literal("pull_request"), number: z.number().int().positive(), url: z.string().url(), title: z.string(), body: z.string(), author: z.string(), headBranch: z.string(), baseBranch: z.string(), headSha: z.string(), updatedAt: z.string().optional(), isDraft: z.boolean() });
const BranchTaskSourceSchema = z.object({ kind: z.literal("branch"), branch: z.string(), headSha: z.string(), subject: z.string(), author: z.string(), updatedAt: z.string() });
export const TaskSourceListResponseSchema = z.object({ available: z.boolean(), reason: z.string().optional(), sources: z.array(z.discriminatedUnion("kind", [PullRequestTaskSourceSchema, BranchTaskSourceSchema])) });

export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
