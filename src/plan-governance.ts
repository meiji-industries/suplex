import { z } from "zod";

export const PlanMaterialCategorySchema = z.enum([
  "architecture_dependencies",
  "schema_data_migration",
  "security_permissions",
  "external_integration",
  "production_operation",
  "user_visible_behavior",
]);

export type PlanMaterialCategory = z.infer<typeof PlanMaterialCategorySchema>;

const GovernanceIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/** Legacy workflow payload compatibility; new code identifies immutable artifacts by ID. */
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const PlanSubjectSchema = z.object({
  companyId: GovernanceIdSchema,
  issueId: GovernanceIdSchema,
  workflowId: GovernanceIdSchema,
  originalPlanRevision: z.number().int().nonnegative(),
  outputId: GovernanceIdSchema,
  outputRevision: z.number().int().nonnegative(),
  finalVersion: z.union([z.literal(1), z.literal(2)]),
  artifactId: GovernanceIdSchema,
  artifactSha256: Sha256Schema.optional(),
  leadSessionRef: GovernanceIdSchema,
  leadExecutionId: GovernanceIdSchema,
  evidenceManifestArtifactId: GovernanceIdSchema,
  evidenceManifestSha256: Sha256Schema.optional(),
}).strict();

export type PlanSubject = z.infer<typeof PlanSubjectSchema>;

export const MaterialityEvidenceSubjectSchema = z.object({
  categories: z.array(PlanMaterialCategorySchema).max(6),
  artifactId: GovernanceIdSchema,
  artifactSha256: Sha256Schema.optional(),
}).strict().superRefine((value, context) => {
  const unique = new Set(value.categories);
  if (unique.size !== value.categories.length) context.addIssue({ code: "custom", path: ["categories"], message: "Materiality categories must be unique" });
  const sorted = canonicalMaterialCategories(value.categories);
  if (JSON.stringify(sorted) !== JSON.stringify(value.categories)) context.addIssue({ code: "custom", path: ["categories"], message: "Materiality categories must use canonical order" });
});

export type MaterialityEvidenceSubject = z.infer<typeof MaterialityEvidenceSubjectSchema>;

export const MaterialityEvidenceArtifactSchema = z.object({
  version: z.literal(1).default(1),
  categories: z.array(PlanMaterialCategorySchema).max(6),
  affectedPaths: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.object({ category: PlanMaterialCategorySchema, rationale: z.string(), evidenceRefs: z.array(z.string()) }).strict()).max(6).default([]), // bound: one evidence group per material category
}).strict();

export type MaterialityEvidenceArtifact = z.infer<typeof MaterialityEvidenceArtifactSchema>;

export const PlanDecisionSubjectSchema = z.object({
  plan: PlanSubjectSchema,
  materiality: MaterialityEvidenceSubjectSchema,
  expectedWorkflowRevision: z.number().int().nonnegative(),
}).strict();

export type PlanDecisionSubject = z.infer<typeof PlanDecisionSubjectSchema>;

export const SupplementalReviewSubjectSchema = z.object({
  originalPlan: PlanSubjectSchema,
  reviewerProfileId: GovernanceIdSchema,
  evidenceManifestArtifactId: GovernanceIdSchema,
  evidenceManifestSha256: Sha256Schema.optional(),
}).strict();

export type SupplementalReviewSubject = z.infer<typeof SupplementalReviewSubjectSchema>;

export const PlanBlockerSubjectSchema = z.object({
  companyId: GovernanceIdSchema,
  issueId: GovernanceIdSchema,
  workflowId: GovernanceIdSchema,
  artifactId: GovernanceIdSchema,
  artifactSha256: Sha256Schema.optional(),
  leadSessionRef: GovernanceIdSchema,
  leadExecutionId: GovernanceIdSchema,
  evidenceManifestArtifactId: GovernanceIdSchema,
  evidenceManifestSha256: Sha256Schema.optional(),
  category: z.literal("human_decision"),
  resumePhase: z.literal("planning"),
}).strict();

export type PlanBlockerSubject = z.infer<typeof PlanBlockerSubjectSchema>;

// Session references are workflow-internal continuity data. They are bound by
// the server when a member submits a command and never need to cross the API.
export const PublicPlanSubjectSchema = PlanSubjectSchema.omit({ leadSessionRef: true }).strip();
export const PublicPlanBlockerSubjectSchema = PlanBlockerSubjectSchema.omit({ leadSessionRef: true }).strip();
export type PublicPlanSubject = z.infer<typeof PublicPlanSubjectSchema>;
export type PublicPlanBlockerSubject = z.infer<typeof PublicPlanBlockerSubjectSchema>;

export const DecisionIdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export function canonicalMaterialCategories(categories: readonly PlanMaterialCategory[]): PlanMaterialCategory[] {
  return [...new Set(categories)].sort((left, right) => PlanMaterialCategorySchema.options.indexOf(left) - PlanMaterialCategorySchema.options.indexOf(right));
}

function deterministicCategoriesForPath(path: string): PlanMaterialCategory[] {
  const normalized = path.replaceAll("\\", "/");
  if (/^(?:package\.json|pnpm-lock\.yaml|mise\.toml|[^/]+(?:lock|manifest)\.(?:json|ya?ml|toml))$/i.test(normalized)) return ["architecture_dependencies"];
  if (/^(?:drizzle\/.*\.sql|migrations?\/.*)$/i.test(normalized)) return ["schema_data_migration"];
  if (/^(?:src\/auth[^/]*\.ts|src\/http\/session\.ts|.*(?:authorization|permission|policy).*\.(?:ts|tsx))$/i.test(normalized)) return ["security_permissions"];
  if (/^(?:src\/github[^/]*\.ts|src\/tailscale\.ts|.*(?:provider|adapter|integration).*\.(?:ts|tsx))$/i.test(normalized)) return ["external_integration"];
  if (/^(?:scripts\/.*|src\/(?:runtime|worker|backup)\.ts|.*(?:deploy|runtime)\.(?:json|ya?ml|toml))$/i.test(normalized)) return ["production_operation"];
  if (/^(?:src\/frontend\/.*|.*(?:routes?|templates?)\/(?:.*))$/i.test(normalized)) return ["user_visible_behavior"];
  return [];
}

export function validateAffectedPaths(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => path.replaceAll("\\", "/"));
  if (!normalized.length || normalized.length > 128) throw new Error("affectedPaths must contain 1 to 128 repository paths");
  if (new Set(normalized).size !== normalized.length) throw new Error("affectedPaths must be unique");
  for (const path of normalized) {
    if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some((segment) => !segment || segment === "." || segment === "..") || /^[A-Za-z]:\//.test(path)) throw new Error("affectedPaths must contain normalized repository paths");
  }
  return normalized;
}

export function deterministicMaterialCategories(affectedPaths: readonly string[]): PlanMaterialCategory[] {
  return canonicalMaterialCategories(affectedPaths.flatMap(deterministicCategoriesForPath));
}

export function validateMaterialityEvidence(input: {
  affectedPaths: readonly string[];
  categories: readonly { category: PlanMaterialCategory; rationale: string; evidenceRefs: readonly string[] }[];
  stepNumbers?: readonly number[];
}): PlanMaterialCategory[] {
  const paths = validateAffectedPaths(input.affectedPaths);
  const categories = input.categories.map((entry) => entry.category);
  const deterministic = deterministicMaterialCategories(paths);
  const all = canonicalMaterialCategories([...categories, ...deterministic]);
  for (const entry of input.categories) {
    if (!entry.rationale.trim() || !entry.evidenceRefs.length) throw new Error(`Material category ${entry.category} requires evidence`);
  }
  return all;
}

export function classifyPlanMateriality(_text: string, explicit: PlanMaterialCategory[] = [], affectedPaths: string[] = []): PlanMaterialCategory[] {
  return canonicalMaterialCategories([...explicit, ...deterministicMaterialCategories(affectedPaths)]);
}

export function materialitySummary(categories: PlanMaterialCategory[]): string {
  const canonical = canonicalMaterialCategories(categories);
  return canonical.length ? `Material plan: ${canonical.join(", ")}` : "Routine plan";
}

export function routeLeadResult(result: { kind: "plan" | "decision_blocker"; material: boolean }): { phase: "ready_for_development" | "approval" | "blocked"; owner: "lead" | "human"; allowedCommands: string[]; pendingAction: string } {
  if (result.kind === "decision_blocker") return { phase: "blocked", owner: "human", allowedCommands: ["respond_plan_blocker", "cancel_issue"], pendingAction: "Needs your call" };
  if (result.material) return { phase: "approval", owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue"], pendingAction: "Approve final plan" };
  return { phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development" };
}
