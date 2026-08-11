import { z } from "zod";

const TaskPhaseSchema = z.string();
const RoleProfilesSchema = z.object({ lead: z.string().optional(), developer: z.string().optional(), reviewer: z.string().optional() });
const TaskImageResponseSchema = z.object({ artifactId: z.string(), filename: z.string(), mimeType: z.string(), byteSize: z.number() });
const TimelineResponseSchema = z.object({ id: z.string(), revision: z.number(), eventType: z.string(), metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), createdAt: z.string() });

export const TaskImageBodySchema = z.object({ filename: z.string(), mimeType: z.string(), base64: z.string() });
export const TaskBodySchema = z.object({
  projectId: z.string().default(""),
  title: z.string().default(""),
  description: z.string().default(""),
  idempotencyKey: z.string().default(""),
  images: z.array(TaskImageBodySchema).default([]),
  roleProfiles: RoleProfilesSchema.optional(),
  supplementalReview: z.boolean().default(false),
});

export const TaskResponseSchema = z.object({
  id: z.string(), companyId: z.string(), projectId: z.string(), title: z.string(), description: z.string(), briefArtifactId: z.string(), images: z.array(TaskImageResponseSchema), roleProfiles: RoleProfilesSchema, supplementalReview: z.boolean(), workflowId: z.string(), projectRevisionId: z.string(), phase: TaskPhaseSchema, revision: z.number(), owner: z.enum(["human", "lead"]), allowedCommands: z.array(z.string()), pendingAction: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), timeline: z.array(TimelineResponseSchema), planRevision: z.number().nullable().optional(), planMaterial: z.boolean().nullable().optional(), materialCategories: z.array(z.string()).optional(), supplementalReviewUsed: z.boolean().optional(), supplementalReviewArtifactId: z.string().nullable().optional(), decisionId: z.string().nullable().optional(), deliveryDecisionArtifactId: z.string().nullable().optional(), predecessorTaskId: z.string().nullable().optional(), successorTaskId: z.string().nullable().optional(), deliveryReview: z.unknown().optional(), developerExecution: z.unknown().optional(), leadOutput: z.unknown().optional(),
});
export const TaskListResponseSchema = z.object({ tasks: z.array(TaskResponseSchema) });
export const ContinueWorkResponseSchema = z.object({ original: TaskResponseSchema, successor: TaskResponseSchema });
export const ImageResponseSchema = z.object({ artifactId: z.string(), filename: z.string(), mimeType: z.string(), byteSize: z.number() });
