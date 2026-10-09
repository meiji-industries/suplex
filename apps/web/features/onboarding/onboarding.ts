import { useCallback, useEffect, useState } from "react";

import type { HealthCheck } from "../../contracts/health.js";
import type { ProviderSummary, ProviderListResponse } from "../../contracts/providers.js";
import type { ProfileResponse, ProjectResponse } from "../../contracts/projects.js";
import { useSystemHealth } from "../../components/app/system-health.js";
import type { ToolIconId } from "../../components/app/tool-icons.js";
import { readJsonUnchecked, withCompany, type ApiCompany } from "../../lib/api.js";
import { listProjects } from "../projects/lib/project-api.js";
import { getBillingSummary, startTrial } from "../settings/lib/billing-api.js";

export type ApiProfile = ProfileResponse;
export type ApiProject = ProjectResponse;
export type IntroStepId = "promise" | "input" | "workflows" | "parallel" | "automate" | "analytics" | "companies";
export type SetupStepId = "you" | "stack" | "team" | "project";
export type OnboardingStepId = IntroStepId | SetupStepId | "first-task";

export const ONBOARDING_TOOL_CHECKS: readonly (HealthCheck["id"] & ToolIconId)[] = ["git", "gh-auth", "gh-cli", "herdr-readiness"];
/** The checks Continue waits for on Your stack. Git and Herdr show their state but do not hold the step. */
export const REQUIRED_TOOL_CHECKS: readonly HealthCheck["id"][] = ["gh-auth", "gh-cli"];

export const INTRO_STEPS: readonly IntroStepId[] = ["promise", "input", "workflows", "parallel", "automate", "analytics", "companies"];
export const SETUP_STEPS: readonly { id: SetupStepId; label: string }[] = [
  { id: "you", label: "Profile" },
  { id: "stack", label: "Your stack" },
  { id: "team", label: "Your team" },
  { id: "project", label: "Project" },
];
/** The order of every screen: the intro, then setup, then the first task. */
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [...INTRO_STEPS, ...SETUP_STEPS.map(step => step.id), "first-task"];

export type OnboardingState = { company: ApiCompany | undefined; checks: readonly HealthCheck[]; providers: readonly ProviderSummary[]; profiles: readonly ApiProfile[]; projects: readonly ApiProject[] };

export function connectedProviders(providers: readonly ProviderSummary[]): ProviderSummary[] {
  return providers.filter(provider => provider.status === "configured" && provider.connection.status === "connected");
}

export function toolsReady(checks: readonly HealthCheck[]): boolean {
  return REQUIRED_TOOL_CHECKS.every(id => checks.some(check => check.id === id && check.status === "healthy"));
}

export function stepComplete(state: OnboardingState, id: SetupStepId): boolean {
  switch (id) {
    case "you": return typeof state.company?.issueCode === "string";
    case "stack": return toolsReady(state.checks) && connectedProviders(state.providers).length > 0;
    case "team": {
      const connected = new Set(connectedProviders(state.providers).map(provider => provider.id));
      return ["root", "worker"].every(role => state.profiles.some(profile => profile.role === role && profile.archivedAt === null && connected.has(profile.provider)));
    }
    case "project": return state.projects.length >= 1;
  }
}

export function setupComplete(state: OnboardingState): boolean {
  return SETUP_STEPS.every(step => stepComplete(state, step.id));
}

/** The screen to open without a `step`: the intro for a new company, else the first setup step still to do. */
export function firstStep(state: OnboardingState): OnboardingStepId {
  if (!state.company?.issueCode) return "promise";
  return SETUP_STEPS.find(step => !stepComplete(state, step.id))?.id ?? "first-task";
}

/** Starts the account's Pro trial when it has one and this person may start it. True when it started.
 *  Onboarding calls it once the company is named; billing never holds a step, so callers ignore failures. */
export async function startTrialIfAvailable(): Promise<boolean> {
  const billing = await getBillingSummary();
  if (billing.plan !== "free" || !billing.trialAvailable || !billing.canManageBilling) return false;
  await startTrial();
  return true;
}

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
