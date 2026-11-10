import { readJson } from "../../lib/api.js";

export type OnboardingOutcome = "first_task" | "skipped";

/** Records that onboarding finished for the company, once. Telemetry reads it; it never holds the wizard. */
export async function completeOnboarding(companyId: string, outcome: OnboardingOutcome): Promise<void> {
  await readJson(`/api/admin/companies/${encodeURIComponent(companyId)}/onboarding/${outcome}`, { method: "POST" });
}
