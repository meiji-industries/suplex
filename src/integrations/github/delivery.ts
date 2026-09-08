import { GithubIssueSchema, GithubIssueCommentSchema, issueFields, type GithubIssue, type GithubIssueDetails } from "./issues.js";

import { z } from "zod";

import { runCommand } from "../../platform/command-runner.js";
import { redact } from "../../platform/logging.js";
import { createGithubTriggerPort, type GithubTriggerPort } from "./trigger-inspection.js";
import { GithubReleaseFailure, type GithubFailureCode } from "./failure.js";

export { GithubReleaseFailure } from "./failure.js";


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
  /** GitHub's merge-state rollup (CLEAN, BLOCKED, BEHIND, DIRTY, DRAFT, HAS_HOOKS, UNKNOWN, UNSTABLE). Unknown never means ready. */
  mergeStateStatus: string | null;
  checks: { total: number; pending: number; failing: number; successful: number; runs: Array<{ name: string; status: "pending" | "failing" | "successful"; url: string | null; conclusion?: string }> };
  author?: { login: string; avatarUrl: string } | null;
  changedFiles?: number | null;
  additions?: number | null;
  deletions?: number | null;
  autoMergeEnabled: boolean | null;
  reviewDecision: string | null;
}

export type GithubConditionalMergeResult =
  | { merged: true; sha: string }
  | { merged: false; sha: null }
  | { merged: false; sha: null; disposition: "blocked" | "waiting" | "queued"; message: string };

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
  listOpenIssues?(input: { repository: string; limit: number }): Promise<GithubIssue[]>;
  getIssue?(input: { repository: string; number: number }): Promise<GithubIssueDetails>;
  listOpenPullRequests?(input: { repository: string; limit: number }): Promise<GithubPullRequest[]>;
  createDraftPullRequest(input: DraftPullRequestCreate): Promise<GithubPullRequest>;
  updateDraftPullRequest(input: DraftPullRequestUpdate): Promise<GithubPullRequest>;
  getPullRequest(input: { repository: string; number: number }): Promise<GithubPullRequest>;
  observePullRequest?(input: { repository: string; branch: string; pullRequestNumber?: number | null }): Promise<GithubPullRequestObservation>;
  mergePullRequest?(input: { repository: string; number: number; headSha: string }): Promise<GithubConditionalMergeResult | void>;
  mergePullRequestDirect?(input: { repository: string; number: number; headSha: string }): Promise<GithubConditionalMergeResult>;
}

export type GithubAcceptancePort = Pick<GithubReleasePort, "getBranchHead" | "getPullRequest"> & {
  markReadyForReview(input: { repository: string; number: number }): Promise<void>;
  mergePullRequest?(input: { repository: string; number: number; headSha: string }): Promise<GithubConditionalMergeResult | void>;
  mergePullRequestDirect?(input: { repository: string; number: number; headSha: string }): Promise<GithubConditionalMergeResult>;
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
  mergeStateStatus: z.string().nullable().optional(),
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
const AcceptedApiFailureSchema = z.object({ kind: z.literal("accepted-failure"), status: z.number().int(), message: z.string().min(1) });
const ConditionalMergeResponseSchema = z.object({ merged: z.boolean(), message: z.string(), sha: z.string().nullable().optional() });
const RequiredCheckSchema = z.object({ name: z.string().min(1), bucket: z.enum(["pass", "fail", "pending", "skipping", "cancel"]), state: z.string().min(1), link: z.string().url().optional() });
const PullMergeContextSchema = z.object({ id: z.string().min(1), headRefOid: z.string().regex(shaPattern), baseRefName: z.string().min(1), mergeable: z.string().nullable(), mergeStateStatus: z.string().nullable() });
const BranchRulesSchema = z.array(z.object({ type: z.string().min(1) }).passthrough());
const EnqueueResponseSchema = z.object({ data: z.object({ enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ id: z.string().min(1) }) }) }) });

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
    summary.runs.push({ name, status, url: url.success ? url.data : null, ...(check.conclusion ? { conclusion: check.conclusion } : {}) });
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
    mergeStateStatus: pull.mergeStateStatus ?? null,
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

function diagnostic(error: GithubCommandFailure): string {
  const parsed = restError(error.result.stdout);
  const text = (parsed?.message ?? error.result.stderr.trim() ?? "").split("\n")[0] ?? "";
  // Provider messages can echo a token; never carry one into a question or log.
  return redactProviderSummary(text);
}

function redactProviderSummary(summary: string): string {
  return String(redact(summary.split("\n")[0]?.slice(0, 200) ?? "")).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,})\b/g, "[redacted]");
}

/** Rate limiting needs evidence: HTTP 429, or a 403 whose message says so. A bare 403 is an access problem. */
function isRateLimited(error: GithubCommandFailure): boolean {
  const parsed = restError(error.result.stdout);
  const text = `${error.result.stdout}\n${error.result.stderr}`;
  if (parsed?.status === 429 || /\bHTTP 429\b/.test(text)) return true;
  return (parsed?.status === 403 || /\bHTTP 403\b/.test(text)) && /rate limit|secondary rate|abuse/i.test(text);
}

function isUnauthenticated(error: GithubCommandFailure): boolean {
  const parsed = restError(error.result.stdout);
  const text = `${error.result.stdout}\n${error.result.stderr}`;
  return parsed?.status === 401 || /\bHTTP 401\b|Bad credentials|gh auth login|not logged in|authentication token|token is invalid|token has expired|GH_TOKEN/i.test(text);
}

function isForbidden(error: GithubCommandFailure): boolean {
  const parsed = restError(error.result.stdout);
  return parsed?.status === 403 || /\bHTTP 403\b/.test(`${error.result.stdout}\n${error.result.stderr}`);
}

function classifyCommandFailure(error: unknown, operation: string): GithubReleaseFailure {
  if (!(error instanceof GithubCommandFailure)) return providerFailure("provider-unavailable", operation);
  if (isRateLimited(error)) return providerFailure("provider-rate-limited", diagnostic(error) || "GitHub limited requests");
  if (operation === "authentication" || isUnauthenticated(error)) return providerFailure("authentication-required", `GitHub CLI authentication is unavailable: ${diagnostic(error) || "sign in with gh auth login"}`);
  if (isForbidden(error)) return providerFailure("authentication-required", `GitHub denied access to this repository or token permission: ${diagnostic(error) || "HTTP 403"}`);
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

export function createGithubReleasePort(options: GithubReleasePortOptions = {}): Required<GithubReleaseAdapter> & GithubTriggerPort {
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
  const api = async (args: string[], operation: string, allowNotFound = false, notFoundSummary?: string, acceptedFailureStatuses: readonly number[] = []): Promise<unknown> => {
    try { return parseJson((await runGh(args)).stdout); } catch (error) {
      if (error instanceof GithubReleaseFailure) throw error;
      if (error instanceof GithubCommandFailure) {
        const parsed = restError(error.result.stdout);
        const textStatus = /\bHTTP (\d{3})\b/.exec(error.result.stderr)?.[1];
        const status = parsed?.status ?? (textStatus ? Number(textStatus) : undefined);
        if (status !== undefined && acceptedFailureStatuses.includes(status)) return { kind: "accepted-failure", status, message: diagnostic(error) || `GitHub refused the request with HTTP ${status}` };
        if (allowNotFound && parsed?.status === 404) return null;
        // GitHub sometimes returns plain-text 404s. Treat them as an absent
        // observation; the next operation will adopt what GitHub reports.
        if (allowNotFound && !parsed && /\bHTTP 404\b/.test(error.result.stderr)) return null;
        if (parsed?.status === 404) throw providerFailure("provider-unavailable", notFoundSummary ?? "GitHub resource was not found or is inaccessible");
        if (isRateLimited(error)) {
          const retryAt = await retryAtFromRateLimit();
          if (retryAt) throw providerFailure("provider-rate-limited", diagnostic(error), retryAt);
          throw providerFailure("provider-rate-limited", diagnostic(error) || "GitHub limited requests");
        }
      }
      throw classifyCommandFailure(error, operation);
    }
  };
  const pull = (value: unknown): GithubPullRequest => normalizeGithubPull(value);
  const retryTransientObservation = async <T>(observe: () => Promise<T>): Promise<T> => {
    try { return await observe(); }
    catch (error) {
      if (!(error instanceof GithubReleaseFailure) || error.code !== "provider-unavailable") throw error;
      return observe();
    }
  };
  const requiredChecks = async (repository: string, number: number): Promise<z.infer<typeof RequiredCheckSchema>[]> => {
    const args = ["pr", "checks", String(number), "--repo", repository, "--required", "--json", "name,bucket,state,link"];
    try {
      return z.array(RequiredCheckSchema).parse(parseJson((await runGh(args)).stdout));
    } catch (error) {
      if (error instanceof GithubCommandFailure) {
        const parsed = z.array(RequiredCheckSchema).safeParse((() => { try { return JSON.parse(error.result.stdout) as unknown; } catch { return null; } })());
        if (parsed.success) return parsed.data;
      }
      if (error instanceof GithubReleaseFailure) throw error;
      throw classifyCommandFailure(error, "required pull request checks");
    }
  };
  const mergeConditionally = async (input: { repository: string; number: number; headSha: string }, allowQueue: boolean): Promise<GithubConditionalMergeResult> => {
    if (!Number.isInteger(input.number) || input.number < 1 || !shaPattern.test(input.headSha)) throw providerFailure("invalid-provider-response", "The pull request merge input is invalid");
    const repository = normalizeRepository(input.repository);
    const repo = z.object({ allow_squash_merge: z.boolean(), allow_merge_commit: z.boolean(), allow_rebase_merge: z.boolean() }).parse(await api(["api", `repos/${repository}`], "repository settings"));
    const method = repo.allow_squash_merge ? "squash" : repo.allow_merge_commit ? "merge" : repo.allow_rebase_merge ? "rebase" : null;
    if (!method) throw providerFailure("provider-unavailable", "The repository does not allow a merge method");
    const value = await api(["api", "--method", "PUT", `repos/${repository}/pulls/${input.number}/merge`, "-f", `sha=${input.headSha}`, "-f", `merge_method=${method}`], "conditional pull request merge", false, undefined, [405]);
    const acceptedFailure = AcceptedApiFailureSchema.safeParse(value);
    if (acceptedFailure.success) {
      const context = await retryTransientObservation(async () => {
        try { return PullMergeContextSchema.parse(parseJson((await runGh(["pr", "view", String(input.number), "--repo", repository, "--json", "id,headRefOid,baseRefName,mergeable,mergeStateStatus"])).stdout)); }
        catch (error) { if (error instanceof GithubReleaseFailure) throw error; throw classifyCommandFailure(error, "pull request merge observation"); }
      });
      if (context.headRefOid !== input.headSha) return { merged: false, sha: null, disposition: "blocked", message: `GitHub refused the exact-head merge because the pull request head changed from ${input.headSha} to ${context.headRefOid}. ${acceptedFailure.data.message}` };
      const checks = await retryTransientObservation(() => requiredChecks(repository, input.number));
      const failed = checks.filter(check => check.bucket === "fail" || check.bucket === "cancel");
      if (failed.length > 0) return { merged: false, sha: null, disposition: "blocked", message: `GitHub refused the merge because required checks failed: ${failed.map(check => `${check.name} (${check.state}${check.link ? `, ${check.link}` : ""})`).join(", ")}. ${acceptedFailure.data.message}` };
      const pending = checks.filter(check => check.bucket === "pending");
      if (pending.length > 0) return { merged: false, sha: null, disposition: "waiting", message: `GitHub is waiting for required checks: ${pending.map(check => `${check.name} (${check.state}${check.link ? `, ${check.link}` : ""})`).join(", ")}. ${acceptedFailure.data.message}` };
      if (context.mergeable === "CONFLICTING" || context.mergeStateStatus === "DIRTY") return { merged: false, sha: null, disposition: "blocked", message: `GitHub refused the merge because the pull request has merge conflicts (${context.mergeable ?? "UNKNOWN"}/${context.mergeStateStatus ?? "UNKNOWN"}). ${acceptedFailure.data.message}` };
      if (context.mergeable === "UNKNOWN") return { merged: false, sha: null, disposition: "waiting", message: `GitHub is still computing mergeability. ${acceptedFailure.data.message}` };
      const rules = await retryTransientObservation(async () => BranchRulesSchema.parse(await api(["api", `repos/${repository}/rules/branches/${encodeURIComponent(context.baseRefName)}`], "branch rules")));
      if (rules.some(rule => rule.type === "merge_queue")) {
        if (!allowQueue) return { merged: false, sha: null, disposition: "blocked", message: `GitHub requires a merge queue for ${context.baseRefName}, but direct trigger merges cannot enter the queue.` };
        const query = "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid}){mergeQueueEntry{id}}}";
        EnqueueResponseSchema.parse(await api(["api", "graphql", "-f", `query=${query}`, "-f", `pullRequestId=${context.id}`, "-f", `expectedHeadOid=${input.headSha}`], "merge queue enqueue"));
        return { merged: false, sha: null, disposition: "queued", message: `GitHub added pull request ${input.number} at ${input.headSha} to the merge queue.` };
      }
      return { merged: false, sha: null, disposition: "blocked", message: `GitHub refused the merge with no pending required checks or merge queue: ${acceptedFailure.data.message}. Merge state is ${context.mergeStateStatus ?? "UNKNOWN"}.` };
    }
    const response = ConditionalMergeResponseSchema.safeParse(value);
    if (!response.success || (response.data.merged && (!response.data.sha || !shaPattern.test(response.data.sha)))) throw providerFailure("invalid-provider-response", "GitHub did not confirm the conditional merge result");
    return response.data.merged ? { merged: true, sha: response.data.sha! } : { merged: false, sha: null };
  };
  return {
    ...createGithubTriggerPort(async (args, operation) => {
      try { return await api(args, operation); } catch (error) {
        if (error instanceof GithubReleaseFailure) throw new GithubReleaseFailure(error.code, redactProviderSummary(error.summary), error.retryAt);
        throw error;
      }
    }),
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
    async listOpenIssues(input) {
      return z.array(GithubIssueSchema).parse(parseJson((await runGh(["issue", "list", "--repo", input.repository, "--state", "open", "--limit", String(Math.min(100, Math.max(1, input.limit))), "--json", issueFields])).stdout));
    },
    async getIssue(input) {
      const issue = GithubIssueSchema.parse(parseJson((await runGh(["issue", "view", String(input.number), "--repo", input.repository, "--json", issueFields])).stdout));
      const pages = z.array(z.array(GithubIssueCommentSchema)).parse(parseJson((await runGh(["api", "--paginate", "--slurp", `repos/${input.repository}/issues/${input.number}/comments?per_page=100`], { maxBuffer: 16 * 1024 * 1024 })).stdout));
      return { ...issue, comments: pages.flat() };
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
      if (number === null) return { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, mergeStateStatus: null, checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, author: null, changedFiles: null, additions: null, deletions: null, autoMergeEnabled: null, reviewDecision: null };
      try {
        const raw = parseJson((await runGh(["pr", "view", String(number), "--repo", input.repository, "--json", "number,url,state,isDraft,headRefOid,baseRefOid,mergeable,mergeStateStatus,autoMergeRequest,reviewDecision,author,changedFiles,additions,deletions,statusCheckRollup"])).stdout);
        return mapGithubPullRequestObservation(raw);
      } catch (error) {
        if (error instanceof GithubCommandFailure && /not found/i.test(`${error.result.stdout}\n${error.result.stderr}`)) return { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, mergeStateStatus: null, checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, author: null, changedFiles: null, additions: null, deletions: null, autoMergeEnabled: null, reviewDecision: null };
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
      await mergeConditionally(input, true);
    },
    async mergePullRequestDirect(input) {
      return mergeConditionally(input, false);
    },
  };
}
