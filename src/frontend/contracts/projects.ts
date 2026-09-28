import { z } from "zod";

import { HarnessKindSchema } from "./harness-kind.js";

import { ProviderSummarySchema, ProviderInstanceSchema } from "./providers.js";

import { AgentProfileSchema } from "./profiles.js";

import { ProjectIntegrationSchema } from "./project-integration.js";

import { ProjectExecutionSchema } from "./project-execution.js";

import { DeliveryTargetSchema, VisualEvidenceSchema } from "./tasks.js";

import { ProjectProviderPolicySchema } from "./provider-policy.js";

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
  altProfileId: z.string().min(1).optional(),
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

export const ProjectResponseSchema = ProjectBodySchema.extend({
  id: z.string(), companyId: z.string(), repository: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
}).strip();

export const ProjectProviderInstanceSchema = ProviderInstanceSchema.pick({ id: true, provider: true, label: true });

export const ProfileResponseSchema = AgentProfileSchema.strip();

export const ModelResponseSchema = z.object({ id: z.string(), provider: HarnessKindSchema, providerLabel: z.string(), providerStatus: ProviderSummarySchema.shape.status, displayName: z.string() });

export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

export type ModelResponse = z.infer<typeof ModelResponseSchema>;

export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export type ProjectPatchBody = z.infer<typeof ProjectPatchBodySchema>;

export type ProjectProviderInstance = z.infer<typeof ProjectProviderInstanceSchema>;

export const ProjectRepositoryStatusSchema = z.object({
  status: z.enum(["connected", "sign_in_required", "needs_repair", "unavailable"]),
  message: z.string(),
  method: z.enum(["device", "cli"]),
  originRepository: z.string().nullable(),
  login: z.string().nullable().optional(),
});

export type ProjectRepositoryStatus = z.infer<typeof ProjectRepositoryStatusSchema>;
