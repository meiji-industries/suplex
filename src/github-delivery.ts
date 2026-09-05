
import { z } from "zod";

import { runCommand } from "./command-runner.js";

type GithubFailureCode = "authentication-required" | "invalid-provider-response" | "wrong-remote" | "local-revision-unavailable" | "provider-rate-limited" | "provider-unavailable";

const shaPattern = /^[a-f0-9]{40,64}$/i;
const repositoryPattern = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/i;
const MAX_OUTPUT = 256 * 1024;

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
  checks: { total: number; pending: number; failing: number; successful: number; runs: Array<{ name: string; status: "pending" | "failing" | "successful"; url: string | null }> };
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
  pushNormal(input: { cwd: string; branch: string; headSha: string }): Promise<void>;
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
  isCrossRepository: z.boolean(),
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

function providerFailure(code: GithubFailureCode, summary = "GitHub provider request failed", retryAt: string | null = null): GithubReleaseFailure {
  return new GithubReleaseFailure(code, summary, retryAt);
}

export class GithubReleaseFailure extends Error {
  constructor(readonly code: GithubFailureCode, readonly summary = "GitHub release failed", readonly retryAt: string | null = null) {
    super(summary);
    this.name = "GithubReleaseFailure";
  }
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
  const summary: GithubPullRequestObservation["checks"] = { total: 0, pending: 0, failing: 0, successful: 0, runs: [] };
  for (const [name, { check }] of latest) {
    summary.total += 1;
    let status: "pending" | "failing" | "successful";
    if (check.status === undefined) {
      status = check.state === "SUCCESS" ? "successful" : check.state === "FAILURE" || check.state === "ERROR" ? "failing" : "pending";
    } else if (check.status !== "COMPLETED") status = "pending";
    else status = check.conclusion === "SUCCESS" || check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED" ? "successful" : "failing";
    summary[status] += 1;
    const url = z.string().url().safeParse(check.detailsUrl ?? check.targetUrl);
    summary.runs.push({ name, status, url: url.success ? url.data : null });
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
    const parsed = RestErrorSchema.parse(JSON.parse(value));
    return { status: Number(parsed.status), message: parsed.message };
  } catch {
    return undefined;
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw providerFailure("invalid-provider-response", "GitHub returned invalid JSON"); }
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

export function createGithubReleasePort(options: GithubReleasePortOptions = {}): Required<GithubReleaseAdapter> {
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
        if (allowNotFound && !parsed && /\bHTTP 404\b/.test(error.result.stderr)) return null;
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
        throw providerFailure("local-revision-unavailable", "Local Git revision could not be inspected");
      }
    },
    async pushNormal(input) {
      if (!shaPattern.test(input.headSha)) throw providerFailure("invalid-provider-response", "The push commit is invalid");
      try { await runGit(["push", "origin", `${input.headSha}:refs/heads/${input.branch}`], { cwd: input.cwd, timeout: 60_000, maxBuffer: 64 * 1024 }); } catch (error) { throw classifyCommandFailure(error, "normal push"); }
    },
    async listPullRequests(input) {
      let value: unknown;
      try { value = parseJson((await runGh(["pr", "list", "--repo", input.repository, "--head", input.headBranch, "--state", "all", "--limit", "100", "--json", "number,url,isDraft,state,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository"])).stdout); } catch (error) { throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "pull request list"); }
      const rows = PullListResponseSchema.safeParse(value);
      if (!rows.success) throw providerFailure("invalid-provider-response", "GitHub pull request list could not be parsed");
      return rows.data.map((row) => ({ number: row.number, url: row.url, repository: normalizeRepository(input.repository), headBranch: row.headRefName, baseBranch: row.baseRefName, headSha: row.headRefOid, baseSha: row.baseRefOid, isDraft: row.isDraft, state: row.state.toLowerCase() as GithubPullRequest["state"], mergedAt: null, title: row.title, body: row.body, author: row.author?.login ?? "", ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }), isCrossRepository: row.isCrossRepository }));
    },
    async listOpenPullRequests(input) {
      let value: unknown;
      try { value = parseJson((await runGh(["pr", "list", "--repo", input.repository, "--state", "open", "--limit", String(Math.min(100, Math.max(1, input.limit))), "--json", "number,url,isDraft,state,headRefName,headRefOid,baseRefName,baseRefOid,title,body,author,updatedAt,isCrossRepository"])).stdout); } catch (error) { throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "pull request list"); }
      const rows = PullListResponseSchema.safeParse(value);
      if (!rows.success) throw providerFailure("invalid-provider-response", "GitHub pull request list could not be parsed");
      return rows.data.map((row) => ({ number: row.number, url: row.url, repository: normalizeRepository(input.repository), headBranch: row.headRefName, baseBranch: row.baseRefName, headSha: row.headRefOid, baseSha: row.baseRefOid, isDraft: row.isDraft, state: row.state.toLowerCase() as GithubPullRequest["state"], mergedAt: null, title: row.title, body: row.body, author: row.author?.login ?? "", ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }), isCrossRepository: row.isCrossRepository }));
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
      if (number === null) return { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, author: null, changedFiles: null, additions: null, deletions: null, autoMergeEnabled: null, reviewDecision: null };
      try {
        const raw = parseJson((await runGh(["pr", "view", String(number), "--repo", input.repository, "--json", "number,url,state,isDraft,headRefOid,baseRefOid,mergeable,autoMergeRequest,reviewDecision,author,changedFiles,additions,deletions,statusCheckRollup"])).stdout);
        return mapGithubPullRequestObservation(raw);
      } catch (error) {
        if (error instanceof GithubCommandFailure && /not found/i.test(`${error.result.stdout}\n${error.result.stderr}`)) return { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, author: null, changedFiles: null, additions: null, deletions: null, autoMergeEnabled: null, reviewDecision: null };
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
      const repo = z.object({ allow_squash_merge: z.boolean(), allow_merge_commit: z.boolean(), allow_rebase_merge: z.boolean() }).parse(await api(["api", `repos/${input.repository}`], "repository settings"));
      const method = repo.allow_squash_merge ? "--squash" : repo.allow_merge_commit ? "--merge" : repo.allow_rebase_merge ? "--rebase" : null;
      if (!method) throw providerFailure("provider-unavailable", "The repository does not allow a merge method");
      try { await runGh(["pr", "merge", String(input.number), "--repo", input.repository, method, "--match-head-commit", input.headSha]); } catch (error) { throw classifyCommandFailure(error, "merge pull request"); }
    },
  };
}
