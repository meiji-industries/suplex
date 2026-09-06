import { runCommand } from "./command-runner.js";

const FORGE_REPOSITORY = "meiji-industries/forge";
const REMOTE_BRANCH = "main";
const GIT_TIMEOUT_MS = 30_000;

export interface UpdateAvailability {
  available: boolean;
  revision?: string;
}

export type GitCommand = (args: readonly string[], cwd: string) => string | Promise<string>;

export interface UpdateDetectorOptions {
  cwd?: string;
  runGit?: GitCommand;
}

async function defaultGitCommand(args: readonly string[], cwd: string): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd, timeout: GIT_TIMEOUT_MS, expectNonZero: true });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`git exited with status ${result.exitCode ?? "unknown"}`);
  }
  return result.stdout;
}

function repositoryPath(pathname: string): string | undefined {
  const normalized = pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(normalized);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

function canonicalRepository(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  const scp = /^git@github\.com:([^\s]+)$/i.exec(trimmed);
  if (scp?.[1]) {
    const repository = repositoryPath(scp[1]);
    return repository === FORGE_REPOSITORY ? repository : undefined;
  }

  try {
    const parsed = new URL(trimmed);
    const isHttps = parsed.protocol === "https:";
    const isSsh = parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:";
    if (!isHttps && !isSsh || parsed.hostname.toLowerCase() !== "github.com" || parsed.search || parsed.hash) return undefined;
    if (isHttps && (parsed.username || parsed.password)) return undefined;
    if (isSsh && (parsed.username !== "git" || parsed.password || parsed.port && parsed.port !== "22")) return undefined;
    const repository = repositoryPath(parsed.pathname);
    return repository === FORGE_REPOSITORY ? repository : undefined;
  } catch {
    return undefined;
  }
}

function requiredOutput(output: string): string {
  const value = output.trim();
  if (!value || /\s/.test(value)) throw new Error("git returned an invalid reference");
  return value;
}

function commitCount(output: string): number {
  const value = output.trim();
  if (!/^\d+$/.test(value)) throw new Error("git returned an invalid commit count");
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error("git returned an invalid commit count");
  return count;
}

async function matchingRemote(runGit: GitCommand, cwd: string): Promise<string | undefined> {
  const remotes = (await runGit(["remote"], cwd)).split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
  for (const remote of remotes) {
    const url = await runGit(["remote", "get-url", remote], cwd);
    if (canonicalRepository(url)) return remote;
  }
  return undefined;
}

export async function inspectUpdateAvailability(options: UpdateDetectorOptions = {}): Promise<UpdateAvailability> {
  const cwd = options.cwd ?? process.cwd();
  const runGit = options.runGit ?? defaultGitCommand;
  try {
    if ((await runGit(["symbolic-ref", "--short", "HEAD"], cwd)).trim() !== REMOTE_BRANCH) return { available: false };
    const remote = await matchingRemote(runGit, cwd);
    if (!remote) return { available: false };
    requiredOutput(await runGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd));
    await runGit(["fetch", "--no-tags", remote, `refs/heads/${REMOTE_BRANCH}:refs/remotes/${remote}/${REMOTE_BRANCH}`], cwd);
    const revision = requiredOutput(await runGit(["rev-parse", "--verify", `refs/remotes/${remote}/${REMOTE_BRANCH}^{commit}`], cwd));
    const count = commitCount(await runGit(["rev-list", "--count", `HEAD..refs/remotes/${remote}/${REMOTE_BRANCH}`], cwd));
    return count > 0 ? { available: true, revision } : { available: false };
  } catch {
    return { available: false };
  }
}
