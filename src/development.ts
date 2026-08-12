import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import { parseGithubRepositoryUrl, type ProjectService } from "./projects.js";

const execFileAsync = promisify(execFile);

export async function seedDevelopmentData(auth: AuthService, projects: ProjectService, config: ForgeConfig): Promise<void> {
  if (!config.developmentAutoLogin) return;
  const user = auth.ensureDevelopmentUser();
  const company = auth.listVisibleCompanies(user.id)[0] ?? auth.createCompany(user.id, "Development");
  const profile = projects.listProfiles(user.id)[0] ?? projects.createProfile(user.id, { name: "Default", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  if (projects.listProjects(user.id).length > 0) return;

  const remote = (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: config.repositoryRoot })).stdout.trim();
  const repository = parseGithubRepositoryUrl(remote);
  const worktreeRoot = join(config.worktreeRoot, repository.repository.replace("/", "-"));
  await mkdir(worktreeRoot, { recursive: true });
  await projects.createProject(user.id, company.id, {
    name: repository.name,
    repositoryPath: config.repositoryRoot,
    worktreeRoot,
    repository: repository.repository,
    baseBranch: "main",
    targetBranch: "main",
    setupCommand: "pnpm install --frozen-lockfile",
    verificationCommand: "pnpm test",
    requiredChecks: ["Tests / unit"],
    allowedProfileIds: [profile.id],
    roleDefaults: { lead: profile.id, developer: profile.id },
  });
}
