import { SupplementalReviewSubjectSchema } from "../../../plan-governance.js";
import { IssueLeadOutputKindSchema, SafeSummarySchema, durableId } from "../primitives.js";

export const planningStateFields = {
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadInputManifestArtifactId: durableId.nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: SafeSummarySchema.nullable().optional(),
  supplementalReviewSubject: SupplementalReviewSubjectSchema.nullable().optional(),
};
