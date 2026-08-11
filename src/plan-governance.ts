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

const categoryPatterns: Array<[PlanMaterialCategory, RegExp]> = [
  ["architecture_dependencies", /architect|dependency|dependencies|package|library|framework|integration boundary/i],
  ["schema_data_migration", /schema|migration|database|data model|backfill|table|column/i],
  ["security_permissions", /security|permission|authorization|authentication|credential|secret|access control/i],
  ["external_integration", /external integration|third-party|github|tailscale|provider|api contract|webhook/i],
  ["production_operation", /production|deploy|release|rollout|operational|downtime|backup|runtime/i],
  ["user_visible_behavior", /user-visible|user visible|interface|ui|ux|browser|screen|customer|workflow behavior/i],
];

export function classifyPlanMateriality(text: string, explicit: PlanMaterialCategory[] = []): PlanMaterialCategory[] {
  const categories = new Set<PlanMaterialCategory>(explicit);
  for (const [category, pattern] of categoryPatterns) if (pattern.test(text)) categories.add(category);
  return [...categories].sort();
}

export function materialitySummary(categories: PlanMaterialCategory[]): string {
  return categories.length ? `Material plan: ${categories.join(", ")}` : "Routine plan";
}
