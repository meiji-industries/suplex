import { readJsonUnchecked } from "../../../lib/api.js";
import type { ProjectPatchBody, ProjectResponse } from "../../../contracts/projects.js";
import type { ProjectIntegration } from "../../../contracts/project-integration.js";
import type { GithubLabelsResponse } from "../../../contracts/generated/GithubLabelsResponse.js";
import type { RecentRepositories } from "../../../contracts/generated/RecentRepositories.js";

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

/** Change only the project fields in the body. */
export function updateProject(projectId: string, body: ProjectPatchBody): Promise<ProjectResponse> {
  return readJsonUnchecked<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: JSON.stringify(body) });
}

/** Move the project, with its tasks, to another company. Only an admin can do this. */
export function transferProject(projectId: string, companyId: string): Promise<ProjectResponse> {
  return readJsonUnchecked<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}/transfer`, { method: "POST", body: JSON.stringify({ companyId }) });
}

/** Accessible repositories, newest pushed first. */
export function listRecentRepositories(companyId: string, page = 1): Promise<RecentRepositories> {
  return readJsonUnchecked<RecentRepositories>(companyPath(companyId, `/recent-repositories?page=${page}`));
}

export function listGithubLabels(companyId: string, projectId: string): Promise<GithubLabelsResponse> {
  return readJsonUnchecked<GithubLabelsResponse>(companyPath(companyId, `/projects/${encodeURIComponent(projectId)}/github-labels`));
}
