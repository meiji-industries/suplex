import { GitHubAuthStatusResponseSchema, type GitHubAuthStatusResponse } from "../../../contracts/github-auth.js";
import { readJson } from "../../../lib/api.js";

export async function getGitHubAuthStatus(): Promise<GitHubAuthStatusResponse> {
  return GitHubAuthStatusResponseSchema.parse(await readJson("/api/github/auth"));
}
