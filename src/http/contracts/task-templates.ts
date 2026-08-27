import { z } from "zod";

import { DeliveryTargetSchema, RoleAgentsSchema, VisualEvidenceSchema } from "./tasks.js";

export const TaskTemplateParamsSchema = z.object({ templateId: z.string() });
export const ProjectTaskTemplatesParamsSchema = z.object({ projectId: z.string() });
export const SaveTaskAsTemplateParamsSchema = z.object({ taskId: z.string() });
export const SaveTaskAsTemplateBodySchema = z.object({ name: z.string() });
export const TaskTemplateResponseSchema = z.object({
  id: z.string(), projectId: z.string(), name: z.string(), description: z.string(), roleAgents: RoleAgentsSchema,
  supplementalReview: z.boolean(), autoApprovePlan: z.boolean(), deliveryTarget: DeliveryTargetSchema,
  runProjectTests: z.boolean(), visualEvidence: VisualEvidenceSchema, createdAt: z.string(),
});
export const TaskTemplateListResponseSchema = z.object({ templates: z.array(TaskTemplateResponseSchema) });
export type TaskTemplateResponse = z.infer<typeof TaskTemplateResponseSchema>;
