import type { AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import type { ProjectService } from "./projects.js";

export async function seedDevelopmentData(auth: AuthService, projects: ProjectService, config: ForgeConfig): Promise<void> {
  if (!config.developmentAutoLogin) return;
  const user = auth.ensureDevelopmentUser();
  if (auth.listVisibleCompanies(user.id).length === 0) auth.createCompany(user.id, "Development");
  const profile = projects.listProfiles(user.id)[0] ?? projects.createProfile(user.id, { name: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const existingAgents = projects.listAgents(user.id);
  for (const agent of [
    { name: "Analyst", role: "analyst" as const },
    { name: "Implementer", role: "implementer" as const },
    { name: "Reviewer", role: "reviewer" as const },
  ]) {
    if (!existingAgents.some((candidate) => candidate.name === agent.name)) projects.createAgent(user.id, { ...agent, profileId: profile.id });
  }
}
