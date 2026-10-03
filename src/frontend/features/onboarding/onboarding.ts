import { useCallback, useEffect, useState } from "react";

import type { HealthCheck } from "../../contracts/health.js";
import type { ProviderSummary, ProviderListResponse } from "../../contracts/providers.js";
import type { ProfileResponse, ProjectResponse } from "../../contracts/projects.js";
import { useSystemHealth } from "../../components/app/system-health.js";
import type { ToolIconId } from "../../components/app/tool-icons.js";
import { readJsonUnchecked, withCompany, type ApiCompany } from "../../lib/api.js";
import { listProjects } from "../projects/lib/project-api.js";

export type ApiProfile = ProfileResponse;
export type ApiProject = ProjectResponse;
export type OnboardingStepId = "company" | "tools" | "providers" | "agents" | "projects" | "done";

export const ONBOARDING_TOOL_CHECKS: readonly (HealthCheck["id"] & ToolIconId)[] = ["git", "gh-auth", "herdr-readiness"];

export const ONBOARDING_STEPS: readonly { id: OnboardingStepId; label: string; description: string }[] = [
  { id: "company", label: "Profile", description: "Add your profile and company." },
  { id: "tools", label: "Tools", description: "Check the host tools." },
  { id: "providers", label: "Providers", description: "Connect one provider." },
  { id: "agents", label: "Agents", description: "Review your team." },
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
    case "tools": return ONBOARDING_TOOL_CHECKS.every(checkId => state.checks.some(check => check.id === checkId && check.status === "healthy"));
    case "providers": return connectedProviders(state.providers).length > 0;
    case "agents": {
      const connected = new Set(connectedProviders(state.providers).map(provider => provider.id));
      return ["root", "worker"].every(role => state.profiles.some(profile => profile.role === role && profile.archivedAt === null && connected.has(profile.provider)));
    }
    case "projects": return state.projects.length >= 1;
    case "done": return ONBOARDING_STEPS.filter(step => step.id !== "done").every(step => stepComplete(state, step.id));
  }
}

export function onboardingPath(companyId?: string): string { return withCompany("/onboarding", companyId); }
export function onboardingSettingsPath(companyId?: string): string { return withCompany("/admin/onboarding", companyId); }

export type OnboardingData = { state: OnboardingState; loading: boolean; error: string; reload: () => Promise<void> };

export function useOnboardingData(company: ApiCompany | undefined): OnboardingData {
  const { snapshot, refresh, watch } = useSystemHealth();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async (): Promise<void> => {
    if (!company) return;
    setLoading(true);
    setError("");
    try {
      // Show each list when it arrives: the provider checks take seconds, the agents and projects do not.
      await Promise.all([
        readJsonUnchecked<ProviderListResponse>("/api/admin/providers").then(result => setProviders(result.providers)),
        // A fresh install points its default agents at the installed CLI before the list is read.
        readJsonUnchecked("/api/admin/profiles/defaults", { method: "POST" }).catch(() => undefined)
          .then(() => readJsonUnchecked<{ profiles: ApiProfile[] }>("/api/profiles?includeArchived=true")).then(result => setProfiles(result.profiles)),
        listProjects(company.id).then(setProjects),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not check the providers. Select Check again.");
    } finally {
      setLoading(false);
    }
  }, [company?.id]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => watch(), [watch]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { state: { company, checks: snapshot?.checks ?? [], providers, profiles, projects }, loading, error, reload };
}
