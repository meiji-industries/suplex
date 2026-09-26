import { z } from "zod";

import { TaskInputSchema } from "./tasks.js";

export const SaveTaskAsTemplateBodySchema = z.object({ name: z.string().trim().min(1) }).strict();

export const CreateTaskTemplateBodySchema = TaskInputSchema.pick({ description: true, rootProfileId: true, workerProfileId: true, deliveryTarget: true, runProjectTests: true, visualEvidence: true, workflow: true, advisorProfileIds: true }).extend({ name: SaveTaskAsTemplateBodySchema.shape.name }).strict();

export const TaskTemplateResponseSchema = CreateTaskTemplateBodySchema.extend({ id: z.string(), projectId: z.string(), createdAt: z.string(), updatedAt: z.string() });

export type TaskTemplateResponse = z.infer<typeof TaskTemplateResponseSchema>;

export type TaskTemplateInput = z.input<typeof CreateTaskTemplateBodySchema>;
