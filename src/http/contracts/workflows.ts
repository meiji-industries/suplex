import { z } from "zod";
import { DeliveryTargetSchema, VisualEvidenceSchema } from "../../tasks/contracts.js";
import { AdvisorProfileIdsSchema, WorkflowIdSchema } from "../../coordination/workflows.js";

// A workflow record is a named, editable preset over one built-in engine: default agents and delivery settings the task dialog applies.
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
// A patch carries no defaults; null clears an optional setting.
export const WorkflowRecordPatchSchema = z.object({
  name: name.optional(),
  description: z.string().trim().optional(),
  engine: WorkflowIdSchema.optional(),
  rootProfileId: profileId.nullable().optional(),
  workerProfileId: profileId.nullable().optional(),
  advisorProfileIds: AdvisorProfileIdsSchema.optional(),
  deliveryTarget: DeliveryTargetSchema.nullable().optional(),
  runProjectTests: z.boolean().nullable().optional(),
  visualEvidence: VisualEvidenceSchema.nullable().optional(),
  archived: z.boolean().optional(),
}).strict();
export type WorkflowRecordPatch = z.input<typeof WorkflowRecordPatchSchema>;
export const WorkflowRecordSchema = WorkflowRecordInputSchema.extend({ id: z.string(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });
export type WorkflowRecord = z.infer<typeof WorkflowRecordSchema>;
export const WorkflowRecordParamsSchema = z.object({ workflowId: z.string().min(1) });
export const WorkflowListQuerySchema = z.object({ includeArchived: z.literal("true").optional() }).strict();
export const WorkflowListResponseSchema = z.object({ workflows: z.array(WorkflowRecordSchema) });
