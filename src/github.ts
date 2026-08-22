import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { jsonRequired } from "./task-utils.js";

const execFileAsync = promisify(execFile);

export interface GithubRepository {
  nameWithOwner: string;
  url: string;
}

export interface GithubCheck {
  name: string;
  status: string;
  conclusion?: string;
}

export interface GithubMutationSurface {
  repository: string;
  observedAt: string;
  branches: Array<{ name: string; sha: string }>;
  pullRequests: Array<{ number: number; state: string; draft: boolean; headRef: string; headSha: string; baseRef: string; updatedAt: string }>;
  sha256: string;
}

export interface GithubAdapter {
  checkAuthentication(): Promise<void>;
  getRepository(input: { cwd: string; nameWithOwner: string }): Promise<GithubRepository>;
  listChecks?(input: { cwd: string; nameWithOwner: string; ref: string }): Promise<GithubCheck[]>;
  observeMutationSurface?(input: { cwd: string; nameWithOwner: string }): Promise<GithubMutationSurface>;
}

export class GithubFailure extends Error {
  constructor(readonly code: "authentication" | "repository" | "command") {
    super("GitHub validation failed");
    this.name = "GithubFailure";
  }
}

function normalizeRepository(value: string): string {
  return value.trim().replace(/\.git$/, "").toLowerCase();
}

function redactOutput(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]");
}

async function runGh(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, { cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? redactOutput(error.message) : "command failed";
    if (/auth|not logged in|login required|oauth|credential/i.test(message)) throw new GithubFailure("authentication");
    if (args[0] === "repo" && args[1] === "view") throw new GithubFailure("repository");
    throw new GithubFailure("command");
  }
}

function flattenPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

export function createGithubAdapter(command = process.env.FORGE_GH_COMMAND ?? "gh"): GithubAdapter {
  return {
    async checkAuthentication() {
      await runGh(command, ["auth", "status", "--hostname", "github.com"]);
    },
    async getRepository(input) {
      const result = await runGh(command, ["repo", "view", input.nameWithOwner, "--json", "nameWithOwner,url"], input.cwd);
      try {
        const parsed = jsonRequired(result.stdout) as { nameWithOwner?: unknown; url?: unknown };
        if (typeof parsed.nameWithOwner !== "string" || typeof parsed.url !== "string" || normalizeRepository(parsed.nameWithOwner) !== normalizeRepository(input.nameWithOwner)) {
          throw new GithubFailure("repository");
        }
        return { nameWithOwner: parsed.nameWithOwner, url: parsed.url };
      } catch (error) {
        if (error instanceof GithubFailure) throw error;
        throw new GithubFailure("repository");
      }
    },
    async listChecks(input) {
      const path = `repos/${input.nameWithOwner}/commits/${encodeURIComponent(input.ref)}/check-runs?per_page=100`;
      const result = await runGh(command, ["api", "-H", "Accept: application/vnd.github+json", path], input.cwd);
      try {
        const parsed = jsonRequired(result.stdout) as { check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown }> };
        const checks = (parsed.check_runs ?? []).flatMap((check) => typeof check.name === "string" && typeof check.status === "string"
          ? [{ name: check.name, status: check.status, ...(typeof check.conclusion === "string" ? { conclusion: check.conclusion } : {}) }]
          : []);
        return [...new Map(checks.map((check) => [check.name, check])).values()].sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        throw new GithubFailure("command");
      }
    },
    async observeMutationSurface(input) {
      const [branchesResult, pullsResult] = await Promise.all([
        runGh(command, ["api", "--paginate", "--slurp", "--jq", "map({ref, object: {sha: .object.sha}})", "-H", "Accept: application/vnd.github+json", `repos/${input.nameWithOwner}/git/refs/heads?per_page=100`], input.cwd),
        runGh(command, ["api", "--paginate", "--slurp", "--jq", "map({number, state, draft, head: {ref: .head.ref, sha: .head.sha}, base: {ref: .base.ref}, updated_at})", "-H", "Accept: application/vnd.github+json", `repos/${input.nameWithOwner}/pulls?state=open&per_page=100`], input.cwd),
      ]);
      try {
        const branches = flattenPages(jsonRequired(branchesResult.stdout)).flatMap((entry) => {
          const record = entry as { ref?: unknown; object?: { sha?: unknown } };
          return typeof record.ref === "string" && typeof record.object?.sha === "string" ? [{ name: record.ref.replace(/^refs\/heads\//, ""), sha: record.object.sha }] : [];
        }).sort((left, right) => left.name.localeCompare(right.name));
        const pullRequests = flattenPages(jsonRequired(pullsResult.stdout)).flatMap((entry) => {
          const record = entry as { number?: unknown; state?: unknown; draft?: unknown; head?: { ref?: unknown; sha?: unknown }; base?: { ref?: unknown }; updated_at?: unknown };
          return typeof record.number === "number" && typeof record.state === "string" && typeof record.draft === "boolean" && typeof record.head?.ref === "string" && typeof record.head?.sha === "string" && typeof record.base?.ref === "string" && typeof record.updated_at === "string"
            ? [{ number: record.number, state: record.state, draft: record.draft, headRef: record.head.ref, headSha: record.head.sha, baseRef: record.base.ref, updatedAt: record.updated_at }]
            : [];
        }).sort((left, right) => left.number - right.number);
        const canonical = { repository: normalizeRepository(input.nameWithOwner), branches, pullRequests };
        const serialized = JSON.stringify(canonical);
        if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) throw new GithubFailure("command");
        return { ...canonical, observedAt: new Date().toISOString(), sha256: createHash("sha256").update(serialized).digest("hex") };
      } catch (error) {
        if (error instanceof GithubFailure) throw error;
        throw new GithubFailure("command");
      }
    },
  };
}
