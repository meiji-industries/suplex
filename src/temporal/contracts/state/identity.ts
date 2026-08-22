import { z } from "zod";
import { durableId } from "../primitives.js";

export const identityStateFields = {
  workflowId: durableId,
  companyId: durableId,
  projectId: durableId,
  issueId: durableId,
  projectRevisionId: durableId,
  /** Historical compatibility only; ignored after deserialization. */
  requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
};
