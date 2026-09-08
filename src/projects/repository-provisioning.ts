import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
// eslint-disable-next-line no-restricted-imports -- this module owns repository provisioning.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ProjectFailure, type ProjectFinding } from "./contracts.js";
import type { GithubRepositoryCoordinate, RepositoryProvisioner } from "./projects.js";
import { githubRepositoryFromRemote } from "./repository-inspection.js";

const execFileAsync = promisify(execFile);

function finding(code: string, field: string, message: string): ProjectFinding {
  return { code, field, message };
}

export function defaultRepositoryProvisioner(): RepositoryProvisioner {
  const git = async (args: string[], cwd?: string): Promise<string> => {
    const result = await execFileAsync("git", args, { ...(cwd ? { cwd } : {}), timeout: 120_000, maxBuffer: 64 * 1024 });
    return result.stdout.trim();
  };
  return {
    async ensure(input) {
      await mkdir(dirname(input.repositoryPath), { recursive: true });
      let repositoryExists = false;
      try {
        repositoryExists = (await stat(input.repositoryPath)).isDirectory();
      } catch {}
      if (repositoryExists) {
        try {
          const remoteUrl = await git(["remote", "get-url", "origin"], input.repositoryPath);
          const remote = githubRepositoryFromRemote(remoteUrl);
          if (!remote || remote.credentialBearing || remote.identity !== input.repository) throw new Error("origin mismatch");
        } catch {
          throw new ProjectFailure("Repository provisioning failed", [finding("repository-conflict", "repositoryUrl", "The default repository path already exists and does not match this GitHub repository")], 409);
        }
      } else {
        const temporaryPath = await mkdtemp(join(dirname(input.repositoryPath), ".forge-clone-"));
        try {
          await git(["clone", "--origin", "origin", "--", input.cloneUrl, temporaryPath]);
          await rename(temporaryPath, input.repositoryPath);
        } catch {
          await rm(temporaryPath, { recursive: true, force: true });
          throw new ProjectFailure("Repository provisioning failed", [finding("repository-unavailable", "repositoryUrl", "Git could not clone the repository with the host's current credentials")], 422);
        }
      }
      await mkdir(input.worktreeRoot, { recursive: true });
    },
  };
}

function githubRepositoryCoordinate(rawUrl: string): GithubRepositoryCoordinate | undefined {
  const trimmed = rawUrl.trim();
  const normalizedSsh = trimmed.replace(/\.git$/, "");
  const ssh = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(normalizedSsh);
  if (ssh?.[1] && ssh[2]) {
    const repository = `${ssh[1]}/${ssh[2]}`.toLowerCase();
    return { cloneUrl: `git@github.com:${repository}.git`, repository, name: ssh[2] };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const normalizedPath = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(normalizedPath);
    if (!match?.[1] || !match[2]) return undefined;
    const repository = `${match[1]}/${match[2]}`.toLowerCase();
    return { cloneUrl: `https://github.com/${repository}.git`, repository, name: match[2] };
  } catch {
    return undefined;
  }
}

const secretPattern = /(?:gh[pousr]_|github_pat_|token\s*=|password\s*=|secret\s*=|BEGIN [A-Z ]+ PRIVATE KEY|sk-[A-Za-z0-9])/i;

export function parseGithubRepositoryUrl(rawUrl: string): GithubRepositoryCoordinate {
  const coordinate = githubRepositoryCoordinate(rawUrl);
  if (!coordinate || secretPattern.test(rawUrl)) {
    throw new ProjectFailure("GitHub repository URL is invalid", [finding("repository-url", "repositoryUrl", "Use an HTTPS or SSH URL for one GitHub repository")], 422);
  }
  return coordinate;
}
