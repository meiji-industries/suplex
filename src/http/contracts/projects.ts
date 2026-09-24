import { z } from "zod";
import { ProjectIntegrationSchema } from "../../projects/integration-configuration.js";
import { ProjectExecutionSchema } from "../../projects/execution-configuration.js";
import { ProjectProviderPolicySchema } from "../../projects/provider-policy.js";
import { HarnessKindSchema } from "../../runtimes/harness-kind.js";
import { AgentProfileInputSchema, AgentProfilePatchSchema, AgentProfileSchema } from "../../profiles/agent-profile-contracts.js";
import { ProviderInstanceSchema, ProviderSummarySchema } from "./providers.js";
import { DeliveryTargetSchema, VisualEvidenceSchema } from "../../tasks/contracts.js";

const profileId = z.string().min(1).max(256);
export const ProjectAgentTaskPolicySchema = z.object({
  workflowIds: z.array(profileId).min(1),
  defaultWorkflowId: profileId,
  templateIds: z.array(profileId).default([]),
  rootProfileIds: z.array(profileId).min(1),
  workerProfileIds: z.array(profileId).min(1),
  advisorProfileIds: z.object({
    reviewer: z.array(profileId).default([]),
    planner_a: z.array(profileId).default([]),
    planner_b: z.array(profileId).default([]),
    rater: z.array(profileId).default([]),
  }).default({ reviewer: [], planner_a: [], planner_b: [], rater: [] }),
  deliveryTarget: DeliveryTargetSchema.default("pull_request_draft"),
  runProjectTests: z.boolean().default(true),
  visualEvidence: VisualEvidenceSchema.default("off"),
}).strict();
export type ProjectAgentTaskPolicy = z.infer<typeof ProjectAgentTaskPolicySchema>;

export const ProjectBodySchema = z.object({
  integration: ProjectIntegrationSchema.optional(),
  execution: ProjectExecutionSchema.optional(),
  name: z.string().min(1),
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  setupCommand: z.string(),
  verificationCommand: z.string(),
  rootProfileId: z.string().min(1),
  workerProfileId: z.string().min(1),
  agentTaskPolicy: ProjectAgentTaskPolicySchema.optional(),
  providerPolicy: ProjectProviderPolicySchema.nullable().optional(),
}).strict();
export const ProjectPatchBodySchema = ProjectBodySchema.partial().extend({
  execution: z.object({
    instructions: ProjectExecutionSchema.shape.instructions.removeDefault().optional(),
    skillDirectories: ProjectExecutionSchema.shape.skillDirectories.removeDefault().optional(),
    environment: ProjectExecutionSchema.shape.environment.removeDefault().optional(),
    mcp: ProjectExecutionSchema.shape.mcp.removeDefault().optional(),
  }).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one project field");
export const ProjectRepositoryBodySchema = z.object({ repositoryUrl: z.string().min(1), integration: ProjectIntegrationSchema.optional(), baseBranch: z.string().min(1).optional() }).strict();
export const ProjectNewRepositoryBodySchema = z.object({ repositoryName: z.string().min(1).max(200), integration: ProjectIntegrationSchema.optional(), baseBranch: z.string().min(1).optional() }).strict();
export const ProjectCreateBodySchema = z.union([ProjectRepositoryBodySchema, ProjectNewRepositoryBodySchema, ProjectBodySchema]);
export const ProjectResponseSchema = ProjectBodySchema.extend({
  id: z.string(), companyId: z.string(), repository: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
}).strip();
export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectResponseSchema) });
export const ProjectRepositoryDefaultsResponseSchema = z.object({ setupCommand: z.string(), verificationCommand: z.string() });
export const ProjectProviderInstanceSchema = ProviderInstanceSchema.pick({ id: true, provider: true, label: true });
export const ProjectProviderInstanceListResponseSchema = z.object({ instances: z.array(ProjectProviderInstanceSchema) });
export const ProfileBodySchema = AgentProfileInputSchema;
export const ProfilePatchBodySchema = AgentProfilePatchSchema;
export const ProfileListQuerySchema = z.object({ includeArchived: z.literal("true").optional() }).strict();
export const ProfileResponseSchema = AgentProfileSchema.strip();
export const ProfileListResponseSchema = z.object({ profiles: z.array(ProfileResponseSchema) });
export const ModelResponseSchema = z.object({ id: z.string(), provider: HarnessKindSchema, providerLabel: z.string(), providerStatus: ProviderSummarySchema.shape.status, displayName: z.string() });
export const ModelListResponseSchema = z.object({ models: z.array(ModelResponseSchema) });
export const TaskSourceQuerySchema = z.object({ kind: z.enum(["pull_request", "issue", "branch"]) });
const PullRequestTaskSourceSchema = z.object({ kind: z.literal("pull_request"), number: z.number().int().positive(), url: z.string().url(), title: z.string(), body: z.string(), author: z.string(), headBranch: z.string(), baseBranch: z.string(), headSha: z.string(), updatedAt: z.string().optional(), isDraft: z.boolean() });
const IssueTaskSourceSchema = z.object({ kind: z.literal("issue"), number: z.number().int().positive(), url: z.string().url(), title: z.string(), body: z.string(), author: z.string(), updatedAt: z.string() });
const BranchTaskSourceSchema = z.object({ kind: z.literal("branch"), branch: z.string(), headSha: z.string(), subject: z.string(), author: z.string(), updatedAt: z.string() });
export const TaskSourceListResponseSchema = z.object({ available: z.boolean(), reason: z.string().optional(), sources: z.array(z.discriminatedUnion("kind", [PullRequestTaskSourceSchema, IssueTaskSourceSchema, BranchTaskSourceSchema])) });

export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
export type ProjectPatchBody = z.infer<typeof ProjectPatchBodySchema>;
export type ProjectProviderInstance = z.infer<typeof ProjectProviderInstanceSchema>;
