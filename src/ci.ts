import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type { ForgeDatabase } from "./database.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { redact } from "./logging.js";

const execFileAsync = promisify(execFile);

export const CI_POLL_INTERVAL_MS = 15_000;
export const CI_PROPAGATION_WINDOW_MS = 5 * 60_000;
export const CI_OVERALL_WINDOW_MS = 60 * 60_000;
export const CI_MERGE_OBSERVATION_INTERVAL_MS = 5 * 60_000;
export const CI_TRANSIENT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000] as const;
export const CI_MAX_CONSECUTIVE_PROVIDER_FAILURES = CI_TRANSIENT_BACKOFF_MS.length;
export const CI_ACCEPTED_CONCLUSIONS = ["success"] as const;
const CI_SUMMARY_MAX_LENGTH = 500;

export const CommitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/i);
const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export type CiOutcome =
  | "waiting"
  | "passed"
  | "failed"
  | "missing_required"
  | "cancelled"
  | "timed_out"
  | "non_success"
  | "stale_head"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_provider_response";

export type CiOwner = "system" | "lead" | "human" | null;
export type CheckStatus = "queued" | "in_progress" | "completed";
export type CheckConclusion = "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "neutral" | "skipped" | "stale" | null;

export const PullRequestObservationSchema = z.object({
  repository: RepositorySchema,
  number: z.number().int().positive(),
  url: z.string().url().max(2_000),
  state: z.enum(["open", "closed"]),
  mergedAt: z.string().datetime().nullable().optional(),
  draft: z.boolean(),
  baseBranch: z.string().min(1).max(256),
  baseSha: CommitShaSchema,
  headBranch: z.string().min(1).max(256),
  headSha: CommitShaSchema,
}).strict();
export type PullRequestObservation = z.infer<typeof PullRequestObservationSchema>;

export const CheckObservationSchema = z.object({
  providerCheckId: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  headSha: CommitShaSchema,
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale"]).nullable(),
  detailsUrl: z.string().url().max(2_000).nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  summary: z.string().max(CI_SUMMARY_MAX_LENGTH).nullable(),
}).strict();
export type CheckObservation = z.infer<typeof CheckObservationSchema>;

export interface CiProvider {
  getPullRequest(input: { repository: string; pullRequestNumber: number }): Promise<PullRequestObservation>;
  listChecks(input: { repository: string; headSha: string }): Promise<readonly CheckObservation[]>;
}

export type GithubCommandRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class CiFailure extends Error {
  constructor(readonly code: "invalid-policy" | "scope" | "stale-input" | "provider" | "rate-limit") {
    super(`CI ${code}`);
    this.name = "CiFailure";
  }
}

export class CiProviderFailure extends Error {
  constructor(readonly code: "rate_limited" | "rate_limit_unbounded" | "transient" | "invalid_response" | "authentication", readonly retryAt: string | null = null, readonly safeSummary = "CI provider observation failed") {
    super(safeSummary);
    this.name = "CiProviderFailure";
  }
}

function boundedSummary(value: string | null | undefined): string {
  return String(redact(value ?? "")).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, CI_SUMMARY_MAX_LENGTH);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function id(): string { return `ci_${randomBytes(12).toString("hex")}`; }
function attemptId(): string { return `ci_attempt_${randomBytes(12).toString("hex")}`; }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export interface CiPolicy {
  projectRevisionId: string;
  requiredChecks: string[];
  acceptedConclusions: ["success", "skipped"];
}

export function buildCiPolicy(projectRevisionId: string, requiredChecks: readonly string[]): { policy: CiPolicy; policyJson: string; policyHash: string } {
  const normalized = [...new Set(requiredChecks.map((check) => check.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (!normalized.length) throw new CiFailure("invalid-policy");
  const policy: CiPolicy = { projectRevisionId, requiredChecks: normalized, acceptedConclusions: ["success", "skipped"] };
  const policyJson = canonicalJson(policy);
  return { policy, policyJson, policyHash: createHash("sha256").update(Buffer.from(policyJson, "utf8")).digest("hex") };
}

export interface CiEvaluationInput {
  repository: string;
  pullRequestNumber: number;
  expectedRepository: string;
  expectedPullRequestNumber: number;
  expectedHeadSha: string;
  expectedBaseBranch: string;
  expectedHeadBranch: string;
  requiredChecks: readonly string[];
  observedPullRequest: PullRequestObservation;
  checks: readonly CheckObservation[];
  now: string;
  propagationDeadline: string;
  overallDeadline: string;
}

export interface SelectedCheck extends CheckObservation { selectedForEvaluation: boolean }
export interface CiEvaluationResult {
  outcome: CiOutcome;
  reason: string;
  owner: CiOwner;
  repairable: boolean;
  retryAt: string | null;
  selectedChecks: SelectedCheck[];
  summary: string;
}

export function selectLatestCheckRuns(checks: readonly CheckObservation[], requiredChecks: readonly string[], expectedHeadSha: string): SelectedCheck[] {
  const required = new Set(requiredChecks);
  const selected = new Map<string, CheckObservation>();
  for (const check of checks) {
    if (!required.has(check.name)) continue;
    const current = selected.get(check.name);
    if (!current || compareChecks(check, current, expectedHeadSha) > 0) selected.set(check.name, check);
  }
  return checks.map((check) => ({ ...check, selectedForEvaluation: selected.get(check.name)?.providerCheckId === check.providerCheckId && selected.get(check.name)?.headSha === check.headSha }));
}

function compareChecks(left: CheckObservation, right: CheckObservation, expectedHeadSha: string): number {
  const leftExact = left.headSha.toLowerCase() === expectedHeadSha.toLowerCase();
  const rightExact = right.headSha.toLowerCase() === expectedHeadSha.toLowerCase();
  if (leftExact !== rightExact) return leftExact ? 1 : -1;
  if (/^\d+$/.test(left.providerCheckId) && /^\d+$/.test(right.providerCheckId)) {
    const leftId = BigInt(left.providerCheckId);
    const rightId = BigInt(right.providerCheckId);
    if (leftId !== rightId) return leftId > rightId ? 1 : -1;
  }
  const leftCompleted = left.completedAt ? Date.parse(left.completedAt) : -1;
  const rightCompleted = right.completedAt ? Date.parse(right.completedAt) : -1;
  if (leftCompleted !== rightCompleted) return leftCompleted > rightCompleted ? 1 : -1;
  const leftStarted = left.startedAt ? Date.parse(left.startedAt) : -1;
  const rightStarted = right.startedAt ? Date.parse(right.startedAt) : -1;
  if (leftStarted !== rightStarted) return leftStarted > rightStarted ? 1 : -1;
  return left.providerCheckId.localeCompare(right.providerCheckId);
}

function evaluation(reason: string, outcome: CiOutcome, owner: CiOwner, repairable: boolean, selectedChecks: SelectedCheck[], summary: string, retryAt: string | null = null): CiEvaluationResult {
  return { outcome, reason, owner, repairable, retryAt, selectedChecks, summary: boundedSummary(summary) };
}

export function evaluateExactHead(input: CiEvaluationInput): CiEvaluationResult {
  const selectedChecks = selectLatestCheckRuns(input.checks, input.requiredChecks, input.expectedHeadSha);
  const pr = input.observedPullRequest;
  if (pr.repository.toLowerCase() !== input.expectedRepository.toLowerCase() || pr.number !== input.expectedPullRequestNumber) return evaluation("pull_request_identity_changed", "stale_head", "human", false, selectedChecks, "Pull request identity changed");
  if (pr.state !== "open" && !pr.mergedAt) return evaluation("pull_request_not_open", "stale_head", "human", false, selectedChecks, "Pull request closed without merge");
  if (pr.baseBranch !== input.expectedBaseBranch) return evaluation("pull_request_base_branch_changed", "stale_head", "human", false, selectedChecks, "Pull request base branch changed");
  if (pr.headBranch !== input.expectedHeadBranch) return evaluation("pull_request_head_branch_changed", "stale_head", "human", false, selectedChecks, "Pull request head branch changed");
  if (pr.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) return evaluation("pull_request_head_changed", "stale_head", "human", false, selectedChecks, "Pull request head changed");
  if (pr.mergedAt) return evaluation("checks_passed_merged", "passed", null, false, selectedChecks, "The exact pull request was merged");
  const exactSelected = selectedChecks.filter((check) => check.selectedForEvaluation && check.headSha.toLowerCase() === input.expectedHeadSha.toLowerCase());
  const missing = input.requiredChecks.filter((name) => !exactSelected.some((check) => check.name === name));
  if (missing.length && Date.parse(input.now) < Date.parse(input.propagationDeadline)) return evaluation("checks_propagating", "waiting", "system", false, selectedChecks, "Required checks are still propagating", new Date(Date.parse(input.now) + CI_POLL_INTERVAL_MS).toISOString());
  if (missing.length && Date.parse(input.now) >= Date.parse(input.overallDeadline)) return evaluation("poll_window_exhausted", "waiting", "system", false, selectedChecks, `Waiting for required checks after the initial CI window: ${missing.join(", ")}`, new Date(Date.parse(input.now) + CI_MERGE_OBSERVATION_INTERVAL_MS).toISOString());
  if (missing.length) return evaluation("required_check_missing", "waiting", "system", false, selectedChecks, `Required checks are still missing: ${missing.join(", ")}`, new Date(Date.parse(input.now) + CI_POLL_INTERVAL_MS).toISOString());
  const active = exactSelected.filter((check) => check.status !== "completed");
  if (active.length) return evaluation("checks_queued", "waiting", "system", false, selectedChecks, "Required checks are queued or running", new Date(Date.parse(input.now) + (Date.parse(input.now) >= Date.parse(input.overallDeadline) ? CI_MERGE_OBSERVATION_INTERVAL_MS : CI_POLL_INTERVAL_MS)).toISOString());
  const failed = exactSelected.filter((check) => check.conclusion === "failure");
  if (failed.length) return evaluation("required_check_failed", "failed", "lead", true, selectedChecks, `Required checks failed: ${failed.map((check) => check.name).join(", ")}`);
  const cancelled = exactSelected.find((check) => check.conclusion === "cancelled");
  if (cancelled) return evaluation("required_check_cancelled", "cancelled", "human", false, selectedChecks, `Required check cancelled: ${cancelled.name}`);
  const timedOut = exactSelected.find((check) => check.conclusion === "timed_out");
  if (timedOut) return evaluation("required_check_timed_out", "timed_out", "human", false, selectedChecks, `Required check timed out: ${timedOut.name}`);
  const nonSuccess = exactSelected.find((check) => check.conclusion !== "success" && check.conclusion !== "skipped");
  if (nonSuccess) return evaluation(`required_check_${nonSuccess.conclusion ?? "incomplete"}`, "non_success", "human", false, selectedChecks, `Required check did not succeed: ${nonSuccess.name}`);
  return evaluation("checks_passed", "passed", null, false, selectedChecks, "All required checks passed on the exact pull-request head");
}

function parseJsonDocuments(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new CiProviderFailure("invalid_response", null, "Provider returned an empty response");
  try { return [JSON.parse(trimmed) as unknown]; } catch { /* headers may precede JSON */ }
  const documents: unknown[] = [];
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "{" && trimmed[start] !== "[") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < trimmed.length; end += 1) {
      const character = trimmed[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          try { documents.push(JSON.parse(trimmed.slice(start, end + 1)) as unknown); start = end; } catch { /* keep looking after provider headers */ }
          break;
        }
      }
    }
  }
  if (!documents.length) throw new CiProviderFailure("invalid_response", null, "Provider returned malformed JSON");
  return documents;
}

function headerValue(text: string, name: string): string | null {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(text);
  return match?.[1]?.trim() ?? null;
}

function retryAtFromHeaders(text: string, now: Date): string | null {
  const retryAfter = headerValue(text, "Retry-After");
  if (retryAfter && /^\d+$/.test(retryAfter)) return new Date(now.getTime() + Number(retryAfter) * 1_000).toISOString();
  const reset = headerValue(text, "X-RateLimit-Reset");
  if (reset && /^\d+$/.test(reset)) return new Date(Number(reset) * 1_000).toISOString();
  return null;
}

function providerError(error: unknown, now: Date): CiProviderFailure {
  const record = error as { stdout?: unknown; stderr?: unknown; code?: unknown; status?: unknown };
  const text = `${typeof record.stdout === "string" ? record.stdout : ""}\n${typeof record.stderr === "string" ? record.stderr : ""}\n${error instanceof Error ? error.message : ""}`;
  if (/rate.?limit|secondary limit|api rate/i.test(text) || record.status === 429) {
    const retryAt = retryAtFromHeaders(text, now);
    return retryAt ? new CiProviderFailure("rate_limited", retryAt, "GitHub rate limit is active") : new CiProviderFailure("rate_limit_unbounded", null, "GitHub rate limit has no authoritative reset");
  }
  if (/401|403|auth|permission|forbidden|denied/i.test(text)) return new CiProviderFailure("authentication", null, "GitHub authentication or permission failed");
  if (/invalid json|unexpected token|malformed/i.test(text)) return new CiProviderFailure("invalid_response", null, "GitHub returned malformed data");
  return new CiProviderFailure("transient", null, "GitHub is temporarily unavailable");
}

function githubPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CiProviderFailure("invalid_response", null, "GitHub returned an invalid object");
  return value as Record<string, unknown>;
}

function parsePullRequest(value: unknown): PullRequestObservation {
  const row = githubPayload(value);
  const head = githubPayload(row.head);
  const base = githubPayload(row.base);
  const repository = githubPayload(head.repo).full_name;
  const parsed = PullRequestObservationSchema.safeParse({ repository, number: row.number, url: row.html_url, state: row.state, mergedAt: row.merged_at ?? null, draft: row.draft, baseBranch: base.ref, baseSha: base.sha, headBranch: head.ref, headSha: head.sha });
  if (!parsed.success) throw new CiProviderFailure("invalid_response", null, "GitHub pull request identity is invalid");
  return parsed.data;
}

function parseChecks(value: unknown, expectedRepository: string): CheckObservation[] {
  const payloads = Array.isArray(value) ? value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]) : [value];
  return payloads.flatMap((entry) => {
    const rows = githubPayload(entry).check_runs;
    if (!Array.isArray(rows)) throw new CiProviderFailure("invalid_response", null, "GitHub check-run response is invalid");
    return rows.map((raw) => {
      const row = githubPayload(raw);
      const output = row.output && typeof row.output === "object" && !Array.isArray(row.output) ? row.output as Record<string, unknown> : {};
      const providerStatus = z.enum(["queued", "in_progress", "completed", "waiting", "pending", "requested"]).safeParse(row.status);
      if (!providerStatus.success) throw new CiProviderFailure("invalid_response", null, `GitHub check-run ${expectedRepository} has an unknown status`);
      const parsed = CheckObservationSchema.safeParse({
        providerCheckId: String(row.id ?? ""), name: row.name, headSha: row.head_sha, status: providerStatus.data === "completed" ? "completed" : providerStatus.data === "in_progress" ? "in_progress" : "queued", conclusion: row.conclusion, detailsUrl: row.html_url ?? null, startedAt: isoOrNull(row.started_at), completedAt: isoOrNull(row.completed_at), summary: boundedSummary(typeof output.summary === "string" ? output.summary : null),
      });
      if (!parsed.success) throw new CiProviderFailure("invalid_response", null, `GitHub check-run ${expectedRepository} is invalid`);
      return parsed.data;
    });
  });
}

export function createGithubCiProvider(commandOrOptions: string | { command?: string; runner?: GithubCommandRunner; now?: () => Date } = process.env.FORGE_GH_COMMAND ?? "gh"): CiProvider {
  const options = typeof commandOrOptions === "string" ? { command: commandOrOptions } : commandOrOptions;
  const command = options.command ?? process.env.FORGE_GH_COMMAND ?? "gh";
  const now = options.now ?? (() => new Date());
  const run: GithubCommandRunner = options.runner ?? (async (args) => execFileAsync(command, args, { timeout: 30_000, maxBuffer: 512 * 1024 }));
  const observe = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    try { return await run(args); } catch (error) {
      const failure = providerError(error, now());
      throw failure;
    }
  };
  return {
    async getPullRequest(input) {
      const response = await observe(["api", `repos/${input.repository}/pulls/${input.pullRequestNumber}`, "--include"]);
      try { return parsePullRequest(parseJsonDocuments(response.stdout)[0]); } catch (error) { if (error instanceof CiProviderFailure) throw error; throw providerError(error, now()); }
    },
    async listChecks(input) {
      const response = await observe(["api", `repos/${input.repository}/commits/${input.headSha}/check-runs?per_page=100`, "--include", "--paginate", "--slurp"]);
      try { return parseChecks(parseJsonDocuments(response.stdout), input.repository); } catch (error) { if (error instanceof CiProviderFailure) throw error; throw providerError(error, now()); }
    },
  };
}

export interface CiReconcileInput {
  taskId: string;
  companyId: string;
  releaseId: string;
  expectedHeadSha: string;
  attemptNumber: number;
}

export interface CiReconcileResult extends CiEvaluationResult {
  runId: string;
  attemptId: string;
  attemptNumber: number;
  expectedHeadSha: string;
  observedHeadSha: string | null;
  evidenceArtifactId: string | null;
  evidenceArtifactSha256?: string;
  policyHash: string;
  policy: CiPolicy;
  propagationDeadline: string;
  overallDeadline: string;
  nextPollAt: string | null;
}

type RevisionConfig = { repository: string; baseBranch: string; targetBranch: string; baseSha: string; requiredChecks: string[] };

function revisionConfig(raw: string): RevisionConfig {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return { repository: RepositorySchema.parse(value.repository), baseBranch: z.string().min(1).parse(value.baseBranch), targetBranch: z.string().min(1).parse(value.targetBranch), baseSha: CommitShaSchema.parse(value.baseSha), requiredChecks: z.array(z.string()).parse(value.requiredChecks) };
  } catch { throw new CiFailure("invalid-policy"); }
}

export class CiService {
  constructor(private readonly database: ForgeDatabase, private readonly provider: CiProvider, private readonly artifacts?: ArtifactStore, private readonly now: () => Date = () => new Date()) {}

  async reconcile(input: CiReconcileInput): Promise<CiReconcileResult> {
    const now = this.now().toISOString();
    const requestedAttempt = input.attemptNumber;
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.project_id AS projectId, t.project_revision_id AS projectRevisionId, r.repository, r.head_sha AS expectedHeadSha, r.head_tree AS expectedHeadTree, r.base_branch AS baseBranch, r.head_branch AS headBranch, r.pr_number AS pullRequestNumber, r.status AS releaseStatus, r.superseded_at AS releaseSupersededAt, pr.normalized_json AS normalizedJson, pr.state AS revisionState
      FROM forge_tasks t JOIN forge_releases r ON r.id = ? AND r.task_id = t.id AND r.company_id = ? JOIN forge_project_revisions pr ON pr.id = t.project_revision_id
      WHERE t.id = ? AND t.company_id = ?`).get(input.releaseId, input.companyId, input.taskId, input.companyId) as { projectId: string; projectRevisionId: string; repository: string; expectedHeadSha: string; expectedHeadTree: string; baseBranch: string; headBranch: string; pullRequestNumber: number | null; releaseStatus: string; releaseSupersededAt: string | null; normalizedJson: string; revisionState: string } | undefined);
    if (!context || context.releaseSupersededAt || !["draft", "ready", "releasing", "ci_waiting"].includes(context.releaseStatus) || context.pullRequestNumber === null || context.revisionState !== "accepted" || context.expectedHeadSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) throw new CiFailure("stale-input");
    const revision = revisionConfig(context.normalizedJson);
    if (context.repository.toLowerCase() !== revision.repository.toLowerCase()) throw new CiFailure("stale-input");
    const { policy, policyJson, policyHash } = buildCiPolicy(context.projectRevisionId, revision.requiredChecks);
    let run = this.database.authQuery((db) => db.prepare("SELECT id, attempt, first_observed_at AS firstObservedAt, propagation_deadline AS propagationDeadline, overall_deadline AS overallDeadline, consecutive_provider_failures AS consecutiveProviderFailures FROM forge_ci_runs WHERE release_id = ? AND expected_head_sha = ? AND policy_hash = ? LIMIT 1").get(input.releaseId, input.expectedHeadSha, policyHash) as { id: string; attempt: number; firstObservedAt: string | null; propagationDeadline: string | null; overallDeadline: string | null; consecutiveProviderFailures: number } | undefined);
    const runId = run?.id ?? id();
    const firstObservedAt = run?.firstObservedAt ?? now;
    const propagationDeadline = run?.propagationDeadline ?? new Date(Date.parse(firstObservedAt) + CI_PROPAGATION_WINDOW_MS).toISOString();
    const overallDeadline = run?.overallDeadline ?? new Date(Date.parse(firstObservedAt) + CI_OVERALL_WINDOW_MS).toISOString();
    this.database.authTransaction((db) => db.prepare(`INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, status, next_poll_at, attempt, summary, evidence_artifact_id, created_at, updated_at, pull_request_number, expected_base_branch, expected_head_branch, expected_head_tree, project_revision_id, policy_hash, policy_json, first_observed_at, propagation_deadline, overall_deadline, consecutive_provider_failures)
      VALUES (?, ?, ?, ?, ?, 'waiting', NULL, 0, '', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT DO NOTHING`).run(runId, input.taskId, input.companyId, input.releaseId, input.expectedHeadSha, firstObservedAt, now, context.pullRequestNumber, context.baseBranch, context.headBranch, context.expectedHeadTree, context.projectRevisionId, policyHash, policyJson, firstObservedAt, propagationDeadline, overallDeadline));
    this.database.authTransaction((db) => db.prepare("UPDATE forge_ci_runs SET superseded_by_run_id = ? WHERE task_id = ? AND company_id = ? AND id <> ? AND superseded_at IS NOT NULL AND superseded_by_run_id IS NULL").run(runId, input.taskId, input.companyId, runId));
    run = this.database.authQuery((db) => db.prepare("SELECT id, attempt, first_observed_at AS firstObservedAt, propagation_deadline AS propagationDeadline, overall_deadline AS overallDeadline, consecutive_provider_failures AS consecutiveProviderFailures FROM forge_ci_runs WHERE release_id = ? AND expected_head_sha = ? AND policy_hash = ? LIMIT 1").get(input.releaseId, input.expectedHeadSha, policyHash) as typeof run);
    if (!run) throw new CiFailure("scope");
    const attemptNumber = requestedAttempt;
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, observed_head_sha AS observedHeadSha, evidence_artifact_id AS evidenceArtifactId, outcome, reason, owner, repairable, retry_at AS retryAt, summary, attempt_number AS attemptNumber FROM forge_ci_attempts WHERE run_id = ? AND attempt_number = ?").get(run.id, attemptNumber) as { id: string; observedHeadSha: string | null; evidenceArtifactId: string | null; outcome: CiOutcome; reason: string; owner: CiOwner; repairable: number; retryAt: string | null; summary: string; attemptNumber: number } | undefined);
    if (existing) return { runId: run.id, attemptId: existing.id, attemptNumber: existing.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: existing.observedHeadSha, evidenceArtifactId: existing.evidenceArtifactId, policyHash, policy, propagationDeadline, overallDeadline, outcome: existing.outcome, reason: existing.reason, owner: existing.owner, repairable: existing.repairable === 1, retryAt: existing.retryAt, nextPollAt: existing.retryAt, selectedChecks: this.readAttemptChecks(existing.id), summary: existing.summary };
    let observed: PullRequestObservation;
    try {
      observed = await this.provider.getPullRequest({ repository: revision.repository, pullRequestNumber: context.pullRequestNumber });
    } catch (error) { return this.persistProviderFailure({ ...input, attemptNumber }, run, policy, policyHash, firstObservedAt, propagationDeadline, overallDeadline, error); }
    let checks: CheckObservation[] = [];
    if (observed.headSha.toLowerCase() === input.expectedHeadSha.toLowerCase() && observed.repository.toLowerCase() === revision.repository.toLowerCase() && observed.number === context.pullRequestNumber) {
      try {
        const rawChecks = await this.provider.listChecks({ repository: revision.repository, headSha: observed.headSha });
        checks = rawChecks.map((check) => CheckObservationSchema.parse(check));
      } catch (error) { return this.persistProviderFailure({ ...input, attemptNumber }, run, policy, policyHash, firstObservedAt, propagationDeadline, overallDeadline, error); }
    }
    let result = evaluateExactHead({ repository: revision.repository, pullRequestNumber: context.pullRequestNumber, expectedRepository: revision.repository, expectedPullRequestNumber: context.pullRequestNumber, expectedHeadSha: input.expectedHeadSha, expectedBaseBranch: context.baseBranch, expectedHeadBranch: context.headBranch, requiredChecks: policy.requiredChecks, observedPullRequest: observed, checks, now, propagationDeadline, overallDeadline });
    const nextRunFailures = 0;
    result = { ...result, retryAt: result.retryAt ?? null };
    return this.persistObservation({ ...input, attemptNumber }, run, policy, policyHash, observed, result, checks, firstObservedAt, propagationDeadline, overallDeadline, nextRunFailures, now);
  }

  private async persistProviderFailure(input: CiReconcileInput & { attemptNumber: number }, run: { id: string; firstObservedAt: string | null; propagationDeadline: string | null; overallDeadline: string | null; consecutiveProviderFailures: number }, policy: CiPolicy, policyHash: string, firstObservedAt: string, propagationDeadline: string, overallDeadline: string, error: unknown): Promise<CiReconcileResult> {
    const failure = error instanceof CiProviderFailure ? error : new CiProviderFailure("transient");
    const count = run.consecutiveProviderFailures + 1;
    const exhausted = failure.code === "transient" && count >= CI_MAX_CONSECUTIVE_PROVIDER_FAILURES;
    const candidateRetryAt = failure.code === "rate_limited" ? failure.retryAt : exhausted || failure.code !== "transient" ? null : new Date(this.now().getTime() + CI_TRANSIENT_BACKOFF_MS[count - 1]!).toISOString();
    const retryAt = candidateRetryAt && Date.parse(candidateRetryAt) > Date.parse(overallDeadline) ? overallDeadline : candidateRetryAt;
    const result: CiEvaluationResult = failure.code === "rate_limited" && retryAt ? { outcome: "rate_limited", reason: "provider_rate_limited", owner: "system", repairable: false, retryAt, selectedChecks: [], summary: failure.safeSummary } : failure.code === "transient" ? { outcome: "provider_unavailable", reason: exhausted ? "provider_failure_budget_exhausted" : "provider_transient_failure", owner: exhausted ? "human" : "system", repairable: false, retryAt, selectedChecks: [], summary: failure.safeSummary } : { outcome: "invalid_provider_response", reason: failure.code === "authentication" ? "provider_authentication_failed" : failure.code === "rate_limit_unbounded" ? "provider_rate_reset_missing" : "invalid_provider_response", owner: "human", repairable: false, retryAt: null, selectedChecks: [], summary: failure.safeSummary };
    return this.persistObservation(input, run, policy, policyHash, null, result, [], firstObservedAt, propagationDeadline, overallDeadline, failure.code === "transient" ? count : 0, this.now().toISOString());
  }

  private async persistObservation(input: CiReconcileInput & { attemptNumber: number }, run: { id: string }, policy: CiPolicy, policyHash: string, observed: PullRequestObservation | null, result: CiEvaluationResult, checks: readonly CheckObservation[], firstObservedAt: string, propagationDeadline: string, overallDeadline: string, consecutiveFailures: number, now: string): Promise<CiReconcileResult> {
    const newAttemptId = attemptId();
    const evidence = JSON.stringify({ policy: { projectRevisionId: policy.projectRevisionId, requiredChecks: policy.requiredChecks, acceptedConclusions: policy.acceptedConclusions }, expectedHeadSha: input.expectedHeadSha, observedPullRequest: observed, checks: checks.map((check) => ({ ...check, selectedForEvaluation: result.selectedChecks.some((selected) => selected.providerCheckId === check.providerCheckId && selected.selectedForEvaluation) })), outcome: result.outcome, reason: result.reason });
    let evidenceArtifact: StoredArtifact | undefined;
    let evidenceArtifactId: string | null = null;
    let evidenceArtifactSha256: string | undefined;
    if (this.artifacts) {
      const artifact = await this.artifacts.put(input.companyId, "ci-evidence", { filename: `${run.id}-${input.attemptNumber}.json`, mimeType: "application/json", bytes: Buffer.from(evidence, "utf8") });
      evidenceArtifact = artifact;
      evidenceArtifactId = artifact.id;
      evidenceArtifactSha256 = artifact.sha256;
      this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
    }
    try {
      this.database.authTransaction((db) => {
      db.prepare(`INSERT INTO forge_ci_attempts (id, run_id, attempt_number, observed_repository, observed_pr_number, observed_base_branch, observed_base_sha, observed_head_branch, observed_head_sha, outcome, reason, owner, repairable, retry_at, summary, evidence_artifact_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newAttemptId, run.id, input.attemptNumber, observed?.repository ?? null, observed?.number ?? null, observed?.baseBranch ?? null, observed?.baseSha ?? null, observed?.headBranch ?? null, observed?.headSha ?? null, result.outcome, result.reason, result.owner, result.repairable ? 1 : 0, result.retryAt, boundedSummary(result.summary), evidenceArtifactId, now);
      for (const check of checks) db.prepare(`INSERT INTO forge_ci_attempt_checks (id, attempt_id, provider_check_id, name, head_sha, status, conclusion, details_url, summary, started_at, completed_at, selected_for_evaluation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`ci_check_${randomBytes(10).toString("hex")}`, newAttemptId, check.providerCheckId, check.name, check.headSha, check.status, check.conclusion, check.detailsUrl, boundedSummary(check.summary), check.startedAt, check.completedAt, result.selectedChecks.some((selected) => selected.providerCheckId === check.providerCheckId && selected.selectedForEvaluation) ? 1 : 0, now);
      db.prepare(`UPDATE forge_ci_runs SET status = ?, next_poll_at = ?, attempt = ?, summary = ?, evidence_artifact_id = ?, first_observed_at = ?, propagation_deadline = ?, overall_deadline = ?, consecutive_provider_failures = ?, completed_at = CASE WHEN ? IS NOT NULL THEN NULL WHEN ? IN ('passed', 'missing_required', 'cancelled', 'timed_out', 'non_success', 'stale_head', 'invalid_provider_response', 'provider_unavailable') THEN ? ELSE completed_at END, updated_at = ? WHERE id = ?`).run(result.outcome, result.retryAt, input.attemptNumber, boundedSummary(result.summary), evidenceArtifactId, firstObservedAt, propagationDeadline, overallDeadline, consecutiveFailures, result.retryAt, result.outcome, now, now, run.id);
      });
    } catch (error) {
      if (evidenceArtifact) {
        this.database.authTransaction((db) => db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(evidenceArtifact!.id, evidenceArtifact!.companyId));
        await this.artifacts?.remove(evidenceArtifact);
      }
      throw error;
    }
    return { runId: run.id, attemptId: newAttemptId, attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: observed?.headSha ?? null, evidenceArtifactId, ...(evidenceArtifactSha256 ? { evidenceArtifactSha256 } : {}), policyHash, policy, propagationDeadline, overallDeadline, ...result, nextPollAt: result.retryAt };
  }

  private readAttemptChecks(id: string): SelectedCheck[] {
    return this.database.authQuery((db) => db.prepare("SELECT provider_check_id AS providerCheckId, name, head_sha AS headSha, status, conclusion, details_url AS detailsUrl, started_at AS startedAt, completed_at AS completedAt, summary, selected_for_evaluation AS selectedForEvaluation FROM forge_ci_attempt_checks WHERE attempt_id = ? ORDER BY id").all(id) as Array<CheckObservation & { selectedForEvaluation: number }>).map((check) => ({ ...check, selectedForEvaluation: check.selectedForEvaluation === 1 }));
  }
}
