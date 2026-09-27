import { readJsonUnchecked } from "../../../lib/api.js";
import type { ProjectResponse } from "../../../contracts/projects.js";
import type { ProjectIntegration } from "../../../contracts/project-integration.js";
import type { RecentRepositories } from "../../../contracts/generated/RecentRepositories.js";
import type { RecentRepository } from "../../../contracts/generated/RecentRepository.js";

const companyPath = (companyId: string, suffix: string): string =>
  `/api/companies/${encodeURIComponent(companyId)}${suffix}`;

export async function listProjects(companyId: string): Promise<ProjectResponse[]> {
  const result = await readJsonUnchecked<{ projects: ProjectResponse[] }>(companyPath(companyId, "/projects"));
  return result.projects;
}

export type ProjectCreate = ({ repositoryUrl: string } | { repositoryName: string }) & { baseBranch: string; integration: ProjectIntegration };

export function createProject(companyId: string, body: ProjectCreate): Promise<ProjectResponse> {
  return readJsonUnchecked<ProjectResponse>(companyPath(companyId, "/projects"), { method: "POST", body: JSON.stringify(body) });
}

/** Repositories pushed to in the last 30 days, newest first. */
export async function listRecentRepositories(companyId: string): Promise<RecentRepository[]> {
  const result = await readJsonUnchecked<RecentRepositories>(companyPath(companyId, "/recent-repositories"));
  return result.repositories;
}
