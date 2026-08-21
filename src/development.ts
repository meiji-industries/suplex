import type { AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import type { ProjectService } from "./projects.js";

export async function seedDevelopmentData(auth: AuthService, projects: ProjectService, config: ForgeConfig): Promise<void> {
  if (!config.developmentAutoLogin) return;
  const user = auth.ensureDevelopmentUser();
  if (auth.listVisibleCompanies(user.id).length === 0) auth.createCompany(user.id, "Development");
  const profile = projects.listProfiles(user.id).find((candidate) => candidate.name === "Smart") ?? projects.createProfile(user.id, { name: "Smart", model: "gpt-5.6-sol", reasoningLevel: "high", servicePriority: "standard", capacity: 2 });
  const existingAgents = projects.listAgents(user.id);
  for (const agent of [
    { name: "Planner", role: "planner" as const },
    { name: "Builder", role: "builder" as const },
    { name: "Reviewer", role: "reviewer" as const },
    { name: "Integrator", role: "integrator" as const },
  ]) {
    if (!existingAgents.some((candidate) => candidate.name === agent.name)) projects.createAgent(user.id, { ...agent, profileId: profile.id });
  }
}
