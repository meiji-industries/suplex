import { z } from "zod";
import { ActiveOperationSchema, IssueBlockerSchema, IssueCommandSchema, IssuePhaseSchema, durableId } from "../primitives.js";

export const lifecycleStateFields = {
  phase: IssuePhaseSchema,
  revision: z.number().int().nonnegative(),
  owner: z.enum(["human", "lead"]),
  allowedCommands: z.array(IssueCommandSchema),
  pendingAction: z.string().max(200).nullable(),
  blockerCode: z.string().max(128).nullable().optional(),
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  blocker: IssueBlockerSchema.nullable().optional(),
  stateChangedAt: z.string().datetime().optional(),
  activeOperation: ActiveOperationSchema.optional(),
  processedCommandIds: z.array(durableId).max(64).optional(),
  // Appended last: workflow-state field order is part of the persisted contract.
  lastHandlerError: z.object({ command: z.string().max(128), reason: z.string().max(256), at: z.string().datetime() }).nullable().optional(),
};
