import type { Project } from "./projects.js";
import type { ProjectRepositoryStatus } from "../http/contracts/projects.js";
import { createGithubReleasePort, GithubReleaseFailure } from "../integrations/github/delivery.js";

export async function checkRepositoryConnection(project: Pick<Project, "repository" | "repositoryPath" | "baseBranch">): Promise<ProjectRepositoryStatus> {
  const github = createGithubReleasePort();
  const result: ProjectRepositoryStatus = { status: "needs_repair", method: "cli", originRepository: null, message: "Set a GitHub repository in owner/name format." };
  if (!project.repository || !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(project.repository)) return result;
  try { result.originRepository = await github.getRemoteRepository({ cwd: project.repositoryPath }); } catch {
    return { ...result, message: "Open a local checkout with a GitHub origin. Correct the repository path below." };
  }
  try { await github.checkAuthentication(); } catch {
    return { ...result, status: "sign_in_required", message: "Sign in to GitHub to restore repository access." };
  }
  try {
    const configured = await github.observeRepository({ repository: project.repository });
    const origin = await github.observeRepository({ repository: result.originRepository });
    if (configured.id !== origin.id) return { ...result, message: "The local origin points to a different repository. Correct the repository or checkout path below." };
    const head = await github.getBranchHead({ repository: project.repository, branch: project.baseBranch });
    return head
      ? { ...result, status: "connected", message: "GitHub access, local origin, and base branch are valid." }
      : { ...result, message: "The base branch does not exist on GitHub. Correct the base branch below." };
  } catch (error) {
    return error instanceof GithubReleaseFailure && error.code === "authentication-required"
      ? { ...result, status: "sign_in_required", message: "GitHub sign-in expired. Sign in again." }
      : { ...result, status: "unavailable", message: "GitHub could not check this repository. Review the repository name and your GitHub access, then try again." };
  }
}
