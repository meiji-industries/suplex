import { z } from "zod";

import { WorkflowIdSchema, AdvisorProfileIdsSchema } from "./workflows.js";

import { DeliveryTargetSchema, VisualEvidenceSchema } from "./tasks.js";

const name = z.string().trim().min(1).max(80);

const profileId = z.string().min(1);

export const WorkflowRecordInputSchema = z.object({
  name,
  description: z.string().trim().default(""),
  engine: WorkflowIdSchema,
  rootProfileId: profileId.optional(),
  workerProfileId: profileId.optional(),
  advisorProfileIds: AdvisorProfileIdsSchema.default({}),
  deliveryTarget: DeliveryTargetSchema.optional(),
  runProjectTests: z.boolean().optional(),
  visualEvidence: VisualEvidenceSchema.optional(),
}).strict();

export type WorkflowRecordInput = z.input<typeof WorkflowRecordInputSchema>;

export const WorkflowRecordSchema = WorkflowRecordInputSchema.extend({ id: z.string(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });

export type WorkflowRecord = z.infer<typeof WorkflowRecordSchema>;
