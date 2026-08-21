import { z } from "zod";
import { ReleaseFailureCodeSchema } from "../../../release-failures.js";
import { durableId } from "../primitives.js";

export const releaseStateFields = {
  releaseId: durableId.nullable().optional(),
  releaseRepository: z.string().max(256).nullable().optional(),
  baseBranch: z.string().max(256).nullable().optional(),
  pullRequestNumber: z.number().int().positive().nullable().optional(),
  pullRequestUrl: z.string().url().max(2_000).nullable().optional(),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  expectedHeadTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
};

export const releaseStateFields2 = {
  releaseStatus: z.enum(["reconciling", "draft", "blocked", "ready"]).nullable().optional(),
  releaseFailureCode: ReleaseFailureCodeSchema.nullable().optional(),
  releaseFailureSummary: z.string().max(500).nullable().optional(),
  releaseRetryAt: z.string().datetime().nullable().optional(),
  releaseOperationAttempt: z.number().int().nonnegative().nullable().optional(),
};
