import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { ArtifactStore, StoredArtifact } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import type { GitPresentation } from "./git-presentation.js";
import type { ReleaseFailureCode } from "./release-failures.js";
import { jsonRequired } from "./task-utils.js";
import { runCommand } from "./command-runner.js";

const shaPattern = /^[a-f0-9]{40,64}$/i;
const repositoryPattern = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/i;
const MAX_OUTPUT = 256 * 1024;

export interface PinnedRepositoryCoordinates {
  projectRevisionId: string;
  repositoryPath: string;
  worktreePath: string;
  repository: string;
  owner: string;
  headBranch: string;
  baseBranch: string;
  expectedBaseSha: string;
}

export interface ReviewedRevision {
  reviewId: string;
  developerExecutionId: string;
  commitSha: string;
  treeSha: string;
}

export interface DraftPullRequestProjection {
  title: string;
  body: string;
  bodySha256: string;
}

export interface LocalRevision {
  branch: string;
  headSha: string;
  treeSha: string;
  clean: boolean;
}

export interface GithubPullRequest {
  number: number;
  url: string;
  repository: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  isDraft: boolean;
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
  autoMergeEnabled?: boolean;
  title?: string;
  body?: string;
  author?: string;
  updatedAt?: string;
  isCrossRepository?: boolean;
}

/** The provider truth used by Forge when reconciling an externally changed PR. */
export interface GithubPullRequestObservation {
  exists: boolean;
  number: number | null;
  url: string | null;
  state: "open" | "closed" | "merged" | null;
  isDraft: boolean | null;
  headSha: string | null;
  baseSha: string | null;
  mergeable: string | null;
  checks: { total: number; pending: number; failing: number; successful: number };
  author?: { login: string; avatarUrl: string } | null;
  changedFiles?: number | null;
  additions?: number | null;
  deletions?: number | null;
  autoMergeEnabled: boolean | null;
  reviewDecision: string | null;
}

export interface ExactPullRequestIdentity {
  repository: string;
  owner: string;
  headBranch: string;
  baseBranch: string;
}

export interface DraftPullRequestCreate extends ExactPullRequestIdentity {
  title: string;
  body: string;
}

export interface DraftPullRequestUpdate {
  repository: string;
  number: number;
  title: string;
  body: string;
}

export interface GithubReleasePort {
  checkAuthentication(): Promise<void>;
  getRemoteRepository(input: { cwd: string }): Promise<string>;
  getBranchHead(input: { repository: string; branch: string }): Promise<string | null>;
  getCommitTree?(input: { repository: string; commitSha: string }): Promise<string>;
  inspectLocalRevision(input: { cwd: string }): Promise<LocalRevision>;
  pushNormal(input: { cwd: string; branch: string }): Promise<void>;
  listPullRequests(input: ExactPullRequestIdentity): Promise<GithubPullRequest[]>;
  listOpenPullRequests?(input: { repository: string; limit: number }): Promise<GithubPullRequest[]>;
  createDraftPullRequest(input: DraftPullRequestCreate): Promise<GithubPullRequest>;
  updateDraftPullRequest(input: DraftPullRequestUpdate): Promise<GithubPullRequest>;
  getPullRequest(input: { repository: string; number: number }): Promise<GithubPullRequest>;
  observePullRequest?(input: { repository: string; branch: string; pullRequestNumber?: number | null }): Promise<GithubPullRequestObservation>;
  mergePullRequest?(input: { repository: string; number: number; headSha: string }): Promise<void>;
}

export type GithubAcceptancePort = Pick<GithubReleasePort, "getBranchHead" | "getPullRequest"> & {
  markReadyForReview(input: { repository: string; number: number }): Promise<void>;
  mergePullRequest?(input: { repository: string; number: number; headSha: string }): Promise<void>;
  enableAutoMerge?(input: { repository: string; number: number; headSha: string }): Promise<void>;
};
export type GithubReleaseAdapter = GithubReleasePort & GithubAcceptancePort;

export type GithubCommandResult = { stdout: string; stderr: string };
export interface GithubCommandSpec {
  command: string;
  args: string[];
  cwd?: string;
  timeout: number;
  maxBuffer: number;
}
export type GithubCommandRunner = (input: GithubCommandSpec) => Promise<GithubCommandResult>;

export interface GithubReleasePortOptions {
  ghCommand?: string;
  gitCommand?: string;
  runner?: GithubCommandRunner;
  /** Optional Activity coordinates when the adapter is used directly by a task step. */
  taskId?: string | null;
  stepId?: string | null;
}

const BranchResponseSchema = z.object({ commit: z.object({ sha: z.string().regex(shaPattern) }) });
const CommitResponseSchema = z.object({ tree: z.object({ sha: z.string().regex(shaPattern) }) });
const RepositorySchema = z.string().regex(repositoryPattern).transform((value) => value.toLowerCase());
const RestErrorSchema = z.object({
  message: z.string().min(1),
  documentation_url: z.string().url().refine((value) => new URL(value).hostname === "docs.github.com", "unexpected documentation host"),
  status: z.union([z.number().int(), z.string().regex(/^\d{3}$/)]),
});
const PullResponseSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: z.string().datetime().nullable(),
  auto_merge: z.object({}).nullable().optional(),
  head: z.object({ ref: z.string().min(1).max(256), sha: z.string().regex(shaPattern), repo: z.object({ full_name: RepositorySchema }) }),
  base: z.object({ ref: z.string().min(1).max(256), sha: z.string().regex(shaPattern), repo: z.object({ full_name: RepositorySchema }) }),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).optional(),
  updated_at: z.string().datetime().optional(),
});
const PullListResponseSchema = z.array(z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headRefName: z.string().min(1).max(256),
  headRefOid: z.string().regex(shaPattern),
  baseRefName: z.string().min(1).max(256),
  baseRefOid: z.string().regex(shaPattern),
  title: z.string().default(""),
  body: z.string().default(""),
  author: z.object({ login: z.string() }).nullable().default(null),
  updatedAt: z.string().datetime().optional(),
  isCrossRepository: z.boolean().default(false),
}));
const PullViewResponseSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefOid: z.string().regex(shaPattern),
  baseRefOid: z.string().regex(shaPattern),
  mergeable: z.string().nullable(),
  autoMergeRequest: z.object({}).nullable(),
  reviewDecision: z.string().nullable(),
  author: z.object({ login: z.string().min(1), avatarUrl: z.string().url().nullable().optional() }).nullable(),
  changedFiles: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  statusCheckRollup: z.array(z.object({
    status: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
  }).passthrough()).nullable(),
});
const RateLimitResponseSchema = z.object({ resources: z.object({ core: z.object({ reset: z.number().int() }) }) });

class GithubCommandFailure extends Error {
  constructor(readonly result: GithubCommandResult, readonly timedOut = false) {
    super("GitHub command failed");
    this.name = "GithubCommandFailure";
  }
}

function bounded(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}…`;
}

function providerFailure(code: ReleaseFailureCode, summary = "GitHub provider request failed", retryAt: string | null = null): GithubReleaseFailure {
  return new GithubReleaseFailure(code, summary, retryAt);
}

export class GithubReleaseFailure extends Error {
  constructor(readonly code: ReleaseFailureCode, readonly summary = "GitHub release failed", readonly retryAt: string | null = null) {
    super(summary);
    this.name = "GithubReleaseFailure";
  }
}

function newReleaseId(): string {
  return `release_${randomBytes(12).toString("hex")}`;
}

function normalizeRepository(value: string): string {
  const parsed = RepositorySchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) throw providerFailure("wrong-remote", "Repository identity is invalid");
  return parsed.data;
}

function normalizeGithubPull(value: unknown): GithubPullRequest {
  const parsed = PullResponseSchema.safeParse(value);
  if (!parsed.success) throw providerFailure("invalid-provider-response", "GitHub pull request response is malformed");
  const row = parsed.data;
  const headRepository = row.head.repo.full_name.toLowerCase();
  const state = row.state === "closed" && row.merged_at !== null ? "merged" : row.state;
  return { number: row.number, url: row.html_url, repository: headRepository, headBranch: row.head.ref, baseBranch: row.base.ref, headSha: row.head.sha, baseSha: row.base.sha, isDraft: row.draft, state, mergedAt: row.merged_at, isCrossRepository: headRepository !== row.base.repo.full_name.toLowerCase(), ...(row.title !== undefined ? { title: row.title } : {}), ...(row.body !== undefined ? { body: row.body ?? "" } : {}), ...(row.user ? { author: row.user.login } : {}), ...(row.updated_at ? { updatedAt: row.updated_at } : {}), ...(row.auto_merge ? { autoMergeEnabled: true } : {}) };
}

function summarizeChecks(checks: z.infer<typeof PullViewResponseSchema>["statusCheckRollup"]): GithubPullRequestObservation["checks"] {
  const latest = new Map<string, { check: NonNullable<z.infer<typeof PullViewResponseSchema>["statusCheckRollup"]>[number]; completedAt: string | null }>();
  for (const [index, check] of (checks ?? []).entries()) {
    const name = typeof check.name === "string" ? check.name : typeof check.context === "string" ? check.context : String(index);
    const completedAt = typeof check.completedAt === "string" ? check.completedAt : typeof check.startedAt === "string" ? check.startedAt : null;
    const previous = latest.get(name);
    if (!previous || (completedAt !== null && (previous.completedAt === null || completedAt >= previous.completedAt)) || (completedAt === null && previous.completedAt === null)) latest.set(name, { check, completedAt });
  }
  const summary = { total: 0, pending: 0, failing: 0, successful: 0 };
  for (const { check } of latest.values()) {
    summary.total += 1;
    if (check.status === undefined) {
      if (check.state === "SUCCESS") summary.successful += 1;
      else if (check.state === "FAILURE" || check.state === "ERROR") summary.failing += 1;
      else summary.pending += 1;
    } else if (check.status !== "COMPLETED") summary.pending += 1;
    else if (check.conclusion === "SUCCESS" || check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED") summary.successful += 1;
    else summary.failing += 1;
  }
  return summary;
}

export function mapGithubPullRequestObservation(value: unknown): GithubPullRequestObservation {
  const parsed = PullViewResponseSchema.safeParse(value);
  if (!parsed.success) throw providerFailure("invalid-provider-response", "GitHub pull request observation is malformed");
  const pull = parsed.data;
  return {
    exists: true,
    number: pull.number,
    url: pull.url,
    state: pull.state.toLowerCase() as "open" | "closed" | "merged",
    isDraft: pull.isDraft,
    headSha: pull.headRefOid,
    baseSha: pull.baseRefOid,
    mergeable: pull.mergeable,
    checks: summarizeChecks(pull.statusCheckRollup),
    author: pull.author && { login: pull.author.login, avatarUrl: pull.author.avatarUrl ?? `https://avatars.githubusercontent.com/${pull.author.login}` },
    changedFiles: pull.changedFiles,
    additions: pull.additions,
    deletions: pull.deletions,
    autoMergeEnabled: pull.autoMergeRequest !== null,
    reviewDecision: pull.reviewDecision,
  };
}

function restError(value: string): { status: number; message: string; reset?: number } | undefined {
  try {
    const parsed = RestErrorSchema.parse(jsonRequired(value));
    return { status: Number(parsed.status), message: parsed.message };
  } catch {
    return undefined;
  }
}

function parseJson(value: string): unknown {
  try { return jsonRequired(value) as unknown; } catch { throw providerFailure("invalid-provider-response", "GitHub returned invalid JSON"); }
}

function classifyCommandFailure(error: unknown, operation: string): GithubReleaseFailure {
  if (!(error instanceof GithubCommandFailure)) return providerFailure("provider-unavailable", operation);
  const parsed = restError(error.result.stdout);
  if (parsed?.status === 403 || parsed?.status === 429) return providerFailure("provider-rate-limited", parsed.message);
  if (operation === "authentication") return providerFailure("authentication-required", "GitHub CLI authentication is unavailable");
  if (error.timedOut) return providerFailure("provider-unavailable", `${operation} timed out`);
  return new GithubReleaseFailure("provider-unavailable", error.result.stderr || error.result.stdout || operation);
}

const defaultRunner: GithubCommandRunner = async ({ command, args, cwd, timeout, maxBuffer: _maxBuffer }) => {
  try {
    const result = await runCommand({ taskId: null, stepId: null, command, args, ...(cwd ? { cwd } : {}), timeout });
    if (result.exitCode === 0 && !result.timedOut) return { stdout: bounded(result.stdout), stderr: bounded(result.stderr) };
    throw Object.assign(new Error(`${command} exited with status ${result.exitCode ?? "unknown"}`), { stdout: result.stdout, stderr: result.stderr, killed: result.timedOut, signal: result.timedOut ? "SIGTERM" : undefined });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    throw new GithubCommandFailure({ stdout: bounded(failure.stdout ?? ""), stderr: bounded(failure.stderr ?? "") }, Boolean(failure.killed || failure.signal === "SIGTERM"));
  }
};

export function createGithubReleasePort(options: GithubReleasePortOptions = {}): GithubReleaseAdapter {
  const ghCommand = options.ghCommand ?? process.env.FORGE_GH_COMMAND ?? "gh";
  const gitCommand = options.gitCommand ?? "git";
  const runner = options.runner ?? (options.taskId && options.stepId
    ? async ({ command, args, cwd, timeout, maxBuffer: _maxBuffer }) => {
      const result = await runCommand({ taskId: options.taskId!, stepId: options.stepId!, command, args, ...(cwd ? { cwd } : {}), timeout });
      if (result.exitCode === 0 && !result.timedOut) return { stdout: bounded(result.stdout), stderr: bounded(result.stderr) };
      throw new GithubCommandFailure({ stdout: bounded(result.stdout), stderr: bounded(result.stderr) }, result.timedOut);
    }
    : defaultRunner);
  const run = async (command: string, args: string[], commandOptions: { cwd?: string; timeout?: number; maxBuffer?: number } = {}): Promise<GithubCommandResult> => {
    try {
      return await runner({ command, args, ...(commandOptions.cwd ? { cwd: commandOptions.cwd } : {}), timeout: commandOptions.timeout ?? 20_000, maxBuffer: commandOptions.maxBuffer ?? MAX_OUTPUT });
    } catch (error) {
      if (error instanceof GithubCommandFailure) throw error;
      const result = error as { stdout?: unknown; stderr?: unknown };
      throw new GithubCommandFailure({ stdout: bounded(typeof result.stdout === "string" ? result.stdout : ""), stderr: bounded(typeof result.stderr === "string" ? result.stderr : String(error)) });
    }
  };
  const runGh = (args: string[], commandOptions: { cwd?: string; timeout?: number; maxBuffer?: number } = {}) => run(ghCommand, args, commandOptions);
  const runGit = (args: string[], commandOptions: { cwd?: string; timeout?: number; maxBuffer?: number } = {}) => run(gitCommand, args, commandOptions);
  const retryAtFromRateLimit = async (): Promise<string | null> => {
    try {
      const result = await runGh(["api", "rate_limit"], { timeout: 10_000, maxBuffer: 32 * 1024 });
      const reset = RateLimitResponseSchema.parse(parseJson(result.stdout)).resources.core.reset;
      const retryAt = new Date(reset * 1_000).toISOString();
      return Date.parse(retryAt) > Date.now() ? retryAt : null;
    } catch { return null; }
  };
  const api = async (args: string[], operation: string, allowNotFound = false, notFoundSummary?: string): Promise<unknown> => {
    try { return parseJson((await runGh(args)).stdout); } catch (error) {
      if (error instanceof GithubReleaseFailure) throw error;
      if (error instanceof GithubCommandFailure) {
        const parsed = restError(error.result.stdout);
        if (allowNotFound && parsed?.status === 404) return null;
        // GitHub sometimes returns plain-text 404s. Treat them as an absent
        // observation; the next operation will adopt what GitHub reports.
        if (allowNotFound && !parsed) return null;
        if (parsed?.status === 404) throw providerFailure("provider-unavailable", notFoundSummary ?? "GitHub resource was not found or is inaccessible");
        if (parsed?.status === 403 || parsed?.status === 429) {
          const retryAt = await retryAtFromRateLimit();
          if (retryAt) throw providerFailure("provider-rate-limited", parsed.message, retryAt);
          throw providerFailure("provider-unavailable", "GitHub rate-limit reset is unavailable");
        }
      }
      throw classifyCommandFailure(error, operation);
    }
  };
  const pull = (value: unknown): GithubPullRequest => normalizeGithubPull(value);
  return {
    async checkAuthentication() {
      try { await runGh(["auth", "status", "--hostname", "github.com"], { timeout: 10_000, maxBuffer: 16 * 1024 }); } catch (error) { throw classifyCommandFailure(error, "authentication"); }
    },
    async getRemoteRepository(input) {
      try {
        const result = await runGit(["remote", "get-url", "origin"], { cwd: input.cwd, timeout: 8_000, maxBuffer: 16 * 1024 });
        const remote = result.stdout.trim().replace(/\.git$/, "");
        const match = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(remote) ?? /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(remote);
        if (!match?.[1]) throw providerFailure("wrong-remote", "Git origin is not a GitHub repository");
        return normalizeRepository(match[1]);
      } catch (error) {
        if (error instanceof GithubReleaseFailure) throw error;
        throw providerFailure("wrong-remote", "Git origin could not be inspected");
      }
    },
    async getBranchHead(input) {
      try {
        const value = await api(["api", `repos/${input.repository}/branches/${encodeURIComponent(input.branch)}`], "branch observation", true);
        if (value === null) return null;
        return BranchResponseSchema.parse(value).commit.sha;
      } catch (error) {
        if (error instanceof GithubReleaseFailure) throw error;
        throw providerFailure("invalid-provider-response", "GitHub branch response is malformed");
      }
    },
    async getCommitTree(input) {
      try {
        return CommitResponseSchema.parse(await api(["api", `repos/${input.repository}/git/commits/${input.commitSha}`], "commit observation")).tree.sha;
      } catch (error) {
        if (error instanceof GithubReleaseFailure) throw error;
        throw providerFailure("invalid-provider-response", "GitHub commit response is malformed");
      }
    },
    async inspectLocalRevision(input) {
      try {
        const [branch, headSha, treeSha, status] = await Promise.all([
          runGit(["symbolic-ref", "--short", "HEAD"], { cwd: input.cwd, timeout: 8_000, maxBuffer: 4 * 1024 }),
          runGit(["rev-parse", "HEAD"], { cwd: input.cwd, timeout: 8_000, maxBuffer: 4 * 1024 }),
          runGit(["rev-parse", "HEAD^{tree}"], { cwd: input.cwd, timeout: 8_000, maxBuffer: 4 * 1024 }),
          runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: input.cwd, timeout: 8_000, maxBuffer: 64 * 1024 }),
        ]);
        const values = { branch: branch.stdout.trim(), headSha: headSha.stdout.trim(), treeSha: treeSha.stdout.trim(), clean: status.stdout.trim() === "" };
        if (!values.branch || !shaPattern.test(values.headSha) || !shaPattern.test(values.treeSha)) throw providerFailure("invalid-provider-response", "Local Git revision is malformed");
        return values;
      } catch (error) {
        if (error instanceof GithubReleaseFailure) throw error;
        throw providerFailure("stale-reviewed-revision", "Local Git revision could not be inspected");
      }
    },
    async pushNormal(input) {
      try { await runGit(["push", "--set-upstream", "origin", `HEAD:refs/heads/${input.branch}`], { cwd: input.cwd, timeout: 60_000, maxBuffer: 64 * 1024 }); } catch (error) { throw classifyCommandFailure(error, "normal push"); }
    },
    async listPullRequests(input) {
      let value: unknown;
      try { value = parseJson((await runGh(["pr", "list", "--repo", input.repository, "--head", input.headBranch, "--state", "all", "--limit", "100", "--json", "number,url,isDraft,state,headRefName,headRefOid,baseRefName,baseRefOid"])).stdout); } catch (error) { throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "pull request list"); }
      const rows = PullListResponseSchema.safeParse(value);
      if (!rows.success) throw providerFailure("invalid-provider-response", "GitHub pull request list could not be parsed");
      return rows.data.map((row) => ({ number: row.number, url: row.url, repository: normalizeRepository(input.repository), headBranch: row.headRefName, baseBranch: row.baseRefName, headSha: row.headRefOid, baseSha: row.baseRefOid, isDraft: row.isDraft, state: row.state.toLowerCase() as GithubPullRequest["state"], mergedAt: null, title: row.title, body: row.body, author: row.author?.login ?? "", updatedAt: row.updatedAt, isCrossRepository: row.isCrossRepository }));
    },
    async listOpenPullRequests(input) {
      let value: unknown;
      try { value = parseJson((await runGh(["pr", "list", "--repo", input.repository, "--state", "open", "--limit", String(Math.min(100, Math.max(1, input.limit))), "--json", "number,url,isDraft,state,headRefName,headRefOid,baseRefName,baseRefOid,title,body,author,updatedAt,isCrossRepository"])).stdout); } catch (error) { throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "pull request list"); }
      const rows = PullListResponseSchema.safeParse(value);
      if (!rows.success) throw providerFailure("invalid-provider-response", "GitHub pull request list could not be parsed");
      return rows.data.map((row) => ({ number: row.number, url: row.url, repository: normalizeRepository(input.repository), headBranch: row.headRefName, baseBranch: row.baseRefName, headSha: row.headRefOid, baseSha: row.baseRefOid, isDraft: row.isDraft, state: row.state.toLowerCase() as GithubPullRequest["state"], mergedAt: null, title: row.title, body: row.body, author: row.author?.login ?? "", updatedAt: row.updatedAt, isCrossRepository: row.isCrossRepository }));
    },
    async createDraftPullRequest(input) {
      const value = await api(["api", "--method", "POST", `repos/${input.repository}/pulls`, "-f", `title=${input.title}`, "-f", `head=${input.headBranch}`, "-f", `base=${input.baseBranch}`, "-f", `body=${input.body}`, "-F", "draft=true"], "draft pull request creation", false, `Branch ${input.headBranch} is not on GitHub yet`);
      return pull(value);
    },
    async updateDraftPullRequest(input) {
      const value = await api(["api", "--method", "PATCH", `repos/${input.repository}/pulls/${input.number}`, "-f", `title=${input.title}`, "-f", `body=${input.body}`], "draft pull request metadata update");
      const metadata = PullResponseSchema.extend({ title: z.string(), body: z.string() }).safeParse(value);
      if (!metadata.success || metadata.data.title !== input.title || metadata.data.body !== input.body) throw providerFailure("invalid-provider-response", "GitHub did not confirm the updated pull request metadata");
      return pull(value);
    },
    async getPullRequest(input) {
      const value = await api(["api", `repos/${input.repository}/pulls/${input.number}`], "pull request observation");
      return pull(value);
    },
    async observePullRequest(input) {
      let number = input.pullRequestNumber ?? null;
      if (number === null) {
        const candidates = await this.listPullRequests({ repository: input.repository, owner: input.repository.split("/")[0]!, headBranch: input.branch, baseBranch: "" });
        number = candidates[0]?.number ?? null;
      }
      if (number === null) return { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, author: null, changedFiles: null, additions: null, deletions: null, autoMergeEnabled: null, reviewDecision: null };
      try {
        const raw = parseJson((await runGh(["pr", "view", String(number), "--repo", input.repository, "--json", "number,url,state,isDraft,headRefOid,baseRefOid,mergeable,autoMergeRequest,reviewDecision,author,changedFiles,additions,deletions,statusCheckRollup"])).stdout);
        return mapGithubPullRequestObservation(raw);
      } catch (error) {
        if (error instanceof GithubCommandFailure && /not found/i.test(`${error.result.stdout}\n${error.result.stderr}`)) return { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, author: null, changedFiles: null, additions: null, deletions: null, autoMergeEnabled: null, reviewDecision: null };
        throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "pull request observation");
      }
    },
    async markReadyForReview(input) {
      const current = await this.getPullRequest({ repository: input.repository, number: input.number });
      if (current.state !== "open") throw providerFailure("provider-unavailable", "Pull request is no longer open");
      if (!current.isDraft) return;
      try { await runGh(["pr", "ready", String(input.number), "--repo", input.repository]); } catch (error) { throw classifyCommandFailure(error, "mark ready for review"); }
    },
    async mergePullRequest(input) {
      try { await runGh(["pr", "merge", String(input.number), "--repo", input.repository, "--merge", "--match-head-commit", input.headSha]); } catch (error) { throw classifyCommandFailure(error, "merge pull request"); }
    },
    async enableAutoMerge(input) {
      const current = await this.getPullRequest({ repository: input.repository, number: input.number });
      if (current.state !== "open") throw providerFailure("provider-unavailable", "Pull request is no longer open");
      if (current.autoMergeEnabled) return;
      // Use a merge method the repository allows; GitHub rejects disallowed ones outright.
      const repo = await api(["api", `repos/${input.repository}`], "repository settings") as { allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean };
      const method = repo.allow_squash_merge !== false ? "--squash" : repo.allow_merge_commit !== false ? "--merge" : "--rebase";
      try { await runGh(["pr", "merge", String(input.number), "--repo", input.repository, "--auto", method, "--match-head-commit", input.headSha]); } catch (error) { throw classifyCommandFailure(error, "enable auto-merge"); }
    },
  } as GithubReleasePort & GithubAcceptancePort;
}

function truncateUtf8(value: string, byteLimit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= byteLimit) return value;
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  let end = Math.max(0, byteLimit - ellipsisBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8").trimEnd()}${ellipsis}`;
}

function truncateCharacters(value: string, characterLimit: number): string {
  const characters = [...value];
  return characters.length <= characterLimit ? value : `${characters.slice(0, Math.max(0, characterLimit - 1)).join("")}…`;
}

/** Makes generated PR text readable while retaining useful delivery evidence. */
export function sanitizePublicText(value: string, byteLimit = 300): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/Bearer\s+\S+|\b(?:gho_|github_pat_|sk-)[A-Za-z0-9_-]+\b|\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]");
  return truncateUtf8(normalized, byteLimit);
}

function inlineCode(value: string): string {
  const longestFence = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  const content = value.startsWith("`") || value.endsWith("`") ? ` ${value} ` : value;
  return `${fence}${content}${fence}`;
}

export function buildDraftPullRequestProjection(input: {
  taskTitle: string;
  pullRequestTitle?: string;
  pullRequestDescription?: string;
  deliverySummary?: string;
  changes?: string[];
  filesChanged?: string[];
  commandsRun?: string[];
  testResults?: string[];
}): DraftPullRequestProjection {
  const rawTitle = input.pullRequestTitle ?? input.taskTitle;
  const title = truncateCharacters(sanitizePublicText(rawTitle, 20_000), 160);
  const paths = [...new Set((input.filesChanged ?? []).map((path) => sanitizePublicText(path, 300)))].slice(0, 10);
  const description = sanitizePublicText(input.pullRequestDescription ?? input.deliverySummary ?? title);
  const deliverySummary = input.deliverySummary ? sanitizePublicText(input.deliverySummary) : undefined;
  const changes = [...new Set((input.changes ?? []).map((change) => sanitizePublicText(change)))].slice(0, 10);
  const commands = [...new Set((input.commandsRun ?? []).map((command) => sanitizePublicText(command, 300)))].slice(0, 10);
  const tests = [...new Set((input.testResults ?? []).map((result) => sanitizePublicText(result, 300)))].slice(0, 10);
  const changeRows = changes.length ? changes.map((change) => `- ${change}`) : paths.length ? paths.map((path) => `- ${inlineCode(path)}`) : ["- No implementation details were reported."];
  const testingRows = [
    ...commands.map((command) => `- ${inlineCode(command)}`),
    ...tests.map((result) => `- ${result}`),
  ];
  const summaryRows = deliverySummary && deliverySummary !== description ? [description, "", deliverySummary] : [description];
  const body = truncateUtf8(["## Summary", "", ...summaryRows, "", "## Changes", "", ...changeRows, "", "## Testing", "", ...(testingRows.length ? testingRows : ["- Not run (no verification was reported)."]), ""].join("\n"), 20_000);
  const projection = { title, body, bodySha256: createHash("sha256").update(body, "utf8").digest("hex") };
  return projection;
}

export function assertPublicProjectionBounds(input: Pick<DraftPullRequestProjection, "title" | "body">): void {
  if (input.title.length > 160 || Buffer.byteLength(input.body, "utf8") > 20_000) throw new Error("Public pull request projection exceeds its size limit");
}

export interface PublishReleaseInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  releaseId?: string;
  coordinates: PinnedRepositoryCoordinates;
  reviewedRevision: ReviewedRevision;
  taskTitle: string;
  gitPresentation?: GitPresentation;
  delivery: { summary?: string; changes?: string[]; filesChanged?: string[]; commandsRun?: string[]; testResults?: string[] };
}

export interface PublishReleaseResult {
  releaseId: string;
  repository: string;
  branchName: string;
  baseBranch: string;
  headSha: string;
  headTree: string;
  pullRequest: GithubPullRequest;
  reused: boolean;
  attempt: number;
}

function operationId(): string { return `provider_${randomBytes(12).toString("hex")}`; }
function releaseKeyFor(input: PublishReleaseInput, coordinates: PinnedRepositoryCoordinates, reviewed: ReviewedRevision): string {
  return createHash("sha256").update([input.workflowId, coordinates.projectRevisionId, coordinates.repository, coordinates.headBranch, coordinates.baseBranch, reviewed.commitSha, reviewed.treeSha].join("|"), "utf8").digest("hex");
}

export class ReleaseService {
  constructor(private readonly database: ForgeDatabase, private readonly artifacts: ArtifactStore, private readonly github: GithubReleasePort) {}

  async markReadyForReview(input: { taskId: string; companyId: string; workflowId: string; releaseId: string; repository: string; pullRequestNumber: number }): Promise<void> {
    const release = this.database.authQuery((db) => db.prepare(`SELECT id, status, repository, base_branch AS baseBranch, head_branch AS headBranch, base_sha AS baseSha, head_sha AS headSha, pr_number AS pullRequestNumber, pr_url AS pullRequestUrl
      FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND superseded_at IS NULL`).get(input.releaseId, input.taskId, input.companyId, input.workflowId) as { id: string; status: string; repository: string; baseBranch: string; headBranch: string; baseSha: string; headSha: string; pullRequestNumber: number | null; pullRequestUrl: string | null } | undefined);
    if (!release || release.repository.toLowerCase() !== input.repository.toLowerCase() || release.pullRequestNumber !== input.pullRequestNumber || !release.pullRequestUrl) throw providerFailure("stale-reviewed-revision", "The stored pull request no longer matches this task");
    await this.github.checkAuthentication();
    const matchesRelease = (pullRequest: GithubPullRequest): boolean => pullRequest.number === release.pullRequestNumber && pullRequest.url === release.pullRequestUrl && pullRequest.repository.toLowerCase() === release.repository.toLowerCase() && pullRequest.headBranch === release.headBranch && pullRequest.baseBranch === release.baseBranch && pullRequest.baseSha.toLowerCase() === release.baseSha.toLowerCase() && pullRequest.headSha.toLowerCase() === release.headSha.toLowerCase() && pullRequest.state === "open";
    const current = await this.github.getPullRequest({ repository: release.repository, number: release.pullRequestNumber });
    if (!matchesRelease(current)) throw providerFailure("ambiguous-provider-state", "The stored pull request no longer matches the reviewed revision");
    if (!current.isDraft) {
      this.database.authTransaction((db) => db.prepare("UPDATE forge_releases SET status = 'ready', updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'draft'").run(new Date().toISOString(), release.id, input.taskId, input.companyId, input.workflowId));
      return;
    }
    if (!("markReadyForReview" in this.github) || typeof this.github.markReadyForReview !== "function") throw providerFailure("provider-unavailable", "GitHub ready-for-review is unavailable");
    await this.github.markReadyForReview({ repository: release.repository, number: release.pullRequestNumber });
    const confirmed = await this.github.getPullRequest({ repository: release.repository, number: release.pullRequestNumber });
    if (!matchesRelease(confirmed) || confirmed.isDraft) throw providerFailure("ambiguous-provider-state", "GitHub did not confirm the pull request is ready for review");
    this.database.authTransaction((db) => db.prepare("UPDATE forge_releases SET status = 'ready', updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'draft'").run(new Date().toISOString(), release.id, input.taskId, input.companyId, input.workflowId));
  }

  async mergePullRequest(input: { taskId: string; companyId: string; workflowId: string; releaseId: string; repository: string; pullRequestNumber: number }): Promise<void> {
    const release = this.database.authQuery((db) => db.prepare(`SELECT repository, base_branch AS baseBranch, head_branch AS headBranch, head_sha AS headSha, pr_number AS pullRequestNumber, pr_url AS pullRequestUrl
      FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND superseded_at IS NULL`).get(input.releaseId, input.taskId, input.companyId, input.workflowId) as { repository: string; baseBranch: string; headBranch: string; headSha: string; pullRequestNumber: number | null; pullRequestUrl: string | null } | undefined);
    if (!release || release.repository.toLowerCase() !== input.repository.toLowerCase() || release.pullRequestNumber !== input.pullRequestNumber || !release.pullRequestUrl) throw providerFailure("stale-reviewed-revision", "The stored pull request no longer matches this task");
    await this.github.checkAuthentication();
    const current = await this.github.getPullRequest({ repository: release.repository, number: release.pullRequestNumber });
    if (current.repository.toLowerCase() !== release.repository.toLowerCase() || current.headBranch !== release.headBranch || current.baseBranch !== release.baseBranch || current.headSha.toLowerCase() !== release.headSha.toLowerCase() || current.state !== "open" || current.isDraft) throw providerFailure("ambiguous-provider-state", "The pull request no longer matches the reviewed revision");
    if (!this.github.mergePullRequest) throw providerFailure("provider-unavailable", "GitHub pull-request merging is unavailable");
    await this.github.mergePullRequest({ repository: release.repository, number: release.pullRequestNumber, headSha: current.headSha });
  }

  /** Push a reviewed task branch without creating a release or pull request. */
  async pushBranch(input: { repository: string; worktreePath: string; branchName: string; commitSha: string }): Promise<void> {
    await this.github.checkAuthentication();
    if ((await this.github.getRemoteRepository({ cwd: input.worktreePath })) !== input.repository.toLowerCase()) throw providerFailure("wrong-remote", "Local origin does not match the pinned repository");
    const local = await this.github.inspectLocalRevision({ cwd: input.worktreePath });
    // Uncommitted files cannot change the immutable commit being pushed.
    if (local.branch !== input.branchName) throw providerFailure("stale-reviewed-revision", "Task worktree is on another branch");
    const currentHead = local.headSha.toLowerCase();
    const remote = await this.github.getBranchHead({ repository: input.repository, branch: input.branchName });
    if (remote?.toLowerCase() !== currentHead) {
      try { await this.github.pushNormal({ cwd: input.worktreePath, branch: input.branchName }); }
      catch {
        const observed = await this.github.getBranchHead({ repository: input.repository, branch: input.branchName });
        if (observed?.toLowerCase() !== currentHead) throw providerFailure("provider-unavailable", "Branch push outcome is unconfirmed");
      }
    }
    const confirmed = await this.github.getBranchHead({ repository: input.repository, branch: input.branchName });
    if (confirmed?.toLowerCase() !== currentHead) throw providerFailure("provider-unavailable", "Branch push did not produce the current branch head");
  }

  private fail(input: PublishReleaseInput, error: unknown): never {
    const failure = error instanceof GithubReleaseFailure ? error : providerFailure("provider-unavailable", "Release provider request failed");
    const releaseKey = releaseKeyFor(input, input.coordinates, input.reviewedRevision);
    try {
      this.database.authTransaction((db) => {
        const now = new Date().toISOString();
        db.prepare("UPDATE forge_releases SET status = ?, updated_at = ? WHERE release_key = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'reconciling'").run(failure.code, now, releaseKey, input.taskId, input.companyId, input.workflowId);
        db.prepare("UPDATE forge_provider_operations SET status = ?, failure_code = ?, failure_summary = ?, retry_at = ?, updated_at = ? WHERE release_key = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status IN ('intent-recorded', 'observing')").run(failure.code === "provider-rate-limited" ? "blocked" : "failed", failure.code, failure.summary, failure.retryAt, now, releaseKey, input.taskId, input.companyId, input.workflowId);
      });
    } catch { /* Preserve the original typed release blocker when persistence is unavailable. */ }
    throw failure;
  }

  private context(input: PublishReleaseInput): { coordinates: PinnedRepositoryCoordinates; reviewed: ReviewedRevision; title: string; bodyInput: PublishReleaseInput["delivery"] } {
    const coordinates = input.coordinates;
    const reviewed = input.reviewedRevision;
    if (!repositoryPattern.test(coordinates.repository) || !coordinates.owner || !coordinates.headBranch || !coordinates.baseBranch || !coordinates.repositoryPath || !coordinates.worktreePath || !shaPattern.test(coordinates.expectedBaseSha)) throw providerFailure("pinned-configuration-incomplete", "Pinned release coordinates are incomplete");
    if (!shaPattern.test(reviewed.commitSha) || !shaPattern.test(reviewed.treeSha) || !reviewed.reviewId || !reviewed.developerExecutionId) throw providerFailure("stale-reviewed-revision", "Reviewed revision is incomplete");
    return { coordinates: { ...coordinates, repository: normalizeRepository(coordinates.repository) }, reviewed, title: input.taskTitle, bodyInput: input.delivery };
  }

  private persistIntent(input: PublishReleaseInput, coordinates: PinnedRepositoryCoordinates, reviewed: ReviewedRevision, projection: DraftPullRequestProjection, bodyArtifact: StoredArtifact): { releaseId: string; releaseKey: string } {
    const releaseKey = releaseKeyFor(input, coordinates, reviewed);
    const now = new Date().toISOString();
    const releaseId = newReleaseId();
    this.database.authTransaction((db) => {
      db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(bodyArtifact.id, bodyArtifact.companyId, bodyArtifact.kind, bodyArtifact.filename, bodyArtifact.mimeType, bodyArtifact.byteSize, bodyArtifact.sha256, bodyArtifact.storagePath, bodyArtifact.createdAt);
      db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, title, body_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconciling', ?, ?, ?, ?) ON CONFLICT(release_key) DO UPDATE SET status = 'reconciling', updated_at = excluded.updated_at").run(releaseId, input.taskId, input.companyId, input.workflowId, releaseKey, coordinates.repository, coordinates.headBranch, coordinates.baseBranch, coordinates.expectedBaseSha, reviewed.commitSha, reviewed.treeSha, projection.title, bodyArtifact.id, now, now);
      const existing = db.prepare("SELECT id FROM forge_releases WHERE release_key = ?").get(releaseKey) as { id: string };
      db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, workflow_id, project_revision_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, kind, status, attempt, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'push', 'intent-recorded', 1, ?, ?, ?) ON CONFLICT(operation_key) DO UPDATE SET status = 'intent-recorded', attempt = forge_provider_operations.attempt + 1, observed_at = NULL, completed_at = NULL, updated_at = excluded.updated_at").run(operationId(), `${releaseKey}:push`, input.taskId, input.companyId, input.workflowId, coordinates.projectRevisionId, releaseKey, coordinates.repository, coordinates.headBranch, coordinates.baseBranch, coordinates.expectedBaseSha, reviewed.commitSha, reviewed.treeSha, now, now, now);
      db.prepare("UPDATE forge_releases SET superseded_by_release_id = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND id <> ? AND superseded_at IS NOT NULL AND superseded_by_release_id IS NULL").run(existing.id, input.taskId, input.companyId, input.workflowId, existing.id);
    });
    const release = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_releases WHERE release_key = ?").get(releaseKey) as { id: string });
    return { releaseId: release.id, releaseKey };
  }

  private existingBodyArtifact(companyId: string, releaseKey: string, _expectedSha: string): StoredArtifact | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.company_id AS companyId, a.kind, a.filename, a.mime_type AS mimeType, a.byte_size AS byteSize, a.sha256, a.storage_path AS storagePath, a.created_at AS createdAt
      FROM forge_releases r JOIN forge_artifacts a ON a.id = r.body_artifact_id AND a.company_id = r.company_id AND a.kind = 'release-public-body'
      WHERE r.release_key = ? AND r.company_id = ? LIMIT 1`).get(releaseKey, companyId) as StoredArtifact | undefined);
    if (!row) return undefined;
    return row;
  }

  private updateOperation(operationKey: string, status: string, error?: GithubReleaseFailure): void {
    const now = new Date().toISOString();
    this.database.authTransaction((db) => db.prepare("UPDATE forge_provider_operations SET status = ?, failure_code = ?, failure_summary = ?, retry_at = ?, observed_at = CASE WHEN ? IN ('completed', 'observing', 'observed-absent') THEN ? ELSE observed_at END, completed_at = CASE WHEN ? IN ('completed', 'failed', 'blocked') THEN ? ELSE completed_at END, updated_at = ? WHERE operation_key = ?").run(status, error?.code ?? null, error?.summary ?? null, error?.retryAt ?? null, status, now, status, now, now, operationKey));
  }

  private async observeHead(coordinates: PinnedRepositoryCoordinates, operationKey: string): Promise<string | null> {
    this.updateOperation(operationKey, "observing");
    try { return await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch }); } catch (error) {
      if (error instanceof GithubReleaseFailure) throw error;
      throw providerFailure("provider-unavailable", "Remote branch observation failed");
    }
  }

  private operationAttempt(releaseKey: string): number {
    const row = this.database.authQuery((db) => db.prepare("SELECT MAX(COALESCE(attempt, 0)) AS attempt FROM forge_provider_operations WHERE release_key = ? AND kind IN ('push', 'create-draft-pr', 'update-draft-pr')").get(releaseKey) as { attempt: number | null });
    return row.attempt ?? 0;
  }

  private async publishExisting(input: PublishReleaseInput, coordinates: PinnedRepositoryCoordinates, reviewed: ReviewedRevision, projection: DraftPullRequestProjection): Promise<PublishReleaseResult> {
    const release = this.database.authQuery((db) => db.prepare(`SELECT id, release_key AS releaseKey, repository, head_branch AS headBranch, base_branch AS baseBranch, head_sha AS priorHeadSha, pr_number AS pullRequestNumber, pr_url AS pullRequestUrl
      FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND superseded_at IS NULL`).get(input.releaseId, input.taskId, input.companyId, input.workflowId) as { id: string; releaseKey: string; repository: string; headBranch: string; baseBranch: string; priorHeadSha: string; pullRequestNumber: number | null; pullRequestUrl: string | null } | undefined);
    if (!release || release.repository.toLowerCase() !== coordinates.repository || release.headBranch !== coordinates.headBranch || release.baseBranch !== coordinates.baseBranch || release.pullRequestNumber === null || !release.pullRequestUrl) throw providerFailure("stale-reviewed-revision", "Existing release identity does not match the pinned repository and pull request");
    const bodyArtifact = await this.artifacts.putArtifact(input.companyId, "release-public-body", { filename: `${input.taskId}-release.md`, mimeType: "text/markdown", bytes: Buffer.from(projection.body, "utf8") });
    const operationKey = `${release.id}:${reviewed.commitSha}:push`;
    const now = new Date().toISOString();
    this.database.authTransaction((db) => {
      db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(bodyArtifact.id, bodyArtifact.companyId, bodyArtifact.kind, bodyArtifact.filename, bodyArtifact.mimeType, bodyArtifact.byteSize, bodyArtifact.sha256, bodyArtifact.storagePath, bodyArtifact.createdAt);
      db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, workflow_id, project_revision_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, kind, status, attempt, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'push', 'intent-recorded', 1, ?, ?, ?) ON CONFLICT(operation_key) DO UPDATE SET status = 'intent-recorded', attempt = forge_provider_operations.attempt + 1, observed_at = NULL, completed_at = NULL, updated_at = excluded.updated_at").run(operationId(), operationKey, input.taskId, input.companyId, input.workflowId, coordinates.projectRevisionId, release.releaseKey, coordinates.repository, coordinates.headBranch, coordinates.baseBranch, coordinates.expectedBaseSha, reviewed.commitSha, reviewed.treeSha, now, now, now);
    });
    const remoteHead = await this.observeHead(coordinates, operationKey);
    if (remoteHead !== null && remoteHead.toLowerCase() !== reviewed.commitSha.toLowerCase()) throw providerFailure("remote-head-conflict", "Remote task branch no longer matches the reviewed revision");
    if (remoteHead === null) {
      try { await this.github.pushNormal({ cwd: coordinates.worktreePath, branch: coordinates.headBranch }); } catch {
        const observed = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch });
        if (observed?.toLowerCase() !== reviewed.commitSha.toLowerCase()) throw providerFailure(observed === null ? "provider-unavailable" : "remote-head-conflict", "Normal push outcome is unconfirmed");
      }
      const confirmed = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch });
      if (confirmed?.toLowerCase() !== reviewed.commitSha.toLowerCase()) throw providerFailure(confirmed === null ? "provider-unavailable" : "remote-head-conflict", "Normal push did not produce the reviewed remote head");
    }
    let pullRequest = await this.github.getPullRequest({ repository: coordinates.repository, number: release.pullRequestNumber });
    if (pullRequest.repository.toLowerCase() !== coordinates.repository || pullRequest.headBranch !== coordinates.headBranch || pullRequest.baseBranch !== coordinates.baseBranch || pullRequest.baseSha.toLowerCase() !== coordinates.expectedBaseSha.toLowerCase() || pullRequest.headSha.toLowerCase() !== reviewed.commitSha.toLowerCase() || pullRequest.state !== "open") throw providerFailure("ambiguous-provider-state", "Stored pull request no longer matches the reviewed revision");
    this.database.authTransaction((db) => {
      db.prepare("UPDATE forge_provider_operations SET status = 'completed', completed_at = ?, updated_at = ? WHERE operation_key = ?").run(now, now, operationKey);
      db.prepare("UPDATE forge_releases SET base_sha = ?, head_sha = ?, head_tree = ?, status = 'draft', title = ?, body_artifact_id = ?, reused = 1, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").run(coordinates.expectedBaseSha, reviewed.commitSha, reviewed.treeSha, projection.title, bodyArtifact.id, now, release.id, input.taskId, input.companyId, input.workflowId);
    });
    return { releaseId: release.id, repository: coordinates.repository, branchName: coordinates.headBranch, baseBranch: coordinates.baseBranch, headSha: reviewed.commitSha, headTree: reviewed.treeSha, pullRequest, reused: true, attempt: this.operationAttempt(release.releaseKey) };
  }

  async publish(input: PublishReleaseInput): Promise<PublishReleaseResult> {
    let context: ReturnType<ReleaseService["context"]>;
    try { context = this.context(input); } catch (error) { return this.fail(input, error); }
    const { coordinates, reviewed, title, bodyInput } = context;
    try {
      // A member delivery decision recorded after a blocking review accepts that review for publication.
      const review = this.database.authQuery((db) => db.prepare("SELECT r.outcome, r.base_sha AS baseSha, r.subject_commit AS commitSha, r.subject_tree AS treeSha, EXISTS (SELECT 1 FROM forge_delivery_decisions dd WHERE dd.task_id = r.task_id AND dd.workflow_id = r.workflow_id AND dd.created_at >= r.created_at) AS decided FROM forge_delivery_reviews r WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ?").get(reviewed.reviewId, input.taskId, input.companyId, input.workflowId) as { outcome: string; baseSha: string; commitSha: string; treeSha: string; decided: number } | undefined);
      if (!review || (review.outcome !== "approved" && !review.decided)) throw providerFailure("stale-reviewed-revision", "An approved review is unavailable");
      await this.github.checkAuthentication();
      if ((await this.github.getRemoteRepository({ cwd: coordinates.worktreePath })) !== coordinates.repository.toLowerCase()) throw providerFailure("wrong-remote", "Local origin does not match the pinned repository");
      const local = await this.github.inspectLocalRevision({ cwd: coordinates.worktreePath });
      if (!local.clean || local.branch !== coordinates.headBranch || local.headSha.toLowerCase() !== reviewed.commitSha.toLowerCase() || local.treeSha.toLowerCase() !== reviewed.treeSha.toLowerCase()) throw providerFailure("stale-reviewed-revision", "Local worktree no longer matches the exact reviewed revision");
      const base = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.baseBranch });
      if (base === null) throw providerFailure("provider-unavailable", "Target base branch is unavailable");
      if (base.toLowerCase() !== coordinates.expectedBaseSha.toLowerCase()) throw providerFailure("target-base-drift", "Target base moved after delivery review");
      const existingHead = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch });
      if (existingHead !== null && existingHead.toLowerCase() !== reviewed.commitSha.toLowerCase()) throw providerFailure("remote-head-conflict", "Remote task branch no longer matches the reviewed revision");
      const projection = buildDraftPullRequestProjection({ taskTitle: title, ...(input.gitPresentation ?? {}), ...(bodyInput.summary ? { deliverySummary: bodyInput.summary } : {}), ...(bodyInput.changes ? { changes: bodyInput.changes } : {}), ...(bodyInput.filesChanged ? { filesChanged: bodyInput.filesChanged } : {}), ...(bodyInput.commandsRun ? { commandsRun: bodyInput.commandsRun } : {}), ...(bodyInput.testResults ? { testResults: bodyInput.testResults } : {}) });
      if (input.releaseId) return await this.publishExisting(input, coordinates, reviewed, projection);
      const releaseKey = releaseKeyFor(input, coordinates, reviewed);
      const bodyArtifact = this.existingBodyArtifact(input.companyId, releaseKey, projection.bodySha256) ?? await this.artifacts.putArtifact(input.companyId, "release-public-body", { filename: `${input.taskId}-release.md`, mimeType: "text/markdown", bytes: Buffer.from(projection.body, "utf8") });
      const { releaseId } = this.persistIntent(input, coordinates, reviewed, projection, bodyArtifact);
      const pushKey = `${releaseKey}:push`;
      const remoteHead = await this.observeHead(coordinates, pushKey);
      if (remoteHead !== null && remoteHead.toLowerCase() !== reviewed.commitSha.toLowerCase()) throw providerFailure("remote-head-conflict", "Remote task branch no longer matches the reviewed revision");
      if (remoteHead === null) {
        try {
          await this.github.pushNormal({ cwd: coordinates.worktreePath, branch: coordinates.headBranch });
        } catch {
          try {
            const observed = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch });
            if (observed?.toLowerCase() === reviewed.commitSha.toLowerCase()) this.updateOperation(pushKey, "completed");
            else if (observed === null) { const failure = providerFailure("provider-unavailable", "Normal push outcome is unconfirmed"); this.updateOperation(pushKey, "observed-absent", failure); throw failure; }
            else { const failure = providerFailure("remote-head-conflict", "Remote task branch no longer matches the reviewed revision"); this.updateOperation(pushKey, "failed", failure); throw failure; }
          } catch (observationError) {
            if (observationError instanceof GithubReleaseFailure) throw observationError;
            throw providerFailure("provider-unavailable", "Remote push outcome could not be observed");
          }
        }
        const confirmed = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch });
        if (confirmed?.toLowerCase() !== reviewed.commitSha.toLowerCase()) throw providerFailure(confirmed === null ? "provider-unavailable" : "remote-head-conflict", "Normal push did not produce the reviewed remote head");
        this.updateOperation(pushKey, "completed");
      } else this.updateOperation(pushKey, "completed");

      const identity = { repository: coordinates.repository, owner: coordinates.owner, headBranch: coordinates.headBranch, baseBranch: coordinates.baseBranch };
      const openCandidate = (candidate: GithubPullRequest) => candidate.repository.toLowerCase() === coordinates.repository.toLowerCase() && candidate.headBranch === coordinates.headBranch && candidate.baseBranch === coordinates.baseBranch && candidate.baseSha.toLowerCase() === coordinates.expectedBaseSha.toLowerCase() && candidate.headSha.toLowerCase() === reviewed.commitSha.toLowerCase() && candidate.state === "open";
      const candidates = await this.github.listPullRequests(identity);
      let pullRequest = candidates.find(openCandidate);
      let reused = true;
      if (!pullRequest) {
        const createKey = `${releaseKey}:create-draft-pr`;
        this.database.authTransaction((db) => {
          const now = new Date().toISOString();
          db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, workflow_id, project_revision_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, kind, status, attempt, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create-draft-pr', 'intent-recorded', 1, ?, ?, ?) ON CONFLICT(operation_key) DO UPDATE SET status = 'intent-recorded', attempt = forge_provider_operations.attempt + 1, observed_at = NULL, completed_at = NULL, updated_at = excluded.updated_at").run(operationId(), createKey, input.taskId, input.companyId, input.workflowId, coordinates.projectRevisionId, releaseKey, coordinates.repository, coordinates.headBranch, coordinates.baseBranch, coordinates.expectedBaseSha, reviewed.commitSha, reviewed.treeSha, now, now, now);
        });
        const beforeCreate = await this.github.listPullRequests(identity);
        const validBeforeCreate = beforeCreate.find(openCandidate);
        if (validBeforeCreate) pullRequest = validBeforeCreate;
        else {
          try { pullRequest = await this.github.createDraftPullRequest({ ...identity, title: projection.title, body: projection.body }); } catch (error) {
            const afterCreate = await this.github.listPullRequests(identity);
            const recovered = afterCreate.find(openCandidate);
            if (recovered) pullRequest = recovered;
            else throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "draft pull request creation");
          }
          reused = false;
        }
        const createdPullRequest = pullRequest;
        if (!createdPullRequest) throw providerFailure("invalid-provider-response", "GitHub did not return a pull request");
        const authoritative = await this.github.getPullRequest({ repository: coordinates.repository, number: createdPullRequest.number });
        if (!openCandidate(authoritative)) throw providerFailure("ambiguous-provider-state", "Created pull request is not open for the task branch");
        pullRequest = authoritative;
        this.updateOperation(createKey, "completed");
      }
      if (!pullRequest) throw providerFailure("invalid-provider-response", "GitHub did not return a pull request");
      // A manually created PR is authoritative for its title, body, and draft
      // state. Publishing adopts it instead of rewriting a human choice.
      const now = new Date().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_releases SET status = 'draft', pr_number = ?, pr_url = ?, reused = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").run(pullRequest.number, pullRequest.url, reused ? 1 : 0, now, releaseId, input.taskId, input.companyId, input.workflowId);
      });
      return { releaseId, repository: coordinates.repository, branchName: coordinates.headBranch, baseBranch: coordinates.baseBranch, headSha: reviewed.commitSha, headTree: reviewed.treeSha, pullRequest, reused, attempt: this.operationAttempt(releaseKey) };
    } catch (error) {
      return this.fail(input, error);
    }
  }
}
