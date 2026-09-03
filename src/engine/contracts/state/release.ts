import { z } from "zod";
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
  releaseFailureSummary: z.string().max(500).nullable().optional(),
  releaseRetryAt: z.string().datetime().nullable().optional(),
  releaseOperationAttempt: z.number().int().nonnegative().nullable().optional(),
};

// Appended: workflow state serialization order is a compatibility boundary.
export const releaseObservationStateFields = {
  githubObservedAt: z.string().datetime().nullable().optional(),
  githubPullRequestExists: z.boolean().nullable().optional(),
  githubPullRequestState: z.enum(["open", "closed", "merged"]).nullable().optional(),
  githubPullRequestDraft: z.boolean().nullable().optional(),
  githubPullRequestChecks: z.object({ total: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), failing: z.number().int().nonnegative(), successful: z.number().int().nonnegative() }).nullable().optional(),
  githubPullRequestReviewDecision: z.string().max(128).nullable().optional(),
  githubPullRequestAutoMergeEnabled: z.boolean().nullable().optional(),
  githubPullRequestObservationKey: z.string().max(512).nullable().optional(),
  githubPullRequestMergeable: z.string().max(128).nullable().optional(),
  githubPullRequestAuthor: z.object({ login: z.string().max(256), avatarUrl: z.string().url().max(2_000) }).nullable().optional(),
  githubPullRequestChangedFiles: z.number().int().nonnegative().nullable().optional(),
  githubPullRequestAdditions: z.number().int().nonnegative().nullable().optional(),
  githubPullRequestDeletions: z.number().int().nonnegative().nullable().optional(),
  autoMergeAvailable: z.boolean().nullable().optional(),
};
