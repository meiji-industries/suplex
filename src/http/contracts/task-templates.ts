import { z } from "zod";
import { DeliveryTargetSchema, TaskInputSchema, VisualEvidenceSchema } from "../../tasks/contracts.js";
import { AdvisorProfileIdsSchema, WorkflowIdSchema } from "../../coordination/workflows.js";

export const TaskTemplateParamsSchema = z.object({ templateId: z.string().min(1) });
export const ProjectTaskTemplatesParamsSchema = z.object({ projectId: z.string().min(1) });
export const SaveTaskAsTemplateParamsSchema = z.object({ taskId: z.string().min(1) });
export const SaveTaskAsTemplateBodySchema = z.object({ name: z.string().trim().min(1) }).strict();
export const CreateTaskTemplateBodySchema = TaskInputSchema.pick({ description: true, rootProfileId: true, workerProfileId: true, deliveryTarget: true, runProjectTests: true, visualEvidence: true, workflow: true, advisorProfileIds: true }).extend({ name: SaveTaskAsTemplateBodySchema.shape.name }).strict();
// A patch carries no defaults: the service merges it with the stored template first.
export const UpdateTaskTemplateBodySchema = z.object({
  name: SaveTaskAsTemplateBodySchema.shape.name.optional(),
  description: z.string().trim().min(1).optional(),
  rootProfileId: z.string().min(1).nullable().optional(),
  workerProfileId: z.string().min(1).nullable().optional(),
  deliveryTarget: DeliveryTargetSchema.optional(),
  runProjectTests: z.boolean().optional(),
  visualEvidence: VisualEvidenceSchema.optional(),
  workflow: WorkflowIdSchema.optional(),
  advisorProfileIds: AdvisorProfileIdsSchema.optional(),
}).strict();
export const TaskTemplateResponseSchema = CreateTaskTemplateBodySchema.extend({ id: z.string(), projectId: z.string(), createdAt: z.string(), updatedAt: z.string() });
export const TaskTemplateListResponseSchema = z.object({ templates: z.array(TaskTemplateResponseSchema) });
export type TaskTemplateResponse = z.infer<typeof TaskTemplateResponseSchema>;
