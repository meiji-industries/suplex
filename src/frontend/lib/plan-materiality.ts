export type PlanMaterialCategory =
  | "architecture_dependencies"
  | "schema_data_migration"
  | "security_permissions"
  | "external_integration"
  | "production_operation"
  | "user_visible_behavior";

export const planMaterialityCriteria: ReadonlyArray<{ category: PlanMaterialCategory; label: string }> = [
  { category: "architecture_dependencies", label: "Architecture or dependencies" },
  { category: "schema_data_migration", label: "Schema or data migration" },
  { category: "security_permissions", label: "Security or permissions" },
  { category: "external_integration", label: "External integration" },
  { category: "production_operation", label: "Production operation" },
  { category: "user_visible_behavior", label: "End-user-visible behavior" },
];

export function materialityCriteria(categories: readonly PlanMaterialCategory[] = []): Array<{ category: PlanMaterialCategory; label: string; checked: boolean }> {
  const present = new Set(categories);
  return planMaterialityCriteria.map((criterion) => ({ ...criterion, checked: present.has(criterion.category) }));
}

export function materialityMode(planMaterial: boolean | null | undefined): "Trivial" | "Non-Trivial" | "—" {
  return planMaterial == null ? "—" : planMaterial ? "Non-Trivial" : "Trivial";
}
