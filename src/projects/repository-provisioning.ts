import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
// eslint-disable-next-line no-restricted-imports -- this module owns repository provisioning.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ProjectFailure, type ProjectFinding } from "./contracts.js";
import type { RepositoryProvisioner } from "./projects.js";
import { repositoryCoordinate } from "./repository-coordinate.js";

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
          const remote = repositoryCoordinate(remoteUrl);
          if (!remote || remote.repository !== input.repository || remote.host !== repositoryCoordinate(input.cloneUrl)?.host) throw new Error("origin mismatch");
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
