import { z } from "zod";

import { DeveloperContextSchema, PlanStepVerificationSchema } from "./developer-contracts.js";
import { GitPresentationSchema } from "./git-presentation.js";
import { type PlanBlockerSubject, type PlanSubject } from "./plan-governance.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const LeadPlanStepSchema = z.object({
  number: z.number().int().positive(),
  instruction: z.string().min(1),
  entryPoint: z.string().min(1).nullable().default(null),
  completionCriterion: z.string().min(1).nullable().default(null),
  verification: z.string().min(1),
  verificationCommands: z.array(PlanStepVerificationSchema.shape.commands.element).default([]),
}).strict();

export const ContiguousLeadStepsSchema = z.array(LeadPlanStepSchema)
  .min(1)
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
  summary: z.string().min(1),
  gitPresentation: GitPresentationSchema,
  reproduction: z.string().nullable(),
  rootCauseAnalysis: z.string().nullable(),
  steps: ContiguousLeadStepsSchema,
  compatibilityAnalysis: z.string().min(1),
  operationalAnalysis: z.string().min(1),
  verificationStrategy: z.string().min(1),
  unresolvedTechnicalQuestions: z.array(z.string()).length(0),
  preservedWorktreeCompatibility: z.boolean().nullable().default(null),
  affectedPaths: z.array(z.string().min(1)).optional(),
  developerContext: DeveloperContextSchema.default({
    includeTaskBrief: false,
    evidenceArtifactIds: [],
    imageArtifactIds: [],
    repositoryInstructionPaths: [],
    artifactStepNumbers: {},
  }),
}).strict();

export const AskUserQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const AskUserQuestionSchema = z.object({
  header: z.string().min(1),
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  question: z.string().min(1),
  options: z.array(AskUserQuestionOptionSchema).min(1).max(3),
  isOther: z.literal(true),
  isSecret: z.literal(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.options.map((option) => option.label)).size !== value.options.length) context.addIssue({ code: "custom", path: ["options"], message: "Question option labels must be unique" });
});

const decisionBlockerShape = {
  kind: z.literal("decision_blocker"),
  category: z.literal("human_decision").default("human_decision"),
  summary: z.string().min(1),
  evidence: z.string().min(1),
  owner: z.literal("human"),
  nextAction: z.string().min(1),
  resumePhase: z.literal("planning").default("planning"),
};

export const DecisionBlockerSchema = z.object({ ...decisionBlockerShape, askUserQuestion: AskUserQuestionSchema }).strict();

export const LeadOutputSchema = z.discriminatedUnion("kind", [LeadPlanSchema, DecisionBlockerSchema]);
export const LeadOutputJsonSchema = z.toJSONSchema(LeadOutputSchema);

const PersistedLegacyLeadPlanSchema = z.object({
  ...LeadPlanSchema.shape,
  gitPresentation: GitPresentationSchema.nullable().default(null),
}).strip();

const PersistedLegacyDecisionBlockerSchema = z.object({ ...decisionBlockerShape, question: z.string().min(1) }).strict();

export const PersistedLeadOutputSchema = z.union([LeadOutputSchema, PersistedLegacyLeadPlanSchema, PersistedLegacyDecisionBlockerSchema]);
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
  // Structured clone of our own object; this file is part of the legacy workflow service workflow bundle and must not import node modules.
  // eslint-disable-next-line no-restricted-syntax
  const schemaObject = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  if (name === "developerContext") {
    const contextSchema = schemaObject as { properties?: Record<string, unknown> };
    if (contextSchema.properties) contextSchema.properties.artifactStepNumbers = {
      type: "array",
      items: {
        type: "object",
        properties: {
          artifactIdOrPath: { type: "string", minLength: 1 },
          stepNumbers: { type: "array", items: { type: "integer", minimum: 1 } },
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
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;
export type DecisionBlocker = z.infer<typeof DecisionBlockerSchema>;
export type LeadOutput = z.infer<typeof LeadOutputSchema>;
export type PersistedLeadOutput = z.infer<typeof PersistedLeadOutputSchema>;

export const LeadSessionRefSchema = durableId;

export const LeadResumeDescriptorSchema = z.object({
  leadSessionRef: durableId,
  reason: z.enum(["member_revision", "decision_resolution"]),
  instructionArtifactId: durableId,
  /** Legacy workflow payload compatibility; ignored. */
  instructionSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const LeadPlanningActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  imageArtifactIds: z.array(durableId).max(32),
  roleProfiles: z.object({ planner: durableId.optional(), builder: durableId.optional(), reviewer: durableId.optional(), integrator: durableId.optional() }),
  revision: z.number().int().nonnegative(),
  resume: LeadResumeDescriptorSchema.optional(),
  revisionRequestId: durableId.optional(),
  resumeLeadSessionRef: durableId.optional(),
  capacityRequestId: durableId.optional(),
  leadSessionRef: durableId.optional(),
  revisionNoteArtifactId: durableId.optional(),
  memberResponseArtifactId: durableId.optional(),
  operatorNotes: z.array(z.string().trim().min(1).max(8_000)).max(32).optional(),
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
  /** Historical activity-result compatibility; ignored by current workflows. */
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
  blockerSubject?: PlanBlockerSubject;
  leadReviewResponseArtifactId?: string;
  leadReviewResponseArtifactSha256?: string;
}

export type LegacyLeadPlanningResult = LeadPlanningResult;
