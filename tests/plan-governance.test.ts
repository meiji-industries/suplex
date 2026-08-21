import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { PlanDecisionSubjectSchema, PlanSubjectSchema, canonicalMaterialCategories, classifyPlanMateriality, deterministicMaterialCategories, routeLeadResult, validateAffectedPaths, validateMaterialityEvidence } from "../src/plan-governance.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const subject = PlanSubjectSchema.parse({ companyId: "company-1", issueId: "issue-1", workflowId: "workflow-1", originalPlanRevision: 2, outputId: "output-1", outputRevision: 1, finalVersion: 1, artifactId: "artifact-plan", artifactSha256: sha("plan"), leadSessionRef: "session-1", leadExecutionId: "execution-1", evidenceManifestArtifactId: "artifact-manifest", evidenceManifestSha256: sha("manifest") });
const materiality = { categories: ["schema_data_migration" as const], artifactId: "artifact-materiality", artifactSha256: sha("materiality") };

test.each([
  ["schema_data_migration", ["drizzle/0019.sql"]],
  ["architecture_dependencies", ["package.json"]],
  ["security_permissions", ["src/authorization-policy.ts"]],
  ["external_integration", ["src/github-client.ts"]],
  ["production_operation", ["scripts/backup.ts"]],
  ["user_visible_behavior", ["src/frontend/task.tsx"]],
] as const)("deterministic path materiality adds %s", (category, paths) => expect(deterministicMaterialCategories(paths)).toContain(category));

test("materiality ignores negated prose and uses explicit/path facts only", () => {
  expect(classifyPlanMateriality("No schema change is needed", [], ["README.md"])).toEqual([]);
  expect(classifyPlanMateriality("No schema change is needed", ["user_visible_behavior"], ["README.md"])).toEqual(["user_visible_behavior"]);
});

test("materiality categories are canonical and evidence references are bounded", () => {
  expect(canonicalMaterialCategories(["user_visible_behavior", "architecture_dependencies"])).toEqual(["architecture_dependencies", "user_visible_behavior"]);
  expect(validateMaterialityEvidence({ affectedPaths: ["package.json"], categories: [{ category: "architecture_dependencies", rationale: "Dependency graph changes", evidenceRefs: ["path:package.json"] }] })).toEqual(["architecture_dependencies"]);
  expect(() => validateMaterialityEvidence({ affectedPaths: ["package.json"], categories: [{ category: "architecture_dependencies", rationale: "", evidenceRefs: [] }] })).toThrow();
});

test("affected paths reject traversal and duplicates", () => {
  expect(validateAffectedPaths(["src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  expect(() => validateAffectedPaths(["../secret"])).toThrow();
  expect(() => validateAffectedPaths(["src/a.ts", "src/a.ts"])).toThrow();
});

test("decision subjects bind the exact plan, materiality, and workflow revision", () => {
  const decision = PlanDecisionSubjectSchema.parse({ plan: subject, materiality, expectedWorkflowRevision: 3 });
  expect(decision.plan.artifactId).toBe("artifact-plan");
  expect(decision.expectedWorkflowRevision).toBe(3);
});

test.each([
  [{ kind: "plan" as const, material: false }, "ready_for_development", "lead", ["start_development", "cancel_issue"]],
  [{ kind: "plan" as const, material: true }, "approval", "human", ["approve_plan", "request_plan_revision", "cancel_issue"]],
  [{ kind: "decision_blocker" as const, material: false }, "blocked", "human", ["respond_plan_blocker", "cancel_issue"]],
] as const)("Lead result routes to %s", (result, phase, owner, commands) => {
  expect(routeLeadResult(result)).toMatchObject({ phase, owner, allowedCommands: commands });
});
