import { access, constants, lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
// eslint-disable-next-line no-restricted-imports -- this module owns the legacy local repository adapter.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ProjectFailure, type ProjectFinding } from "./contracts.js";
import type { LocalRepositoryAdapter } from "./projects.js";

const execFileAsync = promisify(execFile);

function finding(code: string, field: string, message: string): ProjectFinding { return { code, field, message }; }

export function withinRoot(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function containsSymlink(root: string, candidate: string): Promise<boolean> {
  const path = relative(root, candidate);
  if (path === "" || path.startsWith(`..${sep}`) || path === "..") return false;
  let current = root;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

export async function canonicalDirectory(raw: string, rootRaw: string, field: string): Promise<{ path?: string; findings: ProjectFinding[] }> {
  const findings: ProjectFinding[] = [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed.split(/[\\/]+/).includes("..")) return { findings: [finding("path-traversal", field, "Path must be an existing canonical directory inside the configured root")] };
  const absolute = resolve(trimmed);
  try {
    const rootAbsolute = resolve(rootRaw);
    const [root, canonical, symlinked] = await Promise.all([realpath(rootAbsolute), realpath(absolute), containsSymlink(rootAbsolute, absolute)]);
    if (symlinked) findings.push(finding("symlink-ambiguous", field, "Symlinked paths are not accepted"));
    if (!withinRoot(canonical, root)) findings.push(finding("path-outside-root", field, "Path is outside the configured root"));
    await access(canonical, constants.R_OK);
    return findings.length ? { findings } : { path: canonical, findings };
  } catch {
    findings.push(finding("path-unavailable", field, "Path or configured root is unavailable"));
    return { findings };
  }
}

export function githubRepositoryFromRemote(remoteUrl: string): { identity: string; credentialBearing: boolean } | undefined {
  const trimmed = remoteUrl.trim();
  const normalizedSsh = trimmed.replace(/\.git$/, "");
  const ssh = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(normalizedSsh);
  if (ssh?.[1] && ssh[2]) return { identity: `${ssh[1]}/${ssh[2]}`.toLowerCase(), credentialBearing: false };
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(parsed.pathname.replace(/\.git$/, ""));
    return match?.[1] ? { identity: match[1].toLowerCase(), credentialBearing: Boolean(parsed.username || parsed.password) } : undefined;
  } catch { return undefined; }
}

export async function defaultLocalRepositoryAdapter(): Promise<LocalRepositoryAdapter> {
  const run = async (args: string[], cwd: string, timeout = 8_000): Promise<string> => {
    try { return (await execFileAsync("git", args, { cwd, timeout, maxBuffer: 16 * 1024 })).stdout.trim(); }
    catch { throw new ProjectFailure("Repository validation failed", [finding("repository-unavailable", "repositoryPath", "Git could not inspect the configured repository")], 422); }
  };
  return { async inspect(input) {
    const canonicalPath = await run(["rev-parse", "--show-toplevel"], input.repositoryPath);
    const status = await run(["status", "--porcelain", "--untracked-files=all"], input.repositoryPath);
    const remoteUrl = await run(["config", "--get", "remote.origin.url"], input.repositoryPath);
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(remoteUrl) || /(?:token|password|secret)=/i.test(remoteUrl)) throw new ProjectFailure("Repository validation failed", [finding("credential-url", "repository", "Credential-bearing repository URLs are not accepted")], 422);
    const remote = githubRepositoryFromRemote(remoteUrl);
    if (!remote || remote.credentialBearing) throw new ProjectFailure("Repository validation failed", [finding("repository-identity", "repository", "Origin must identify a canonical GitHub repository")], 422);
    await run(["fetch", "--no-tags", "origin", `refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`], input.repositoryPath, 30_000);
    const baseSha = await run(["rev-parse", "--verify", `refs/remotes/origin/${input.baseBranch}`], input.repositoryPath);
    return { canonicalPath, remoteRepository: remote.identity, clean: status.length === 0, baseSha };
  } };
}
