import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
// eslint-disable-next-line no-restricted-imports -- this module owns repository provisioning.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BitbucketClient } from "../integrations/bitbucket.js";
import { ProjectFailure, type ProjectFinding } from "./contracts.js";
import type { RepositoryProvisioner } from "./projects.js";
import { repositoryCoordinate } from "./repository-coordinate.js";

const execFileAsync = promisify(execFile);

function finding(code: string, field: string, message: string): ProjectFinding {
  return { code, field, message };
}

/** The last line a failed command wrote, so the person sees why the host refused. */
function commandFailure(reason: unknown): string {
  const output = reason && typeof reason === "object" && "stderr" in reason ? String(reason.stderr).trim() : "";
  return output.split("\n").at(-1) || (reason instanceof Error ? reason.message : "The command failed");
}

export function defaultRepositoryProvisioner(gh = process.env.SUPLEX_GH_COMMAND ?? "gh"): RepositoryProvisioner {
  const git = async (args: string[], cwd?: string): Promise<string> => {
    const result = await execFileAsync("git", args, { ...(cwd ? { cwd } : {}), timeout: 120_000, maxBuffer: 64 * 1024 });
    return result.stdout.trim();
  };
  return {
    async githubOwners() {
      try {
        const [user, organizations] = await Promise.all([
          execFileAsync(gh, ["api", "user", "--jq", ".login"], { timeout: 30_000 }),
          // Organizations need the read:org scope; without it the personal account still works.
          execFileAsync(gh, ["api", "user/orgs", "--paginate", "--jq", ".[].login"], { timeout: 30_000 }).catch(() => ({ stdout: "" })),
        ]);
        return `${user.stdout}\n${organizations.stdout}`.split("\n").map(line => line.trim()).filter(Boolean);
      } catch (reason) {
        throw new ProjectFailure("Repository provisioning failed", [finding("github-auth-unavailable", "repositoryName", `GitHub CLI could not read the signed-in user: ${commandFailure(reason)}`)], 422);
      }
    },
    async githubRepositories(owner) {
      try {
        const { stdout } = await execFileAsync(gh, ["repo", "list", owner, "--no-archived", "--limit", "1000", "--json", "name,defaultBranchRef"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        return (JSON.parse(stdout) as Array<{ name: string; defaultBranchRef: { name: string } | null }>)
          .map(repository => ({ name: repository.name, defaultBranch: repository.defaultBranchRef?.name || "main" }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (reason) {
        throw new ProjectFailure("Repository listing failed", [finding("github-list-failed", "owner", `GitHub CLI could not list the repositories of ${owner}: ${commandFailure(reason)}`)], 422);
      }
    },
    async create(input) {
      await mkdir(dirname(input.repositoryPath), { recursive: true });
      if (await stat(input.repositoryPath).then(() => true, () => false)) {
        throw new ProjectFailure("Repository provisioning failed", [finding("repository-conflict", "repositoryName", "A repository with this name already exists in the Suplex repository folder")], 409);
      }
      const temporaryPath = await mkdtemp(join(dirname(input.repositoryPath), ".suplex-create-"));
      try {
        await git(["init", "--initial-branch", input.baseBranch], temporaryPath);
        await git(["commit", "--allow-empty", "--message", "Initial commit"], temporaryPath);
        if (input.connection.kind === "github") {
          await execFileAsync(gh, ["repo", "create", input.repository, "--private", "--source", temporaryPath, "--remote", "origin", "--push"], { timeout: 120_000 });
        } else {
          await new BitbucketClient(input.connection).api(`/2.0/repositories/${input.repository}`, "POST", { scm: "git", is_private: true });
          await git(["remote", "add", "origin", input.cloneUrl], temporaryPath);
          await git(["push", "--set-upstream", "origin", input.baseBranch], temporaryPath);
        }
        await rename(temporaryPath, input.repositoryPath);
      } catch (reason) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw new ProjectFailure("Repository provisioning failed", [finding("repository-create-failed", "repositoryName", commandFailure(reason))], 422);
      }
    },
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
        const temporaryPath = await mkdtemp(join(dirname(input.repositoryPath), ".suplex-clone-"));
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
