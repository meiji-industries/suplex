import { z } from "zod";

import { DeveloperContextSchema, PlanStepVerificationSchema } from "./developer-contracts.js";
import {
  PlanMaterialCategorySchema,
  canonicalMaterialCategories,
  validateAffectedPaths,
  validateMaterialityEvidence,
  type MaterialityEvidenceSubject,
  type PlanBlockerSubject,
  type PlanMaterialCategory,
  type PlanSubject,
} from "./plan-governance.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const LeadPlanStepSchema = z.object({
  number: z.number().int().positive(),
  instruction: z.string().min(1).max(4_000),
  entryPoint: z.string().min(1).max(1_000).nullable().default(null),
  completionCriterion: z.string().min(1).max(4_000).nullable().default(null),
  verification: z.string().min(1).max(4_000),
  verificationCommands: z.array(PlanStepVerificationSchema.shape.commands.element).max(32).default([]),
}).strict();

export const ContiguousLeadStepsSchema = z.array(LeadPlanStepSchema)
  .min(1)
  .max(64)
  .superRefine((steps, context) => {
    for (const [index, step] of steps.entries()) {
      if (step.number !== index + 1) {
        context.addIssue({
          code: "custom",
          path: [index, "number"],
          message: `Expected step ${index + 1}`,
        });
      }
    }
  });

export const LeadPlanSchema = z.object({
  kind: z.literal("plan"),
  summary: z.string().min(1).max(2_000),
  reproduction: z.string().max(20_000).nullable(),
  rootCauseAnalysis: z.string().max(20_000).nullable(),
  steps: ContiguousLeadStepsSchema,
  compatibilityAnalysis: z.string().min(1).max(20_000),
  operationalAnalysis: z.string().min(1).max(20_000),
  verificationStrategy: z.string().min(1).max(20_000),
  unresolvedTechnicalQuestions: z.array(z.string().max(2_000)).length(0),
  materialCategories: z.array(PlanMaterialCategorySchema).max(6),
  preservedWorktreeCompatibility: z.boolean().nullable().default(null),
  affectedPaths: z.array(z.string().min(1).max(1_000)).min(1).max(128),
  materiality: z.array(z.object({
    category: PlanMaterialCategorySchema,
    rationale: z.string().min(1).max(500),
    evidenceRefs: z.array(z.string().min(1).max(1_000)).min(1).max(8),
  }).strict()).max(6),
  developerContext: DeveloperContextSchema.default({
    includeTaskBrief: false,
    evidenceArtifactIds: [],
    imageArtifactIds: [],
    repositoryInstructionPaths: [],
    artifactStepNumbers: {},
  }),
}).strict().superRefine((value, context) => {
  const stepNumbers = value.steps.map((step) => step.number);
  try {
    const affectedPaths = validateAffectedPaths(value.affectedPaths);
    const materiality = value.materiality.length
      ? value.materiality
      : value.materialCategories.map((category) => ({ category, rationale: "Lead-declared material category", evidenceRefs: ["step:1"] }));
    validateMaterialityEvidence({ affectedPaths, categories: materiality, stepNumbers });
  } catch (error) {
    context.addIssue({ code: "custom", path: ["materiality"], message: error instanceof Error ? error.message : "Materiality evidence is invalid" });
  }
  if (JSON.stringify(canonicalMaterialCategories(value.materialCategories)) !== JSON.stringify(value.materialCategories)) {
    context.addIssue({ code: "custom", path: ["materialCategories"], message: "Material categories must use canonical order" });
  }
});

export const DecisionBlockerSchema = z.object({
  kind: z.literal("decision_blocker"),
  category: z.literal("human_decision").default("human_decision"),
  summary: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(10_000),
  owner: z.literal("human"),
  question: z.string().min(1).max(4_000),
  nextAction: z.string().min(1).max(4_000),
  resumePhase: z.literal("planning").default("planning"),
}).strict();

export const LeadOutputSchema = z.discriminatedUnion("kind", [LeadPlanSchema, DecisionBlockerSchema]);
export const LeadOutputJsonSchema = z.toJSONSchema(LeadOutputSchema);

// Lead plans are persisted as immutable artifacts. Plans written before exact
// plan authority did not record repository paths or materiality evidence, so
// projection readers must be able to display those historical artifacts after
// an upgrade. New provider output continues to use LeadOutputSchema above.
const PersistedLegacyLeadPlanSchema = z.object({
  ...LeadPlanSchema.shape,
  affectedPaths: z.array(z.string().min(1).max(1_000)).max(128).default([]),
  materiality: z.array(z.object({
    category: PlanMaterialCategorySchema,
    rationale: z.string().min(1).max(500),
    evidenceRefs: z.array(z.string().min(1).max(1_000)).min(1).max(8),
  }).strict()).max(6).default([]),
}).strict().superRefine((value, context) => {
  if (value.affectedPaths.length || value.materiality.length) {
    context.addIssue({ code: "custom", message: "Legacy persisted plans may only omit affected paths and materiality evidence" });
  }
});

export const PersistedLeadOutputSchema = z.union([LeadOutputSchema, PersistedLegacyLeadPlanSchema]);
const generatedLeadOutputJsonSchema = LeadOutputJsonSchema as { oneOf?: Array<Record<string, unknown>> } & Record<string, unknown>;
const leadOutputVariants = generatedLeadOutputJsonSchema.oneOf ?? [];
const leadOutputPropertyEntries = new Map<string, unknown>();
const sharedLeadOutputProperties = new Set<string>();
for (const variant of leadOutputVariants) {
  const properties = (variant.properties as Record<string, unknown> | undefined) ?? {};
  for (const [name, schema] of Object.entries(properties)) {
    if (!leadOutputPropertyEntries.has(name)) leadOutputPropertyEntries.set(name, schema);
    if (leadOutputVariants.every((candidate) => Object.prototype.hasOwnProperty.call(candidate.properties, name))) sharedLeadOutputProperties.add(name);
  }
}
const leadOutputProperties = Object.fromEntries([...leadOutputPropertyEntries.entries()].map(([name, schema]) => {
  if (name === "kind") return [name, { type: "string", enum: ["plan", "decision_blocker"] }];
  const schemaObject = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  if (name === "developerContext") {
    const contextSchema = schemaObject as { properties?: Record<string, unknown> };
    if (contextSchema.properties) contextSchema.properties.artifactStepNumbers = {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          artifactIdOrPath: { type: "string", minLength: 1, maxLength: 1_000 },
          stepNumbers: { type: "array", maxItems: 64, items: { type: "integer", minimum: 1 } },
        },
        required: ["artifactIdOrPath", "stepNumbers"],
        additionalProperties: false,
      },
    };
  }
  return [name, sharedLeadOutputProperties.has(name) ? schemaObject : { anyOf: [schemaObject, { type: "null" }] }];
}));
// Codex structured outputs requires a plain object at the root and rejects a
// root union. Keep the canonical Zod discriminated union as the strict runtime
// gate, while presenting the provider with the same closed set of fields.
export const CodexLeadOutputJsonSchema = {
  type: "object",
  properties: leadOutputProperties,
  required: [...leadOutputPropertyEntries.keys()],
  additionalProperties: false,
};

export type LeadPlan = z.infer<typeof LeadPlanSchema>;
export type DecisionBlocker = z.infer<typeof DecisionBlockerSchema>;
export type LeadOutput = z.infer<typeof LeadOutputSchema>;
export type PersistedLeadOutput = z.infer<typeof PersistedLeadOutputSchema>;

export const LeadSessionRefSchema = durableId;

export const LeadResumeDescriptorSchema = z.object({
  leadSessionRef: durableId,
  reason: z.enum(["member_revision", "decision_resolution"]),
  instructionArtifactId: durableId,
  instructionSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const LeadPlanningActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  imageArtifactIds: z.array(durableId).max(32),
  roleProfiles: z.object({ lead: durableId.optional(), developer: durableId.optional(), reviewer: durableId.optional() }),
  revision: z.number().int().nonnegative(),
  resume: LeadResumeDescriptorSchema.optional(),
  revisionRequestId: durableId.optional(),
  resumeLeadSessionRef: durableId.optional(),
  capacityRequestId: durableId.optional(),
  leadSessionRef: durableId.optional(),
  revisionNoteArtifactId: durableId.optional(),
  revisionNoteSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  memberResponseArtifactId: durableId.optional(),
  memberResponseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type LeadPlanningActivityInput = z.infer<typeof LeadPlanningActivityInputSchema>;

export interface LeadPlanningResult {
  kind?: "plan" | "decision_blocker";
  leadSessionRef: string;
  leadExecutionId: string;
  leadEvidenceArtifactId: string;
  leadOutputArtifactId: string;
  leadOutputKind: "plan" | "decision_blocker";
  leadSummary: string;
  materialCategories: PlanMaterialCategory[];
  material: boolean;
  leadEvidenceArtifactSha256?: string;
  leadOutputArtifactSha256?: string;
  leadEvidenceSha256?: string;
  leadOutputSha256?: string;
  leadInputManifestArtifactId?: string;
  leadInputManifestSha256?: string;
  blockedCategory?: "human_decision";
  unblockOwner?: "human";
  resumePhase?: "planning";
  preservedWorktreeCompatibility?: boolean | null;
  planSubject?: PlanSubject;
  materialityEvidence?: MaterialityEvidenceSubject;
  blockerSubject?: PlanBlockerSubject;
  leadReviewResponseArtifactId?: string;
  leadReviewResponseArtifactSha256?: string;
}

export type LegacyLeadPlanningResult = LeadPlanningResult;
