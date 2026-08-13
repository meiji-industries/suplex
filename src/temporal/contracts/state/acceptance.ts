import { z } from "zod";
import { durableId } from "../primitives.js";

export const acceptanceStateFields = {
  acceptanceId: durableId.nullable().optional(),
  acceptanceStatus: z.enum(["pending_ready", "accepted", "requested_changes", "cancelled", "blocked"]).nullable().optional(),
  acceptanceAttempt: z.number().int().nonnegative().optional(),
  acceptanceRetryAt: z.string().datetime().nullable().optional(),
  acceptanceBlockerCode: durableId.nullable().optional(),
  acceptanceBlockerEvidenceArtifactId: durableId.nullable().optional(),
  acceptanceReasonArtifactId: durableId.nullable().optional(),
  acceptedAt: z.string().datetime().nullable().optional(),
  readyAt: z.string().datetime().nullable().optional(),
  acceptedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
};
