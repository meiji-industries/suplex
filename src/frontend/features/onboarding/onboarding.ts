import { useCallback, useEffect, useState } from "react";

import type { HealthCheck } from "../../../platform/health.js";
import type { ProviderSummary, ProviderListResponse } from "../../../http/contracts/providers.js";
import type { ProfileResponse, ProjectResponse } from "../../../http/contracts/projects.js";
import type { HarnessKind } from "../../../runtimes/harness-kind.js";
import { useSystemHealth } from "../../components/app/system-health.js";
import { readJson, withCompany, type ApiCompany } from "../../lib/api.js";

export type ApiProfile = ProfileResponse;
export type ApiProject = ProjectResponse;
export type OnboardingStepId = "company" | "tools" | "providers" | "agents" | "projects" | "done";

export const ONBOARDING_STEPS: readonly { id: OnboardingStepId; label: string; description: string }[] = [
  { id: "company", label: "Company", description: "Name the company." },
  { id: "tools", label: "Tools", description: "Check the host tools." },
  { id: "providers", label: "Providers", description: "Connect one provider." },
  { id: "agents", label: "Agents", description: "Select the agent models." },
  { id: "projects", label: "Projects", description: "Add one project." },
  { id: "done", label: "Done", description: "Start the first task." },
];

export type OnboardingState = { company: ApiCompany | undefined; checks: readonly HealthCheck[]; providers: readonly ProviderSummary[]; profiles: readonly ApiProfile[]; projects: readonly ApiProject[] };

export function connectedProviders(providers: readonly ProviderSummary[]): ProviderSummary[] {
  return providers.filter(provider => provider.status === "configured" && provider.connection.status === "connected");
}

export function stepComplete(state: OnboardingState, id: OnboardingStepId): boolean {
  switch (id) {
    case "company": return typeof state.company?.issueCode === "string";
    case "tools": return ["git", "herdr-readiness"].every(checkId => state.checks.some(check => check.id === checkId && check.status === "healthy"));
    case "providers": return connectedProviders(state.providers).length > 0;
    case "agents": {
      const connected = new Set(connectedProviders(state.providers).map(provider => provider.id));
      return ["root", "worker"].every(role => state.profiles.some(profile => profile.role === role && profile.archivedAt === null && connected.has(profile.provider)));
    }
    case "projects": return state.projects.length >= 1;
    case "done": return ONBOARDING_STEPS.filter(step => step.id !== "done").every(step => stepComplete(state, step.id));
  }
}

const ROLE_MODEL_DEFAULTS: Partial<Record<HarnessKind, { coordinator: string; worker: string }>> = {
  codex: { coordinator: "gpt-5.6-sol", worker: "gpt-5.6-luna" },
  "claude-code": { coordinator: "fable", worker: "sonnet" },
  devin: { coordinator: "swe-2", worker: "swe" },
};

export type RoleModelChoice = { provider: HarnessKind; model: string; reasoningLevel: "high" | "low" };

function chooseModel(provider: ProviderSummary, role: "coordinator" | "worker"): string | undefined {
  const preferred = ROLE_MODEL_DEFAULTS[provider.id]?.[role];
  return provider.models.some(model => model.id === preferred) ? preferred : provider.models[0]?.id;
}

export function defaultAgentModels(connected: readonly ProviderSummary[]): { coordinator: RoleModelChoice; worker: RoleModelChoice } | undefined {
  const coordinatorProvider = connected[0];
  const workerProvider = connected[1] ?? coordinatorProvider;
  if (!coordinatorProvider || !workerProvider) return undefined;
  const coordinatorModel = chooseModel(coordinatorProvider, "coordinator");
  const workerModel = chooseModel(workerProvider, "worker");
  if (!coordinatorModel || !workerModel) return undefined;
  return { coordinator: { provider: coordinatorProvider.id, model: coordinatorModel, reasoningLevel: "high" }, worker: { provider: workerProvider.id, model: workerModel, reasoningLevel: "low" } };
}

export function onboardingPath(companyId?: string): string { return withCompany("/onboarding", companyId); }
export function onboardingSettingsPath(companyId?: string): string { return withCompany("/admin/onboarding", companyId); }

export type OnboardingData = { state: OnboardingState; loading: boolean; reload: () => Promise<void> };

export function useOnboardingData(company: ApiCompany | undefined): OnboardingData {
  const { snapshot, refresh, watch } = useSystemHealth();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async (): Promise<void> => {
    if (!company) return;
    setLoading(true);
    try {
      const [providerResponse, profileResponse, projectResponse] = await Promise.all([
        readJson<ProviderListResponse>("/api/admin/providers"),
        readJson<{ profiles: ApiProfile[] }>("/api/profiles"),
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(company.id)}/projects`),
      ]);
      setProviders(providerResponse.providers);
      setProfiles(profileResponse.profiles);
      setProjects(projectResponse.projects);
    } finally {
      setLoading(false);
    }
  }, [company?.id]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => watch(), [watch]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { state: { company, checks: snapshot?.checks ?? [], providers, profiles, projects }, loading, reload };
}
