import { z } from "zod";
import { MaterialityEvidenceSubjectSchema, PlanSubjectSchema, SupplementalReviewSubjectSchema } from "../../../plan-governance.js";
import { IssueLeadOutputKindSchema, SafeSummarySchema, durableId } from "../primitives.js";

export const planningStateFields = {
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadOutputSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  leadInputManifestArtifactId: durableId.nullable().optional(),
  leadInputManifestSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: SafeSummarySchema.nullable().optional(),
  originalPlanSubject: PlanSubjectSchema.nullable().optional(),
  finalPlanSubject: PlanSubjectSchema.nullable().optional(),
  materialityEvidence: MaterialityEvidenceSubjectSchema.nullable().optional(),
  supplementalReviewSubject: SupplementalReviewSubjectSchema.nullable().optional(),
  supplementalReviewArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
};
