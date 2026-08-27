import { z } from "zod";

import { DeliveryTargetSchema, RoleAgentsSchema, VisualEvidenceSchema } from "./tasks.js";

export const TaskTemplateParamsSchema = z.object({ templateId: z.string() });
export const ProjectTaskTemplatesParamsSchema = z.object({ projectId: z.string() });
export const SaveTaskAsTemplateParamsSchema = z.object({ taskId: z.string() });
export const SaveTaskAsTemplateBodySchema = z.object({ name: z.string() });
const TaskTemplateSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pull_request"), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("branch"), branch: z.string().min(1).max(240) }).strict(),
]);
export const TaskTemplateResponseSchema = z.object({
  id: z.string(), projectId: z.string(), name: z.string(), description: z.string(), roleAgents: RoleAgentsSchema,
  supplementalReview: z.boolean(), autoApprovePlan: z.boolean(), deliveryTarget: DeliveryTargetSchema,
  runProjectTests: z.boolean(), visualEvidence: VisualEvidenceSchema, source: TaskTemplateSourceSchema.optional(), createdAt: z.string(),
});
export const TaskTemplateListResponseSchema = z.object({ templates: z.array(TaskTemplateResponseSchema) });
export type TaskTemplateResponse = z.infer<typeof TaskTemplateResponseSchema>;
