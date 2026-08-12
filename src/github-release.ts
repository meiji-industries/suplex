import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { z } from "zod";

import type { ArtifactStore, StoredArtifact } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";
import type { ReleaseFailureCode } from "./release-failures.js";

const execFileAsync = promisify(execFile);
const shaPattern = /^[a-f0-9]{40,64}$/i;
const repositoryPattern = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/;
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

export interface GithubReleasePort {
  checkAuthentication(): Promise<void>;
  getRemoteRepository(input: { cwd: string }): Promise<string>;
  getBranchHead(input: { repository: string; branch: string }): Promise<string | null>;
  inspectLocalRevision(input: { cwd: string }): Promise<LocalRevision>;
  pushNormal(input: { cwd: string; branch: string }): Promise<void>;
  listPullRequests(input: ExactPullRequestIdentity): Promise<GithubPullRequest[]>;
  createDraftPullRequest(input: DraftPullRequestCreate): Promise<GithubPullRequest>;
  getPullRequest(input: { repository: string; number: number }): Promise<GithubPullRequest>;
}

export type GithubAcceptancePort = Pick<GithubReleasePort, "getBranchHead" | "getPullRequest"> & {
  markReadyForReview(input: { repository: string; number: number }): Promise<void>;
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
}

const BranchResponseSchema = z.object({ commit: z.object({ sha: z.string().regex(shaPattern) }) });
const RepositorySchema = z.string().regex(repositoryPattern).transform((value) => value.toLowerCase());
const RestErrorSchema = z.object({
  message: z.string().min(1).max(500),
  documentation_url: z.string().url().refine((value) => new URL(value).hostname === "docs.github.com", "unexpected documentation host"),
  status: z.union([z.number().int(), z.string().regex(/^\d{3}$/)]),
});
const PullResponseSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: z.string().datetime().nullable(),
  head: z.object({ ref: z.string().min(1).max(256), sha: z.string().regex(shaPattern), repo: z.object({ full_name: RepositorySchema }) }),
  base: z.object({ ref: z.string().min(1).max(256), sha: z.string().regex(shaPattern), repo: z.object({ full_name: RepositorySchema }) }),
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

function safeSummary(value: unknown): string {
  const redacted = String(redact(typeof value === "string" ? value : "provider command failed"));
  return redacted.replace(/(?:\/private)?\/(?:Users|home|var|tmp)\/[^\s)]+/g, "[path-redacted]").replace(/(?:prompt|reasoning|credential|token|authorization)[:=][^\n]*/gi, "[redacted]").slice(0, 500).trim() || "provider command failed";
}

function providerFailure(code: ReleaseFailureCode, summary = "GitHub provider request failed", retryAt: string | null = null): GithubReleaseFailure {
  return new GithubReleaseFailure(code, safeSummary(summary), retryAt);
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
  const headRepository = row.head.repo.full_name;
  const baseRepository = row.base.repo.full_name;
  if (headRepository !== baseRepository) throw providerFailure("invalid-provider-response", "GitHub pull request repositories conflict");
  const state = row.state === "closed" && row.merged_at !== null ? "merged" : row.state;
  const url = new URL(row.html_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== `/${headRepository}/pull/${row.number}`) throw providerFailure("invalid-provider-response", "GitHub pull request URL is unsafe");
  if ((state === "open" && row.merged_at !== null) || (state === "merged" && row.merged_at === null)) throw providerFailure("invalid-provider-response", "GitHub pull request state is inconsistent");
  return { number: row.number, url: row.html_url, repository: headRepository, headBranch: row.head.ref, baseBranch: row.base.ref, headSha: row.head.sha, baseSha: row.base.sha, isDraft: row.draft, state, mergedAt: row.merged_at };
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
  const output = `${bounded(error.result.stdout)}\n${bounded(error.result.stderr)}`;
  const parsed = restError(error.result.stdout);
  if (parsed?.status === 403 || parsed?.status === 429) return providerFailure("provider-rate-limited", parsed.message);
  if (operation === "authentication") return providerFailure("authentication-required", "GitHub CLI authentication is unavailable");
  if (error.timedOut) return providerFailure("provider-unavailable", `${operation} timed out`);
  return providerFailure("provider-unavailable", safeSummary(output));
}

const defaultRunner: GithubCommandRunner = async ({ command, args, cwd, timeout, maxBuffer }) => {
  try {
    const result = await execFileAsync(command, args, { ...(cwd ? { cwd } : {}), timeout, maxBuffer });
    return { stdout: bounded(result.stdout), stderr: bounded(result.stderr) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    throw new GithubCommandFailure({ stdout: bounded(failure.stdout ?? ""), stderr: bounded(failure.stderr ?? "") }, Boolean(failure.killed || failure.signal === "SIGTERM"));
  }
};

export function createGithubReleasePort(options: GithubReleasePortOptions = {}): GithubReleaseAdapter {
  const ghCommand = options.ghCommand ?? process.env.FORGE_GH_COMMAND ?? "gh";
  const gitCommand = options.gitCommand ?? "git";
  const runner = options.runner ?? defaultRunner;
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
  const api = async (args: string[], operation: string, allowNotFound = false): Promise<unknown> => {
    try { return parseJson((await runGh(args)).stdout); } catch (error) {
      if (error instanceof GithubReleaseFailure) throw error;
      if (error instanceof GithubCommandFailure) {
        const parsed = restError(error.result.stdout);
        if (allowNotFound && parsed?.status === 404) return null;
        if (allowNotFound && !parsed) throw providerFailure("invalid-provider-response", "GitHub returned an unvalidated branch error");
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
      try { await runGit(["push", "origin", `HEAD:refs/heads/${input.branch}`], { cwd: input.cwd, timeout: 60_000, maxBuffer: 64 * 1024 }); } catch (error) { throw classifyCommandFailure(error, "normal push"); }
    },
    async listPullRequests(input) {
      const endpoint = `repos/${input.repository}/pulls`;
      let value: unknown;
      try { value = await api(["api", "--method", "GET", "--paginate", "--slurp", endpoint, "-f", "state=all", "-f", `head=${input.owner}:${input.headBranch}`, "-f", `base=${input.baseBranch}`], "pull request list"); } catch (error) { throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "pull request list"); }
      if (!Array.isArray(value)) throw providerFailure("invalid-provider-response", "GitHub pagination response is not an array");
      const rows: unknown[] = [];
      for (const page of value) {
        if (!Array.isArray(page)) throw providerFailure("invalid-provider-response", "GitHub pagination page is not an array");
        rows.push(...page);
      }
      return rows.map(pull);
    },
    async createDraftPullRequest(input) {
      const value = await api(["api", "--method", "POST", `repos/${input.repository}/pulls`, "-f", `title=${input.title}`, "-f", `head=${input.headBranch}`, "-f", `base=${input.baseBranch}`, "-f", `body=${input.body}`, "-F", "draft=true"], "draft pull request creation");
      return pull(value);
    },
    async getPullRequest(input) {
      const value = await api(["api", `repos/${input.repository}/pulls/${input.number}`], "pull request observation");
      return pull(value);
    },
    async markReadyForReview(input) {
      await api(["api", "--method", "POST", `repos/${input.repository}/pulls/${input.number}/ready_for_review`], "mark ready for review");
    },
  } as GithubReleasePort & GithubAcceptancePort;
}

function normalizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function unsafePublicValue(value: string): boolean {
  return /Forge|task_|workflow-|session_|artifact[_-]|(?:^|\s)(?:prompt|reasoning)(?:\s|:)/i.test(value)
    || /(?:^|\s)(?:https?:\/\/|ssh:\/\/|git@)/i.test(value)
    || /(?:Bearer\s+|(?:gho_|github_pat_|sk-)[A-Za-z0-9_-]+|(?:token|password|secret|api[_-]?key)\s*[:=])/i.test(value)
    || /\b[a-f0-9]{40,64}\b/i.test(value)
    || /(?:^|\s)[A-Za-z]:[\\/]|(?:^|\s)\/(?:Users|home|private|tmp|var)\//i.test(value);
}

function safePath(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.includes("\\") || normalized.split("/").some((part) => part === ".." || part === "." || part === "") || unsafePublicValue(normalized)) throw providerFailure("public-projection-unsafe", "Public changed-file projection is unsafe");
  return normalized;
}

function safeRow(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw providerFailure("public-projection-unsafe", "Public verification projection is unsafe");
  if (unsafePublicValue(value)) throw providerFailure("public-projection-unsafe", "Public verification projection is unsafe");
  const normalized = normalizeText(String(redact(value)));
  if (!normalized || unsafePublicValue(normalized)) throw providerFailure("public-projection-unsafe", "Public verification projection is unsafe");
  return normalized.slice(0, 300);
}

export function buildDraftPullRequestProjection(input: {
  taskTitle: string;
  filesChanged?: string[];
  commandsRun?: string[];
  testResults?: string[];
}): DraftPullRequestProjection {
  if (/[\u0000-\u001f\u007f]/.test(input.taskTitle)) throw providerFailure("public-projection-unsafe", "Public title is unsafe");
  const title = normalizeText(input.taskTitle);
  if (!title || title.length > 160 || unsafePublicValue(title)) throw providerFailure("public-projection-unsafe", "Public title is unsafe");
  const paths = [...new Set((input.filesChanged ?? []).map(safePath))].slice(0, 50);
  const checks = [...new Set([...(input.commandsRun ?? []), ...(input.testResults ?? [])].map(safeRow))].slice(0, 100);
  const body = [`Title: ${title}`, ``, `Body:`, `## Summary`, ``, title, ``, `## Changes`, ``, ...(paths.length ? paths.map((path) => `- \`${path}\``) : ["- No changed files recorded"]), ``, `## Verification`, ``, ...(checks.length ? checks.map((check) => `- ${check}`) : ["- No verification rows recorded"])].join("\n");
  const projection = { title, body, bodySha256: createHash("sha256").update(body, "utf8").digest("hex") };
  assertSafePublicProjection(projection);
  return projection;
}

export function assertSafePublicProjection(input: Pick<DraftPullRequestProjection, "title" | "body">): void {
  if (!input.title || input.title.length > 160 || Buffer.byteLength(input.body, "utf8") > 20_000 || unsafePublicValue(input.title) || unsafePublicValue(input.body)) throw providerFailure("public-projection-unsafe", "Public pull request projection is unsafe");
}

export interface PublishReleaseInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  coordinates: PinnedRepositoryCoordinates;
  reviewedRevision: ReviewedRevision;
  taskTitle: string;
  delivery: { filesChanged?: string[]; commandsRun?: string[]; testResults?: string[] };
}

export interface PublishReleaseResult {
  releaseId: string;
  repository: string;
  branchName: string;
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
      db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, workflow_id, project_revision_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, kind, status, attempt, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'push', 'intent-recorded', 1, ?, ?, ?) ON CONFLICT(operation_key) DO UPDATE SET status = CASE WHEN forge_provider_operations.status = 'completed' THEN 'completed' ELSE 'intent-recorded' END, attempt = CASE WHEN forge_provider_operations.status = 'completed' THEN forge_provider_operations.attempt ELSE forge_provider_operations.attempt + 1 END, updated_at = excluded.updated_at").run(operationId(), `${releaseKey}:push`, input.taskId, input.companyId, input.workflowId, coordinates.projectRevisionId, releaseKey, coordinates.repository, coordinates.headBranch, coordinates.baseBranch, coordinates.expectedBaseSha, reviewed.commitSha, reviewed.treeSha, now, now, now);
      db.prepare("UPDATE forge_releases SET superseded_by_release_id = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND id <> ? AND superseded_at IS NOT NULL AND superseded_by_release_id IS NULL").run(existing.id, input.taskId, input.companyId, input.workflowId, existing.id);
    });
    const release = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_releases WHERE release_key = ?").get(releaseKey) as { id: string });
    return { releaseId: release.id, releaseKey };
  }

  private existingBodyArtifact(companyId: string, releaseKey: string, expectedSha: string): StoredArtifact | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.company_id AS companyId, a.kind, a.filename, a.mime_type AS mimeType, a.byte_size AS byteSize, a.sha256, a.storage_path AS storagePath, a.created_at AS createdAt
      FROM forge_releases r JOIN forge_artifacts a ON a.id = r.body_artifact_id AND a.company_id = r.company_id AND a.kind = 'release-public-body'
      WHERE r.release_key = ? AND r.company_id = ? LIMIT 1`).get(releaseKey, companyId) as StoredArtifact | undefined);
    if (!row) return undefined;
    if (row.sha256 !== expectedSha) throw providerFailure("public-projection-unsafe", "The immutable release body does not match the reviewed release");
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
    const row = this.database.authQuery((db) => db.prepare("SELECT MAX(COALESCE(attempt, 0)) AS attempt FROM forge_provider_operations WHERE release_key = ? AND kind IN ('push', 'create-draft-pr')").get(releaseKey) as { attempt: number | null });
    return row.attempt ?? 0;
  }

  async publish(input: PublishReleaseInput): Promise<PublishReleaseResult> {
    let context: ReturnType<ReleaseService["context"]>;
    try { context = this.context(input); } catch (error) { return this.fail(input, error); }
    const { coordinates, reviewed, title, bodyInput } = context;
    try {
      const review = this.database.authQuery((db) => db.prepare("SELECT outcome, base_sha, subject_commit, subject_tree FROM forge_delivery_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(reviewed.reviewId, input.taskId, input.companyId, input.workflowId) as { outcome: string; base_sha: string; subject_commit: string; subject_tree: string } | undefined);
      if (!review || review.outcome !== "approved" || review.base_sha.toLowerCase() !== coordinates.expectedBaseSha.toLowerCase() || review.subject_commit.toLowerCase() !== reviewed.commitSha.toLowerCase() || review.subject_tree.toLowerCase() !== reviewed.treeSha.toLowerCase()) throw providerFailure("stale-reviewed-revision", "Approved review does not match the reviewed revision");
      await this.github.checkAuthentication();
      if ((await this.github.getRemoteRepository({ cwd: coordinates.worktreePath })) !== coordinates.repository.toLowerCase()) throw providerFailure("wrong-remote", "Local origin does not match the pinned repository");
      const local = await this.github.inspectLocalRevision({ cwd: coordinates.worktreePath });
      if (!local.clean || local.branch !== coordinates.headBranch || local.headSha.toLowerCase() !== reviewed.commitSha.toLowerCase() || local.treeSha.toLowerCase() !== reviewed.treeSha.toLowerCase()) throw providerFailure("stale-reviewed-revision", "Local worktree is not the reviewed clean revision");
      const base = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.baseBranch });
      if (base === null || base.toLowerCase() !== coordinates.expectedBaseSha.toLowerCase()) throw providerFailure("target-base-drift", "Pinned target base has moved");
      const projection = buildDraftPullRequestProjection({ taskTitle: title, ...bodyInput });
      const releaseKey = releaseKeyFor(input, coordinates, reviewed);
      const bodyArtifact = this.existingBodyArtifact(input.companyId, releaseKey, projection.bodySha256) ?? await this.artifacts.put(input.companyId, "release-public-body", { filename: `${input.taskId}-release.md`, mimeType: "text/markdown", bytes: Buffer.from(projection.body, "utf8") });
      const { releaseId } = this.persistIntent(input, coordinates, reviewed, projection, bodyArtifact);
      const pushKey = `${releaseKey}:push`;
      const remoteHead = await this.observeHead(coordinates, pushKey);
      if (remoteHead === null) {
        try {
          await this.github.pushNormal({ cwd: coordinates.worktreePath, branch: coordinates.headBranch });
        } catch (error) {
          try {
            const observed = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch });
            if (observed?.toLowerCase() === reviewed.commitSha.toLowerCase()) this.updateOperation(pushKey, "completed");
            else if (observed === null) { const failure = providerFailure("provider-unavailable", "Normal push outcome is unconfirmed"); this.updateOperation(pushKey, "observed-absent", failure); throw failure; }
            else { const failure = providerFailure("remote-head-conflict", "Remote branch points to another commit"); this.updateOperation(pushKey, "failed", failure); throw failure; }
          } catch (observationError) {
            if (observationError instanceof GithubReleaseFailure) throw observationError;
            throw providerFailure("provider-unavailable", "Remote push outcome could not be observed");
          }
        }
        const confirmed = await this.github.getBranchHead({ repository: coordinates.repository, branch: coordinates.headBranch });
        if (confirmed?.toLowerCase() !== reviewed.commitSha.toLowerCase()) throw providerFailure("provider-unavailable", "Normal push did not produce the reviewed remote head");
        this.updateOperation(pushKey, "completed");
      } else if (remoteHead.toLowerCase() === reviewed.commitSha.toLowerCase()) this.updateOperation(pushKey, "completed");
      else throw providerFailure("remote-head-conflict", "Remote branch points to another commit");

      const identity = { repository: coordinates.repository, owner: coordinates.owner, headBranch: coordinates.headBranch, baseBranch: coordinates.baseBranch };
      const exactCandidate = (candidate: GithubPullRequest) => candidate.repository.toLowerCase() === coordinates.repository.toLowerCase() && candidate.headBranch === coordinates.headBranch && candidate.baseBranch === coordinates.baseBranch && candidate.headSha.toLowerCase() === reviewed.commitSha.toLowerCase() && candidate.baseSha.toLowerCase() === coordinates.expectedBaseSha.toLowerCase() && candidate.isDraft && candidate.state === "open";
      const candidates = await this.github.listPullRequests(identity);
      const exact = candidates.filter(exactCandidate);
      if (candidates.length > 1 || (candidates.length === 1 && exact.length !== 1)) throw providerFailure("ambiguous-provider-state", "GitHub pull request state is contradictory");
      let pullRequest = exact[0];
      let reused = true;
      if (!pullRequest) {
        const createKey = `${releaseKey}:create-draft-pr`;
        this.database.authTransaction((db) => {
          const now = new Date().toISOString();
          db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, workflow_id, project_revision_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, kind, status, attempt, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create-draft-pr', 'intent-recorded', 1, ?, ?, ?) ON CONFLICT(operation_key) DO UPDATE SET status = CASE WHEN forge_provider_operations.status = 'completed' THEN 'completed' ELSE 'intent-recorded' END, attempt = CASE WHEN forge_provider_operations.status = 'completed' THEN forge_provider_operations.attempt ELSE forge_provider_operations.attempt + 1 END, updated_at = excluded.updated_at").run(operationId(), createKey, input.taskId, input.companyId, input.workflowId, coordinates.projectRevisionId, releaseKey, coordinates.repository, coordinates.headBranch, coordinates.baseBranch, coordinates.expectedBaseSha, reviewed.commitSha, reviewed.treeSha, now, now, now);
        });
        const beforeCreate = await this.github.listPullRequests(identity);
        const validBeforeCreate = beforeCreate.filter(exactCandidate);
        if (beforeCreate.length > 1 || (beforeCreate.length === 1 && validBeforeCreate.length !== 1)) throw providerFailure("ambiguous-provider-state", "GitHub pull request state changed before creation");
        if (validBeforeCreate[0]) pullRequest = validBeforeCreate[0];
        else {
          try { pullRequest = await this.github.createDraftPullRequest({ ...identity, title: projection.title, body: projection.body }); } catch (error) {
            const afterCreate = await this.github.listPullRequests(identity);
            const recovered = afterCreate.filter(exactCandidate);
            if (recovered.length === 1) pullRequest = recovered[0];
            else if (recovered.length > 1 || afterCreate.length > 0) throw providerFailure("ambiguous-provider-state", "Draft pull request creation outcome is ambiguous");
            else throw error instanceof GithubReleaseFailure ? error : classifyCommandFailure(error, "draft pull request creation");
          }
          reused = false;
        }
        const createdPullRequest = pullRequest;
        if (!createdPullRequest) throw providerFailure("invalid-provider-response", "GitHub did not return a pull request");
        const authoritative = await this.github.getPullRequest({ repository: coordinates.repository, number: createdPullRequest.number });
        if (authoritative.repository.toLowerCase() !== coordinates.repository || authoritative.headBranch !== coordinates.headBranch || authoritative.baseBranch !== coordinates.baseBranch || authoritative.headSha.toLowerCase() !== reviewed.commitSha.toLowerCase() || authoritative.baseSha.toLowerCase() !== coordinates.expectedBaseSha.toLowerCase() || !authoritative.isDraft || authoritative.state !== "open") throw providerFailure("ambiguous-provider-state", "Created pull request is not the exact reviewed draft");
        pullRequest = authoritative;
        this.updateOperation(createKey, "completed");
      }
      if (!pullRequest) throw providerFailure("invalid-provider-response", "GitHub did not return a pull request");
      const now = new Date().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_releases SET status = 'draft', pr_number = ?, pr_url = ?, reused = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").run(pullRequest.number, pullRequest.url, reused ? 1 : 0, now, releaseId, input.taskId, input.companyId, input.workflowId);
      });
      return { releaseId, repository: coordinates.repository, branchName: coordinates.headBranch, headSha: reviewed.commitSha, headTree: reviewed.treeSha, pullRequest, reused, attempt: this.operationAttempt(releaseKey) };
    } catch (error) {
      return this.fail(input, error);
    }
  }
}
