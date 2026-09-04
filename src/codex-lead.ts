import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from "./agent-providers/provider.js";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { AgentFailure } from "./agent-failure.js";
import { LeadOutputSchema, LeadPlanningActivityInputSchema, PersistedLeadOutputSchema, type LeadOutput, type LeadPlanningActivityInput, type LeadPlanningResult } from "./lead-contracts.js";
import { ForgeDatabase } from "./database.js";
import { HerdrFailure, CliHerdrClient } from "./herdr-client.js";
import { IssueTimelineEvents } from "./issue-timeline-events.js";
import { HerdrSessionStore } from "./herdr-session-store.js";
import { HerdrTurnRunner, type HerdrTurnInput, type HerdrTurnOutput } from "./herdr-turn-runner.js";
import { redact } from "./logging.js";
import { CiRepairPlanSchema, DeliveryRepairPlanInputSchema, DeliveryRepairPlanResultSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, MergeConflictPlanSchema, ReviewArbitrationActivityInputSchema, ReviewArbitrationActivityResultSchema, ReviewArbitrationSchema, type CiRepairPlanActivityInput, type CiRepairPlanActivityResult, type DeliveryFinding, type DeliveryRepairPlanActivityInput, type DeliveryRepairPlanResult, type DeliveryReview, type DeliveryReviewActivityInput, type DeliveryReviewActivityResult, type ConsolidateLeadPlanActivityInput, type MergeConflictPlanActivityInput, type MergeConflictPlanActivityResult, type ReviewArbitrationActivityInput, type ReviewArbitrationActivityResult, type SupplementalReviewActivityInput, type SupplementalReviewResult } from "./engine/issue-contracts.js";
import { ForwardMergeConflictArtifactSchema, type ForwardMergeConflictArtifact } from "./forward-merge.js";
import { loadTaskConfiguration } from "./task-project-configuration.js";
import { loadDefaultPrompts, renderPrompt } from "./prompts.js";
import { isVersionedPromptSet } from "./prompt-resolution.js";
import { PlanGovernanceRepository } from "./plan-governance-repository.js";
import { json, jsonRequired } from "./task-utils.js";
import { WorktreeFailure, WorktreeManager } from "./worktrees.js";
import { readEnvironmentSettings } from "./environment-settings.js";
import { BrowserProofService } from "./browser-proof.js";
import { buildGitBranchName } from "./git-branch-name.js";
import { fallbackGitPresentation } from "./git-presentation.js";
import { isTaskTurnLive, type TaskTurnLiveness } from "./engine/activities/herdr-liveness.js";

const execFileAsync = promisify(execFile);
const PROJECT_VERIFICATION_FAILURE_PREFIX = "Project verification failed:";
type MergeConflictPlanInput = MergeConflictPlanActivityInput;

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const LeadReviewResponseSchema = z.object({
  version: z.literal(1),
  originalPlanRevision: z.number().int().nonnegative(),
  reviewArtifactId: durableId,
  reviewResponse: z.string().min(1),
  result: LeadOutputSchema,
}).strict();
export { AskUserQuestionSchema, DecisionBlockerSchema, LeadOutputSchema, LeadPlanSchema, LeadPlanningActivityInputSchema, PersistedLeadOutputSchema, type AskUserQuestion, type PersistedLeadOutput } from "./lead-contracts.js";
export type { DecisionBlocker, LeadOutput, LeadPlan, LeadPlanningActivityInput, LeadPlanningResult, LegacyLeadPlanningResult } from "./lead-contracts.js";
export const SupplementalReviewSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const review = value as Record<string, unknown>;
    if (review.opinion === "approve" || review.opinion === "request_changes") return { verdict: review.opinion === "approve" ? "approve" : "revise", summary: review.summary, concerns: Array.isArray(review.concerns) ? review.concerns.map((text) => ({ severity: "advisory", text })) : Array.isArray(review.requiredChanges) ? review.requiredChanges.map((text) => ({ severity: "blocking", text })) : [] };
  }
  return value;
}, z.object({
  verdict: z.enum(["approve", "revise"]),
  summary: z.string().min(1),
  concerns: z.array(z.object({ severity: z.enum(["blocking", "advisory"]), text: z.string().min(1), step: z.number().int().positive().optional() })),
}));

export const DeliveryRepairLeadOutputSchema = z.object({
  kind: z.literal("delivery_repair_plan"),
  summary: z.string().min(1),
  steps: z.array(z.object({ number: z.number().int().positive(), instruction: z.string().min(1), verification: z.string().min(1) })).min(1),
  verificationStrategy: z.string().min(1),
  unresolvedTechnicalQuestions: z.array(z.string()).length(0),
});
export type SupplementalReview = z.infer<typeof SupplementalReviewSchema>;

export { AgentFailure } from "./agent-failure.js";

export function isAgentExecutionActiveLeaseCollision(error: unknown): boolean {
  const sqliteError = error as { code?: unknown; message?: unknown };
  return sqliteError?.code === "SQLITE_CONSTRAINT_UNIQUE"
    && typeof sqliteError.message === "string"
    && sqliteError.message.includes("forge_agent_executions.task_id");
}

async function readOptionalInstruction(filename: string): Promise<string | undefined> {
  try {
    const value = await readFile(filename, "utf8");
    return value.length > 100_000 ? `${value.slice(0, 100_000)}\n[truncated]` : value;
  } catch {
    return undefined;
  }
}

function promptExcerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const tail = Math.min(4_000, Math.floor(limit / 5));
  return `${value.slice(0, limit - tail)}\n[truncated ${value.length - limit} characters]\n${value.slice(-tail)}`;
}

type StoredRepairCoverage = { findingId: string; path: string; touched: boolean };

export function repairCoveragePrompt(raw: string | null): string {
  if (!raw) return "";
  const parsed = json(raw, {}) as { coverage?: StoredRepairCoverage[] };
  const untouched = parsed.coverage?.filter((entry) => !entry.touched) ?? [];
  if (untouched.length === 0) return "";
  return `Repair coverage: ${untouched.map((entry) => `${entry.findingId} names ${entry.path}; the repair commit did not touch it.`).join(" ")}`;
}

async function readDeliveryGitEvidence(worktreePath: string, targetBaseSha: string, subjectCommit: string, subjectTree: string, repositoryPath: string): Promise<{ targetBaseSha: string; subjectCommit: string; subjectTree: string; status: string; branch: string; head: string; tree: string; diff: string; commit: string; instructions: string }> {
  const run = async (args: string[], maxBuffer: number): Promise<string> => (await execFileAsync("git", args, { cwd: worktreePath, timeout: 20_000, maxBuffer })).stdout;
  const [status, branch, head, tree, resolvedCommit, resolvedTree, commitTree, diff, commit] = await Promise.all([
    run(["status", "--porcelain=v1", "--untracked-files=all"], 64 * 1024),
    run(["symbolic-ref", "--short", "HEAD"], 4 * 1024),
    run(["rev-parse", "HEAD"], 4 * 1024),
    run(["rev-parse", "HEAD^{tree}"], 4 * 1024),
    run(["rev-parse", "--verify", `${subjectCommit}^{commit}`], 4 * 1024),
    run(["rev-parse", "--verify", `${subjectTree}^{tree}`], 4 * 1024),
    run(["rev-parse", "--verify", `${subjectCommit}^{tree}`], 4 * 1024),
    run(["diff", "--no-ext-diff", "--binary", `${targetBaseSha}..${subjectCommit}`], 2 * 1024 * 1024),
    run(["show", "--no-ext-diff", "--format=fuller", "--stat", "--summary", subjectCommit], 128 * 1024),
  ]);
  if (resolvedCommit.trim().toLowerCase() !== subjectCommit.toLowerCase() || resolvedTree.trim().toLowerCase() !== subjectTree.toLowerCase() || commitTree.trim().toLowerCase() !== subjectTree.toLowerCase()) throw new Error("The recorded delivery commit and tree do not identify the same git revision");
  const instructionPaths = [
    join(repositoryPath, "AGENTS.md"),
    join(repositoryPath, "CLAUDE.md"),
    join(worktreePath, "AGENTS.md"),
    join(worktreePath, "CLAUDE.md"),
  ];
  const instructionEntries = await Promise.all([...new Set(instructionPaths)].map(async (filename) => {
    const contents = await readOptionalInstruction(filename);
    return contents === undefined ? undefined : `--- ${filename} ---\n${contents}`;
  }));
  return {
    targetBaseSha,
    subjectCommit,
    subjectTree: tree.trim(),
    status: redact(status.trim()) as string,
    branch: branch.trim(),
    head: head.trim(),
    tree: tree.trim(),
    diff: redact(diff) as string,
    commit: redact(commit) as string,
    instructions: instructionEntries.filter((entry): entry is string => entry !== undefined).join("\n"),
  };
}

type DeliveryGitEvidence = Awaited<ReturnType<typeof readDeliveryGitEvidence>>;

function matchesDeliverySubject(evidence: DeliveryGitEvidence, branchName: string, subjectCommit: string, subjectTree: string): boolean {
  return evidence.status.length === 0
    && evidence.branch === branchName
    && evidence.head.toLowerCase() === subjectCommit.toLowerCase()
    && evidence.tree.toLowerCase() === subjectTree.toLowerCase();
}

export function deliveryBlockCode(failure: AgentFailure): import("./engine/issue-contracts.js").DeliveryOperationBlockCode {
  if (failure.code === "login-expired" || failure.code === "authentication-required") return "authentication-required";
  if (failure.code === "rate-limited") return "rate-limited";
  if (failure.code === "evidence-too-large") return "evidence-too-large";
  if (failure.code === "session-identity-conflict" || failure.code === "session-conflict") return "session-conflict";
  if (failure.code === "delivery-revision-changed" || failure.code === "unsafe-working-directory") return "subject-changed";
  if (failure.code === "malformed-review-output" || failure.code === "missing-review-output" || failure.code === "invalid-review-output") return "invalid-output";
  if (failure.code === "invalid-output-schema") return "invalid-output";
  if (failure.code === "turn-failed") return "process-failed";
  if (["process-failed", "process-exited", "process-crashed"].includes(failure.code)) return "process-failed";
  return "preflight-failed";
}

export function safeBlockSummary(code: import("./engine/issue-contracts.js").DeliveryOperationBlockCode, correctionExhausted = false, reason?: string): string {
  if (correctionExhausted) return "The Lead returned invalid review output after one format correction; retry the review.";
  const summaries: Record<import("./engine/issue-contracts.js").DeliveryOperationBlockCode, string> = {
    "invalid-output": "The Lead review was not machine-readable; retry the review.",
    "correction-exhausted": "The Lead returned invalid review output after one format correction; retry the review.",
    "session-conflict": "The Lead review returned a different session identity; retry the review.",
    "authentication-required": reason ?? "Agent provider authentication is unavailable; sign in again, then retry.",
    "rate-limited": "Agent provider rate limiting prevented the review from completing; retry later.",
    "process-failed": "The Lead review process did not complete; inspect the evidence and retry.",
    "preflight-failed": reason ?? "The Lead review preflight failed; inspect the evidence and retry.",
    "evidence-too-large": "Lead review evidence exceeded the local artifact limit; retry with bounded output.",
    "subject-changed": "The Developer worktree is on another branch.",
    "repair-incomplete": "The repair did not address every open blocking finding.",
    "repair-scope": "The Developer reported that the repair is blocked.",
    "worktree-unsafe": "The Developer worktree is unavailable or on another branch.",
    "repair-cap-exhausted": "The configured repair-cycle limit has been reached.",
  };
  return summaries[code];
}

async function taskScopedPath(root: string, candidate: string): Promise<string> {
  const absoluteRoot = await realpath(root);
  const absoluteCandidate = await realpath(resolve(candidate));
  const relativePath = relative(absoluteRoot, absoluteCandidate);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new AgentFailure("unsafe-working-directory", "Lead working directory is outside the configured repository root", { nonRetryable: true });
  return absoluteCandidate;
}

interface PlanningRow {
  title: string;
  project_slug: string;
  issue_key: string | null;
  normalized_json: string;
  description: string | null;
  brief_storage_path: string | null;
  brief_sha256: string | null;
}

interface ProfileSettings {
  id: string;
  name: string;
  provider: AgentProviderKind;
  model: string;
  reasoningLevel: string;
  servicePriority: string;
  capacity: number;
}

interface ImageRow {
  id: string;
  storage_path: string;
  sha256: string;
  filename: string;
  mime_type: string;
}

interface DeliveryReviewContext {
  title: string;
  normalizedJson: string;
  description: string | null;
  legacyBriefStoragePath: string | null;
  legacyBriefSha256: string | null;
  planStoragePath: string;
  planSha256: string;
  deliveryStoragePath: string;
  deliverySha256: string;
  evidenceStoragePath: string;
  evidenceSha256: string;
  developerSessionRef: string | null;
  developerExecutionId: string;
  deliveryArtifactId: string;
  developerEvidenceArtifactId: string;
  developerResultCommit: string | null;
  developerResultTree: string | null;
  forwardMergePriorHead: string | null;
  forwardMergeTargetBaseSha: string | null;
}

export interface AgentServiceOptions {
  now?: () => Date;
  turnRunner?: { run<T>(input: HerdrTurnInput<T>): Promise<HerdrTurnOutput<T>> };
  worktrees?: WorktreeManager;
  readDeliveryGitEvidence?: typeof readDeliveryGitEvidence;
  isTaskTurnLive?: (taskId: string) => Promise<TaskTurnLiveness>;
  wait?: (milliseconds: number) => Promise<void>;
}

export class AgentService {
  private readonly artifacts: ArtifactStore;
  private readonly browserProof: BrowserProofService;
  private readonly now: () => Date;
  private readonly turnRunner: { run<T>(input: HerdrTurnInput<T>): Promise<HerdrTurnOutput<T>> };
  private readonly worktrees: WorktreeManager;
  private readonly readDeliveryGitEvidence: typeof readDeliveryGitEvidence;
  private readonly isTaskTurnLive: (taskId: string) => Promise<TaskTurnLiveness>;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig, options: AgentServiceOptions = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot, database);
    this.browserProof = new BrowserProofService(database, this.artifacts);
    this.now = options.now ?? (() => new Date());
    const herdr = new CliHerdrClient();
    this.turnRunner = options.turnRunner ?? new HerdrTurnRunner(database, herdr, new HerdrSessionStore(database, herdr), new IssueTimelineEvents(database), this.artifacts);
    this.worktrees = options.worktrees ?? new WorktreeManager(undefined, () => readEnvironmentSettings(database).minFreeDiskGb);
    this.readDeliveryGitEvidence = options.readDeliveryGitEvidence ?? readDeliveryGitEvidence;
    this.isTaskTurnLive = options.isTaskTurnLive ?? ((taskId) => isTaskTurnLive(database, config, taskId));
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  }

  private renderTaskPrompt(input: { taskId: string; companyId: string }, path: string, values: Record<string, string>): string {
    const configuration = loadTaskConfiguration(this.database.authQuery((db) => db), this.artifacts, input);
    const guidance = "pull-request/guidance.md";
    if (!configuration.prompts) { const defaults = loadDefaultPrompts(); return renderPrompt(defaults.get(path as import("./prompts.js").PromptPath)!, { pull_request_guidance: defaults.get(guidance)!, ...values }); }
    const pinned = configuration.prompts;
    const artifact = this.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-prompt-set'").get(pinned.artifactId, input.companyId) as { storage_path: string } | undefined);
    if (!artifact) throw new AgentFailure("scoped-input-missing", "Pinned task prompts are unavailable");
    const parsed = jsonRequired(this.artifacts.getArtifactSync({ companyId: input.companyId, storagePath: artifact.storage_path, sha256: pinned.sha256 }).toString("utf8")) as unknown;
    const prompts = isVersionedPromptSet(parsed) ? parsed.prompts : parsed as Record<string, string>;
    const prompt = prompts[path];
    if (prompt === undefined) throw new AgentFailure("scoped-input-missing", `Pinned task prompt is unavailable: ${path}`);
    return renderPrompt(prompt, { pull_request_guidance: prompts[guidance] ?? loadDefaultPrompts().get(guidance)!, ...values });
  }

  async planDeliveryRepair(rawInput: DeliveryRepairPlanActivityInput): Promise<DeliveryRepairPlanResult> {
    const input = DeliveryRepairPlanInputSchema.parse(rawInput);
    const scoped = this.database.authQuery((db) => db.prepare(`SELECT t.id, p.name AS projectSlug,
      CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey
      FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_companies c ON c.id = t.company_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ?`).get(input.taskId, input.companyId, input.projectId, input.workflowId) as { id: string; projectSlug: string; issueKey: string | null } | undefined);
    if (!scoped) throw new AgentFailure("scoped-input-missing", "Delivery repair planning evidence is unavailable");
    this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
    const openFindings = input.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    if (!openFindings.length) throw new AgentFailure("repair-plan-invalid", "Delivery repair planning requires an open blocking finding");
    const worktreePath = await taskScopedPath(this.config.worktreeRoot, input.worktreePath);
    const profile = await this.resolveTurnProfile(undefined, input.leadSessionRef, "Lead");
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES (?, ?, ?, ?, 'planner', 'starting', 1, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.leadSessionRef, startedAt);
    });
    let output: z.infer<typeof DeliveryRepairLeadOutputSchema>;
    let leadSessionRef = input.leadSessionRef;
    try {
      const schemaPath = await this.ensureResultSchema("delivery-repair-plan", DeliveryRepairLeadOutputSchema);
      const result = await this.turnRunner.run({ task: { taskId: input.taskId, projectId: input.projectId, projectSlug: scoped.projectSlug, ...(scoped.issueKey ? { issueKey: scoped.issueKey } : {}), worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "planner", ledger: "agent", executionId, promptKind: "delivery-repair-plan", prompt: this.deliveryRepairPlanPrompt(input, openFindings), profile, resultSchema: DeliveryRepairLeadOutputSchema, schemaPath, companyId: input.companyId, workflowId: input.workflowId, revision: input.planRevision });
      output = result.result;
      leadSessionRef = result.roleSessionId;
    } catch (error) {
      const failure = this.repairTurnFailure(error, "delivery");
      const evidence = await this.persistEvidence(input.companyId, executionId, []);
      this.database.authTransaction((db) => { db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId); });
      throw failure;
    }
    const summary = output.summary;
    const authorityEvidence = {
      source: input.source,
      planRevision: input.planRevision,
      exactContext: {
        taskId: input.taskId,
        companyId: input.companyId,
        workflowId: input.workflowId,
        projectId: input.projectId,
        projectRevisionId: input.projectRevisionId,
        releaseId: input.releaseId ?? null,
        deliveryReviewId: input.deliveryReviewId ?? null,
        finalReviewId: input.finalReviewId ?? null,
        ciRunId: input.ciRunId ?? null,
        acceptanceId: input.acceptanceId ?? null,
        reasonArtifactId: input.reasonArtifactId ?? null,
        branchName: input.branchName,
        targetBaseSha: input.targetBaseSha,
        subjectCommit: input.subjectCommit,
        subjectTree: input.subjectTree,
        leadSessionRef,
      },
      findingIds: openFindings.map((finding) => finding.findingId),
    };
    const planText = [`<!-- forge-repair-authority ${JSON.stringify(authorityEvidence)} -->`, "", summary, "", ...output.steps.map((step) => `${step.number}. ${step.instruction}\n   Verify: ${step.verification}`), "", `Verification: ${output.verificationStrategy}`, "Unresolved technical questions: none."].join("\n");
    const evidenceText = JSON.stringify({
      ...authorityEvidence,
      evidenceArtifactIds: input.evidenceArtifactIds,
    }, null, 2);
    const [planArtifact, evidenceArtifact] = await Promise.all([
      this.artifacts.putArtifact(input.companyId, "delivery-repair-plan", { filename: `${input.source}-${input.planRevision}.md`, mimeType: "text/markdown", bytes: Buffer.from(planText, "utf8") }),
      this.artifacts.putArtifact(input.companyId, "agent-evidence", { filename: `${input.source}-${input.planRevision}-repair.json`, mimeType: "application/json", bytes: Buffer.from(evidenceText, "utf8") }),
    ]);
    const planId = `repair_plan_${createHash("sha256").update(JSON.stringify({ workflowId: input.workflowId, source: input.source, planRevision: input.planRevision, leadSessionRef, findings: openFindings.map((finding) => finding.findingId), subjectCommit: input.subjectCommit, subjectTree: input.subjectTree })).digest("hex").slice(0, 32)}`;
    this.database.authTransaction((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = ?, finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(leadSessionRef, this.now().toISOString(), this.now().toISOString(), evidenceArtifact.id, executionId));
    return DeliveryRepairPlanResultSchema.parse({ planId, leadExecutionId: executionId, planArtifactId: planArtifact.id, planSha256: planArtifact.sha256, evidenceArtifactId: evidenceArtifact.id, leadSessionRef, summary, findings: openFindings });
  }

  private repairTurnFailure(error: unknown, kind: "ci" | "delivery"): AgentFailure {
    if (error instanceof AgentFailure) {
      if (error.code !== "invalid-output-schema") return error;
      return new AgentFailure(kind === "ci" ? "invalid-ci-repair-plan" : "invalid-repair-plan-output", error.message, { nonRetryable: true });
    }
    if (error instanceof HerdrFailure) return new AgentFailure(kind === "ci" ? "ci-repair-plan-failed" : "repair-plan-failed", error.message, { nonRetryable: !error.retryable });
    return new AgentFailure(kind === "ci" ? "ci-repair-plan-failed" : "repair-plan-failed", "Interactive Lead repair planning failed");
  }

  async runLeadPlanning(rawInput: LeadPlanningActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<LeadPlanningResult> {
    const input = LeadPlanningActivityInputSchema.parse(rawInput);
    const row = this.database.authQuery((db) => db.prepare(`SELECT t.title, p.name AS project_slug,
      CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issue_key,
      t.description, b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256
      FROM forge_tasks t
      JOIN forge_projects p ON p.id = t.project_id
      JOIN forge_companies c ON c.id = t.company_id
      LEFT JOIN forge_artifacts b ON b.id = t.brief_artifact_id AND b.kind = 'task-brief'
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ?`).get(input.taskId, input.companyId, input.projectId, input.workflowId) as PlanningRow | undefined);
    if (!row) throw new AgentFailure("scoped-input-missing", "Plan evidence is unavailable");
    const configuration = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
    row.normalized_json = JSON.stringify(configuration);
    const completed = await this.completedPlanningResult(input);
    if (completed) return completed;
    const revisionRequest = input.revisionRequestId ? this.database.authQuery((db) => db.prepare(`SELECT r.disposition, r.worktree_path AS worktreePath, r.branch_name AS branchName, r.base_sha AS baseSha, r.head_sha AS headSha, r.tree_sha AS treeSha, r.exact_base_sha AS exactBaseSha, a.storage_path AS reasonPath, a.sha256 AS reasonSha
      FROM forge_plan_revision_requests r JOIN forge_artifacts a ON a.id = r.reason_artifact_id AND a.company_id = r.company_id AND a.kind = 'plan-revision-reason'
      WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ?`).get(input.revisionRequestId, input.taskId, input.companyId, input.workflowId) as { disposition: "reuse" | "new"; worktreePath: string | null; branchName: string | null; baseSha: string | null; headSha: string | null; treeSha: string | null; exactBaseSha: string | null; reasonPath: string; reasonSha: string } | undefined) : undefined;
    if (input.revisionRequestId && !revisionRequest) throw new AgentFailure("revision-request-missing", "The plan revision request is unavailable");
    const worktreePath = await this.planningWorktree(input, configuration, row.title, revisionRequest);
    let sourceGuidance = "";
    if (configuration.source) {
      const sourceBranch = configuration.source.kind === "pull_request" ? configuration.source.headBranch : configuration.source.branch;
      try {
        await execFileAsync("git", ["fetch", "--no-tags", "origin", `refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`], { cwd: worktreePath, timeout: 30_000, maxBuffer: 64 * 1024 });
        const mergeBase = (await execFileAsync("git", ["merge-base", `refs/remotes/origin/${configuration.baseBranch}`, `refs/remotes/origin/${sourceBranch}`], { cwd: worktreePath, timeout: 8_000, maxBuffer: 4 * 1024 })).stdout.trim();
        sourceGuidance = `\n\nThis task continues the existing source branch \`${sourceBranch}\` at \`origin/${sourceBranch}\`. Before planning, inspect its commits and complete diff from merge-base \`${mergeBase}\` with \`git log ${mergeBase}..origin/${sourceBranch}\` and \`git diff ${mergeBase}..origin/${sourceBranch}\`. Plan against the source changes, not only the base checkout.`;
      } catch { throw new AgentFailure("source-branch-unavailable", "The selected source branch could not be inspected for planning"); }
    }
    const brief = row.description ?? (() => {
      if (!row.brief_storage_path || !row.brief_sha256) throw new AgentFailure("scoped-input-missing", "Task description is unavailable");
      const migrated = this.artifacts.getArtifactSync({ companyId: input.companyId, storagePath: row.brief_storage_path, sha256: row.brief_sha256 }).toString("utf8");
      this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET description = ? WHERE id = ? AND company_id = ? AND description IS NULL").run(migrated, input.taskId, input.companyId));
      return migrated;
    })();
    const revisionNote = input.revisionNoteArtifactId
      ? this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'plan-decision'").get(input.revisionNoteArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined)
      : undefined;
    if (input.revisionNoteArtifactId && !revisionNote) throw new AgentFailure("scoped-input-missing", "The member revision note is unavailable");
    const memberResponse = input.memberResponseArtifactId
      ? this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'plan-blocker-response'").get(input.memberResponseArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined)
      : undefined;
    if (input.memberResponseArtifactId && !memberResponse) throw new AgentFailure("scoped-input-missing", "The member blocker response is unavailable");
    const revisionNoteText = revisionNote ? (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: revisionNote.storagePath, sha256: revisionNote.sha256 })).toString("utf8") : undefined;
    const memberResponseText = memberResponse ? (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: memberResponse.storagePath, sha256: memberResponse.sha256 })).toString("utf8") : undefined;
    const images = this.database.authQuery((db) => {
      if (!input.imageArtifactIds.length) return [] as ImageRow[];
      const placeholders = input.imageArtifactIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, storage_path, sha256, filename, mime_type FROM forge_artifacts WHERE company_id = ? AND kind = 'task-image' AND id IN (${placeholders})`).all(input.companyId, ...input.imageArtifactIds) as Array<ImageRow & { id: string }>;
      const byId = new Map(rows.map((row) => [row.id, row]));
      return input.imageArtifactIds.flatMap((imageId) => { const row = byId.get(imageId); return row ? [row] : []; });
    });
    if (images.length !== input.imageArtifactIds.length) throw new AgentFailure("scoped-input-missing", "Lead image evidence is unavailable");
    for (const image of images) await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: image.storage_path, sha256: image.sha256 });
    const profileSettings = this.database.authQuery((db) => {
      const profileIds = Object.values(input.roleProfiles).filter((value): value is string => typeof value === "string");
      if (!profileIds.length) return [] as ProfileSettings[];
      const placeholders = profileIds.map(() => "?").join(",");
      return db.prepare(`SELECT id, name, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority, capacity FROM forge_profiles WHERE id IN (${placeholders})`).all(...profileIds) as ProfileSettings[];
    });
    if (!input.roleProfiles.planner) throw new AgentFailure("profile-unavailable", "Planning requires a configured Lead profile");
    const resumeSessionRef = input.resume?.leadSessionRef ?? input.leadSessionRef ?? input.resumeLeadSessionRef;
    const pinned = resumeSessionRef ? this.database.authQuery((db) => db.prepare("SELECT e.profile_id AS profileId, COALESCE(e.provider, p.provider, 'codex') AS provider, e.resolved_model AS model, e.resolved_reasoning_level AS reasoningLevel, e.resolved_service_priority AS servicePriority FROM forge_agent_executions e LEFT JOIN forge_profiles p ON p.id = e.profile_id WHERE e.session_ref = ? AND e.company_id = ? AND e.role = 'planner' AND e.resolved_model IS NOT NULL ORDER BY e.started_at DESC LIMIT 1").get(resumeSessionRef, input.companyId) as { profileId: string | null; provider: string; model: string; reasoningLevel: string; servicePriority: string } | undefined) : undefined;
    const persisted = pinned;
    let leadProfile = persisted
      ? { id: persisted.profileId ?? input.roleProfiles.planner ?? "pinned-lead", name: "Pinned Lead", provider: persisted.provider as AgentProviderKind, model: persisted.model, reasoningLevel: persisted.reasoningLevel, servicePriority: persisted.servicePriority, capacity: 0 }
      : profileSettings.find((profile) => profile.id === input.roleProfiles.planner);
    if (!leadProfile) throw new AgentFailure("profile-unavailable", "The configured Lead profile is unavailable");
    const revisionContext = revisionRequest ? { ...revisionRequest, reason: (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: revisionRequest.reasonPath, sha256: revisionRequest.reasonSha })).toString("utf8") } : undefined;
    if (!AGENT_PROVIDER_KINDS.includes(leadProfile.provider) || !/^[a-z0-9][a-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,119})?$/.test(leadProfile.model) || !["low", "medium", "high", "xhigh"].includes(leadProfile.reasoningLevel) || !["standard", "priority", "fast"].includes(leadProfile.servicePriority)) {
      throw new AgentFailure("scope_configuration", "The configured Lead profile has invalid turn settings", { nonRetryable: true });
    }
    const repositoryEvidence = await this.repositoryEvidence(worktreePath);
    let executionId = `agent_${randomBytes(12).toString("hex")}`;
    let sessionRef: string | undefined = resumeSessionRef;
    let resumeInstruction = "";
    if (input.resume) {
      const instruction = this.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.resume!.instructionArtifactId, input.companyId) as { storage_path: string; sha256: string } | undefined);
      if (!instruction) throw new AgentFailure("scoped-input-missing", "The Lead resume instruction is unavailable");
      resumeInstruction = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: instruction.storage_path, sha256: instruction.sha256 })).toString("utf8");
    }
    const startedAt = this.now().toISOString();
    const turnKey = `${input.workflowId}:lead-planning:${input.revision}`;
    try {
      this.database.authTransaction((db) => {
        const existing = db
          .prepare(
            "SELECT id, status, attempt, session_ref, heartbeat_at FROM forge_agent_executions WHERE turn_key = ?",
          )
          .get(turnKey) as
          | {
              id: string;
              status: string;
              attempt: number;
              session_ref: string | null;
              heartbeat_at: string | null;
            }
          | undefined;
        if (existing) {
          const heartbeat = existing.heartbeat_at
            ? Date.parse(existing.heartbeat_at)
            : Number.NaN;
          const liveHeartbeat =
            Number.isFinite(heartbeat) &&
            heartbeat >= this.now().getTime() - 30_000;
          if (
            existing.status !== "failed" &&
            ["starting", "running", "cancelling"].includes(existing.status) &&
            liveHeartbeat
          )
            throw new AgentFailure(
              "active-lease",
              "A Lead execution is already active for this issue",
            );
          const claim = db
            .prepare(
              "UPDATE forge_agent_executions SET status = 'starting', attempt = ?, heartbeat_at = ?, finished_at = NULL, failure_code = NULL, failure_summary = NULL, cancellation_requested_at = NULL, cancelled_at = NULL WHERE id = ? AND status = ?",
            )
            .run(existing.attempt + 1, startedAt, existing.id, existing.status);
          if (claim.changes !== 1)
            throw new AgentFailure(
              "active-lease",
              "A Lead execution is already active for this issue",
            );
          executionId = existing.id;
          sessionRef = existing.session_ref ?? sessionRef;
          return;
        }
        db.prepare(`INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, provider, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, heartbeat_at, event_offset) VALUES (?, ?, ?, ?, 'planner', 'starting', 1, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(executionId, input.taskId, input.companyId, input.workflowId, turnKey, input.revision, leadProfile.id, leadProfile.provider, leadProfile.model, leadProfile.reasoningLevel, leadProfile.servicePriority, sessionRef ?? null, startedAt, startedAt);
      });
    } catch (error) {
      if (error instanceof AgentFailure) throw error;
      if (isAgentExecutionActiveLeaseCollision(error)) throw new AgentFailure("active-lease", "A Lead execution is already active for this issue");
      throw error;
    }

    const evidenceLines: string[] = [];
    this.database.authTransaction((db) => {
      db.prepare("UPDATE forge_agent_executions SET session_ref = ? WHERE id = ?").run(sessionRef ?? null, executionId);
    });
    try {
      const revisionPrompt = input.operatorNotes?.length || revisionNoteText || memberResponseText;
      const prompt = revisionPrompt
        ? this.revisionPrompt(input.operatorNotes?.length ? input.operatorNotes.map((note) => `The operator asked: ${note}`).join("\n") : revisionNoteText ?? `Human blocker answer:\n${memberResponseText}`)
        : `${this.initialPrompt(input, row.title, brief, row.normalized_json, profileSettings, repositoryEvidence, revisionContext)}\n\nPlan only work that can be completed and verified inside an isolated git worktree. Do not add steps for deployment, rollout, physical device checks or production verification — mention them in a 'Follow-up outside Forge' note instead.`;
      const result = await this.turnRunner.run({ task: { taskId: input.taskId, projectId: input.projectId, projectSlug: row.project_slug, ...(row.issue_key ? { issueKey: row.issue_key } : {}), worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "planner", ledger: "agent", executionId, promptKind: revisionPrompt ? "lead-plan-revision" : "lead-plan", prompt: `${prompt}${sourceGuidance}${resumeInstruction ? `\n\nMember instruction for this ${input.resume?.reason ?? "revision"}:\n${resumeInstruction}` : ""}`, profile: leadProfile, resultSchema: LeadOutputSchema, schemaPath: await this.ensureResultSchema("lead-plan", LeadOutputSchema), companyId: input.companyId, workflowId: input.workflowId, revision: input.revision, signal: runtime.signal });
      sessionRef = result.roleSessionId;
      const artifacts = await this.persistOutput(input, executionId, sessionRef, evidenceLines, result.result);
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = ?, process_pid = NULL, process_group_id = NULL, finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), this.now().toISOString(), artifacts.evidence.id, executionId));
      return artifacts.result;
    } catch (error) {
      const cancelled = runtime.signal?.aborted === true;
      const failure = cancelled ? new AgentFailure("cancelled", "The Codex Lead turn was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("lead-failed", `Codex Lead execution failed: ${error instanceof Error ? error.message : String(error)}`);
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(cancelled ? "cancelled" : "failed", this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, cancelled ? this.now().toISOString() : null, evidence.id, executionId));
      throw failure;
    }
  }

  async planMergeConflict(rawInput: MergeConflictPlanActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<MergeConflictPlanActivityResult> {
    const input = rawInput;
    const executionRole = input.executionRole ?? "planner";
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, t.description, p.name AS projectSlug,
      CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey,
      b.storage_path AS legacyBriefStoragePath, b.sha256 AS legacyBriefSha256, pa.storage_path AS planStoragePath, pa.sha256 AS planSha256
      FROM forge_tasks t
      JOIN forge_projects p ON p.id = t.project_id
      JOIN forge_companies c ON c.id = t.company_id
      LEFT JOIN forge_artifacts b ON b.id = t.brief_artifact_id AND b.kind = 'task-brief'
      JOIN forge_agent_executions io ON io.task_id = t.id AND io.company_id = t.company_id AND io.workflow_id = t.workflow_id AND io.output_artifact_id = ? AND io.output_revision = ?
      JOIN forge_artifacts pa ON pa.id = io.output_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ?`).get(input.leadOutputArtifactId, input.planRevision, input.taskId, input.companyId, input.projectId, input.projectRevisionId) as { title: string; description: string | null; projectSlug: string; issueKey: string | null; legacyBriefStoragePath: string | null; legacyBriefSha256: string | null; planStoragePath: string; planSha256: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Merge-conflict planning evidence is unavailable");
    let conflict: ForwardMergeConflictArtifact;
    const conflictRow = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a JOIN forge_forward_merges f ON f.conflict_artifact_id = a.id AND f.id = ? AND f.task_id = ? AND f.company_id = ? AND f.project_revision_id = ? WHERE a.id = ? AND a.company_id = ? AND a.kind = 'forward-merge-conflict'").get(input.forwardMergeId, input.taskId, input.companyId, input.projectRevisionId, input.conflictArtifact.id, input.companyId) as { storagePath: string; sha256: string } | undefined);
    if (!conflictRow) throw new AgentFailure("scoped-input-missing", "Forward-merge conflict evidence is unavailable");
    try {
      conflict = ForwardMergeConflictArtifactSchema.parse(jsonRequired((await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: conflictRow.storagePath, sha256: conflictRow.sha256 })).toString("utf8")));
    } catch {
      throw new AgentFailure("scoped-input-corrupt", "Forward-merge conflict evidence failed integrity validation");
    }
    if (conflict.priorHead.toLowerCase() !== input.priorHead.toLowerCase() || conflict.observedBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase() || conflict.conflictFiles.length !== input.conflictFileCount) throw new AgentFailure("merge-conflict-identity-mismatch", "Forward-merge conflict evidence does not match the recorded merge");
    let pinnedCommands: { setupCommand: string; verificationCommand: string };
    try {
    const revision = loadTaskConfiguration(this.database.authQuery((db) => db), this.artifacts, input);
      pinnedCommands = { setupCommand: revision.setupCommand, verificationCommand: revision.verificationCommand };
    } catch {
      throw new AgentFailure("scoped-input-missing", "The accepted project revision has no valid pinned verification commands");
    }
    const planId = `merge_plan_${createHash("sha256").update(`${input.workflowId}:${input.priorHead}:${input.targetBaseSha}`).digest("hex").slice(0, 32)}`;
    const existingPlan = this.database.authQuery((db) => db.prepare("SELECT r.plan_artifact_id AS planArtifactId, r.plan_evidence_artifact_id AS evidenceArtifactId, r.lead_execution_id AS leadExecutionId, r.lead_session_ref AS leadSessionRef, p.storage_path AS planStoragePath, p.sha256 AS planSha256 FROM forge_merge_conflict_resolutions r JOIN forge_artifacts p ON p.id = r.plan_artifact_id WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.status = 'planned'").get(planId, input.taskId, input.companyId, input.workflowId) as { planArtifactId: string; evidenceArtifactId: string; leadExecutionId: string; leadSessionRef: string; planStoragePath: string; planSha256: string } | undefined);
    if (existingPlan) {
      const output = MergeConflictPlanSchema.parse(jsonRequired((await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: existingPlan.planStoragePath, sha256: existingPlan.planSha256 })).toString("utf8")));
      return { planId, planArtifactId: existingPlan.planArtifactId, evidenceArtifactId: existingPlan.evidenceArtifactId, leadExecutionId: existingPlan.leadExecutionId, leadSessionRef: existingPlan.leadSessionRef, summary: output.summary, disposition: output.disposition, ...(output.question ? { question: output.question } : {}), ...(output.choices ? { choices: output.choices } : {}), ...(output.recommendedChoiceId ? { recommendedChoiceId: output.recommendedChoiceId } : {}) };
    }
    const worktreePath = await taskScopedPath(this.config.worktreeRoot, input.worktreePath);
    const brief = context.description ?? (() => {
      if (!context.legacyBriefStoragePath || !context.legacyBriefSha256) throw new AgentFailure("scoped-input-missing", "Task description is unavailable");
      const migrated = this.artifacts.getArtifactSync({ companyId: input.companyId, storagePath: context.legacyBriefStoragePath, sha256: context.legacyBriefSha256 }).toString("utf8");
      this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET description = ? WHERE id = ? AND company_id = ? AND description IS NULL").run(migrated, input.taskId, input.companyId));
      return migrated;
    })();
    const plan = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 })).toString("utf8");
    const leadProfile = await this.resolveTurnProfile(input.roleProfiles?.[executionRole] ?? input.roleProfiles?.planner, input.leadSessionRef, "Integrator", executionRole);
    const schemaPath = await this.ensureResultSchema("merge-conflict-plan", MergeConflictPlanSchema);
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, provider, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, event_offset) VALUES (?, ?, ?, ?, ?, 'starting', 1, ?, ?, 'merge-conflict-planning', ?, ?, ?, ?, ?, ?, ?, 0)").run(executionId, input.taskId, input.companyId, input.workflowId, executionRole, `${input.workflowId}:merge-conflict:${input.priorHead}:${input.targetBaseSha}:${input.capacityRequestId ?? executionId}`, input.planRevision, leadProfile.id, leadProfile.provider, leadProfile.model, leadProfile.reasoningLevel, leadProfile.servicePriority, input.leadSessionRef, startedAt);
    });
    const evidenceLines: string[] = [];
    try {
      const turn = await this.turnRunner.run({ task: { taskId: input.taskId, projectId: input.projectId, projectSlug: context.projectSlug, ...(context.issueKey ? { issueKey: context.issueKey } : {}), worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole, ledger: "agent", executionId, promptKind: "merge-conflict-plan", prompt: this.mergeConflictPlanPrompt(context.title, brief, plan, input, conflict, pinnedCommands), profile: leadProfile, resultSchema: MergeConflictPlanSchema, schemaPath, companyId: input.companyId, workflowId: input.workflowId, revision: input.planRevision, signal: runtime.signal });
      const output = turn.result;
      if (output.disposition === "mechanical") {
        if (output.resolutions.some((resolution) => resolution.number === undefined || !resolution.intendedResult || !resolution.issueInvariant || !resolution.baseInvariant || !resolution.compatibilityConcern) || output.resolutions.some((resolution, index) => resolution.number !== index + 1)) throw new AgentFailure("invalid-merge-conflict-plan", "The Lead conflict plan must number each resolution and state both invariants plus compatibility concerns");
        const plannedFiles = new Set(output.resolutions.map((resolution) => resolution.file));
        const missingFiles = conflict.conflictFiles.filter((file) => !plannedFiles.has(file));
        const extraFiles = output.resolutions.filter((resolution) => !conflict.conflictFiles.includes(resolution.file));
        if (missingFiles.length || extraFiles.length || plannedFiles.size !== output.resolutions.length) throw new AgentFailure("incomplete-merge-conflict-plan", "The Lead plan must cover each conflict file exactly once");
      }
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const planArtifact = await this.artifacts.putArtifact(input.companyId, "merge-conflict-plan", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(output, null, 2), "utf8") });
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_merge_conflict_resolutions (id, task_id, company_id, workflow_id, forward_merge_id, prior_head, target_base_sha, conflict_files_json, plan_artifact_id, plan_evidence_artifact_id, lead_execution_id, lead_session_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?) ON CONFLICT(workflow_id, prior_head, target_base_sha) DO UPDATE SET plan_artifact_id = excluded.plan_artifact_id, plan_evidence_artifact_id = excluded.plan_evidence_artifact_id, lead_execution_id = excluded.lead_execution_id, lead_session_ref = excluded.lead_session_ref, status = 'planned', updated_at = excluded.updated_at").run(planId, input.taskId, input.companyId, input.workflowId, input.forwardMergeId, input.priorHead, input.targetBaseSha, JSON.stringify(conflict.conflictFiles), planArtifact.id, evidence.id, executionId, turn.roleSessionId, now, now);
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = ?, finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(turn.roleSessionId, now, now, evidence.id, executionId);
      });
      return { planId, planArtifactId: planArtifact.id, evidenceArtifactId: evidence.id, leadExecutionId: executionId, leadSessionRef: turn.roleSessionId, summary: output.summary, disposition: output.disposition, ...(output.question ? { question: output.question } : {}), ...(output.choices ? { choices: output.choices } : {}), ...(output.recommendedChoiceId ? { recommendedChoiceId: output.recommendedChoiceId } : {}) };
    } catch (error) {
      const failure = runtime.signal?.aborted ? new AgentFailure("cancelled", "The Codex Lead turn was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("merge-conflict-plan-failed", "Codex Lead merge-conflict planning failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const finalStatus = failure.code === "cancelled" ? "cancelled" : "failed";
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId);
      });
      throw failure;
    }
  }

  private async blockedDeliveryReviewPreflight(input: DeliveryReviewActivityInput, failure: AgentFailure): Promise<DeliveryReviewActivityResult> {
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const attemptId = `review_attempt_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    const code = deliveryBlockCode(failure);
    const summary = safeBlockSummary(code, false, failure.message);
    const references = this.database.authQuery((db) => ({
      task: db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) as { id: string } | undefined,
      developerExecution: db.prepare("SELECT id FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.subject.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string } | undefined,
      deliveryArtifact: db.prepare("SELECT id FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.subject.deliveryArtifactId, input.companyId) as { id: string } | undefined,
      developerEvidence: db.prepare("SELECT id FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.subject.developerEvidenceArtifactId, input.companyId) as { id: string } | undefined,
    }));
    if (!references.task || !references.developerExecution || !references.deliveryArtifact || !references.developerEvidence) throw failure;
    const { developerExecution, deliveryArtifact, developerEvidence } = references;
    const evidence = await this.persistEvidence(input.companyId, executionId, [JSON.stringify({ type: "forge.review-preflight-blocked", code })]);
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, failure_code, failure_summary, evidence_artifact_id) VALUES (?, ?, ?, ?, 'planner', 'blocked', 1, ?, ?, ?, ?, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.subject.leadSessionRef, startedAt, this.now().toISOString(), code, summary, evidence.id);
      db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref, status, correction_attempts, evidence_artifact_id, failure_code, failure_summary, supersedes_review_id, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', 0, ?, ?, ?, ?, ?, ?)").run(attemptId, input.taskId, input.companyId, input.workflowId, input.subject.planRevision, input.subject.targetBaseSha, input.subject.subjectCommit, input.subject.subjectTree, developerExecution.id, deliveryArtifact.id, developerEvidence.id, executionId, input.subject.leadSessionRef, input.subject.developerSessionRef, evidence.id, code, summary, input.supersedesReviewId, startedAt, this.now().toISOString());
    });
    return DeliveryReviewActivityResultSchema.parse({ outcome: "blocked", attemptId, code, summary, evidenceArtifactId: evidence.id, executionId, sessionRef: input.subject.leadSessionRef, correctionAttempts: 0, subject: input.subject });
  }

  async planCiRepair(rawInput: CiRepairPlanActivityInput): Promise<CiRepairPlanActivityResult> {
    const input = rawInput;
    const executionRole = input.executionRole ?? "planner";
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, p.name AS projectSlug,
      CASE WHEN co.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN co.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey,
      original.output_revision AS planRevision, t.role_agents_json AS roleProfiles, a.outcome, a.observed_head_sha AS observedHeadSha, a.evidence_artifact_id AS evidenceArtifactId
      FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_companies co ON co.id = t.company_id
      JOIN forge_ci_runs c ON c.id = ? AND c.task_id = t.id AND c.company_id = t.company_id AND c.superseded_at IS NULL
      JOIN forge_ci_attempts a ON a.id = ? AND a.run_id = c.id AND a.observed_head_sha = c.expected_head_sha
      JOIN forge_agent_executions original ON original.task_id = t.id AND original.company_id = t.company_id
        AND original.workflow_id = t.workflow_id AND original.output_artifact_id IS NOT NULL AND original.session_ref = ?
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_id = ? AND t.project_revision_id = ?
        AND c.expected_head_sha = ?
      ORDER BY original.finished_at DESC, original.id DESC LIMIT 1`)
      .get(input.ciRunId, input.ciAttemptId, input.leadSessionRef, input.taskId, input.companyId, input.workflowId, input.projectId, input.projectRevisionId, input.failedHeadSha) as { title: string; projectSlug: string; issueKey: string | null; planRevision: number | null; roleProfiles: string; outcome: string; observedHeadSha: string; evidenceArtifactId: string | null } | undefined);
    if (!context || context.outcome !== "failed" || context.evidenceArtifactId !== input.evidenceArtifactId) throw new AgentFailure("ci-repair-attempt-mismatch", "CI repair planning input does not identify the exact failed attempt");
    const failedChecks = this.database.authQuery((db) => db.prepare("SELECT name, conclusion, summary FROM forge_ci_attempt_checks WHERE attempt_id = ? AND selected_for_evaluation = 1 AND conclusion = 'failure' ORDER BY name").all(input.ciAttemptId) as Array<{ name: string; conclusion: string; summary: string | null }>);
    if (!failedChecks.length) throw new AgentFailure("ci-repair-not-authorized", "Only exact-head failed checks can enter CI repair planning");
    const existingPlan = this.database.authQuery((db) => db.prepare("SELECT id, plan_artifact_id AS planArtifactId, evidence_artifact_id AS evidenceArtifactId, lead_execution_id AS leadExecutionId, lead_session_ref AS leadSessionRef, summary FROM forge_ci_repair_plans WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND ci_run_id = ? AND ci_attempt_id = ? AND status = 'planned' ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.ciRunId, input.ciAttemptId) as { id: string; planArtifactId: string; evidenceArtifactId: string; leadExecutionId: string; leadSessionRef: string; summary: string } | undefined);
    if (existingPlan) return { planId: existingPlan.id, planArtifactId: existingPlan.planArtifactId, evidenceArtifactId: existingPlan.evidenceArtifactId, leadExecutionId: existingPlan.leadExecutionId, leadSessionRef: existingPlan.leadSessionRef, summary: existingPlan.summary };
    let revisionConfig: { requiredChecks?: unknown; verificationCommand?: unknown; repositoryPath: string; baseBranch: string };
    try {
      revisionConfig = loadTaskConfiguration(this.database.authQuery((db) => db), this.artifacts, input);
    } catch {
      throw new AgentFailure("invalid-project-revision", "The accepted project revision is malformed");
    }
    const requiredChecks = input.requiredChecks.length ? input.requiredChecks : Array.isArray(revisionConfig.requiredChecks) ? revisionConfig.requiredChecks.filter((check): check is string => typeof check === "string") : [];
    const localVerification = input.localVerification.length ? input.localVerification : typeof revisionConfig.verificationCommand === "string" ? [revisionConfig.verificationCommand] : [];
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(revisionConfig.repositoryPath));
    await this.worktrees.syncBase(repositoryPath, revisionConfig.baseBranch);
    const profile = await this.resolveTurnProfile(input.roleProfiles?.[executionRole] ?? input.roleProfiles?.planner, input.leadSessionRef, "Integrator", executionRole);
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, profile_id, provider, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at) VALUES (?, ?, ?, ?, ?, 'starting', 1, ?, ?, ?, ?, ?, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, executionRole, profile.id, profile.provider, profile.model, profile.reasoningLevel, profile.servicePriority, input.leadSessionRef, startedAt));
    // Actions check-run summaries are empty; the failing job log tail recorded with the CI evidence is the real signal.
    const evidenceRow = this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.evidenceArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined);
    const failedLogs = evidenceRow ? await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: evidenceRow.storagePath, sha256: evidenceRow.sha256 }).then((bytes) => (jsonRequired(bytes.toString("utf8")) as { failedCheckLogs?: Array<{ name: string; runId: string; log: string }> }).failedCheckLogs ?? []).catch(() => []) : [];
    const prompt = this.ciRepairPrompt(context.title, { ...input, requiredChecks, localVerification }, failedChecks, failedLogs);
    let plan: import("./engine/issue-contracts.js").CiRepairPlan;
    let leadSessionRef = input.leadSessionRef;
    try {
      const schemaPath = await this.ensureResultSchema("ci-repair-plan", CiRepairPlanSchema);
      const result = await this.turnRunner.run({ task: { taskId: input.taskId, projectId: input.projectId, projectSlug: context.projectSlug, ...(context.issueKey ? { issueKey: context.issueKey } : {}), worktreePath: repositoryPath, runtimeRoot: this.config.runtimeRoot }, executionRole, ledger: "agent", executionId, promptKind: "ci-repair-plan", prompt, profile, resultSchema: CiRepairPlanSchema, schemaPath, companyId: input.companyId, workflowId: input.workflowId, revision: context.planRevision ?? 0 });
      plan = result.result;
      leadSessionRef = result.roleSessionId;
      const expectedFailedNames = new Set(failedChecks.map((failed) => failed.name));
      if (plan.ciRunId !== input.ciRunId || plan.ciAttemptId !== input.ciAttemptId || plan.failedHeadSha.toLowerCase() !== input.failedHeadSha.toLowerCase() || plan.failedChecks.length !== expectedFailedNames.size || new Set(plan.failedChecks.map((check) => check.name)).size !== expectedFailedNames.size || plan.failedChecks.some((check) => !expectedFailedNames.has(check.name) || check.evidenceArtifactId !== input.evidenceArtifactId)) throw new AgentFailure("ci-repair-plan-identity-mismatch", "CI repair plan is not bounded to the exact failed attempt");
      const validatedPlan = plan;
      const evidence = await this.persistEvidence(input.companyId, executionId, []);
      const planArtifact = await this.artifacts.putArtifact(input.companyId, "ci-repair-plan", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(validatedPlan, null, 2), "utf8") });
      const planId = `ci_plan_${randomBytes(12).toString("hex")}`;
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_ci_repair_plans (id, task_id, company_id, workflow_id, ci_run_id, ci_attempt_id, failed_head_sha, lead_execution_id, lead_session_ref, plan_artifact_id, evidence_artifact_id, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)").run(planId, input.taskId, input.companyId, input.workflowId, input.ciRunId, input.ciAttemptId, input.failedHeadSha, executionId, leadSessionRef, planArtifact.id, evidence.id, validatedPlan.rootCause, this.now().toISOString(), this.now().toISOString());
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = ?, finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(leadSessionRef, this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
      });
      return { planId, planArtifactId: planArtifact.id, evidenceArtifactId: evidence.id, leadExecutionId: executionId, leadSessionRef, summary: validatedPlan.rootCause, disposition: validatedPlan.disposition };
    } catch (error) {
      const reason = this.repairTurnFailure(error, "ci");
      const evidence = await this.persistEvidence(input.companyId, executionId, []);
      this.database.authTransaction((db) => { db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), reason.code, reason.message, evidence.id, executionId); });
      throw reason;
    }
  }

  async reviewDelivery(rawInput: DeliveryReviewActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<DeliveryReviewActivityResult> {
    const input = DeliveryReviewActivityInputSchema.parse(rawInput);
    let subject = input.subject;
    const targetBaseSha = subject.targetBaseSha;
    let subjectCommit = subject.subjectCommit;
    let subjectTree = subject.subjectTree;
    const leadSessionRef = subject.leadSessionRef;
    const isFinalReview = input.reviewKind === "final";
    const requiresFreshVerificationFailureReview = !isFinalReview && input.deliverySummary?.startsWith(PROJECT_VERIFICATION_FAILURE_PREFIX) === true;
    if (isFinalReview && (!input.releaseId || !input.ciRunId || !input.deliveryReviewId)) throw new AgentFailure("scoped-input-missing", "Final review requires the exact release, delivery review, and CI run");
    const existingDelivery: { id: string; leadExecutionId: string; sessionRef: string; opinionArtifactId: string; evidenceArtifactId: string; outcome: "approved" | "blocking"; summary: string; supersedesReviewId: string | null } | undefined = !isFinalReview && !requiresFreshVerificationFailureReview
      ? this.database.authQuery((db) => db.prepare("SELECT id, lead_execution_id AS leadExecutionId, session_ref AS sessionRef, opinion_artifact_id AS opinionArtifactId, evidence_artifact_id AS evidenceArtifactId, outcome, summary, supersedes_review_id AS supersedesReviewId FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND subject_commit = ? LIMIT 1").get(input.taskId, input.companyId, input.workflowId, subjectCommit) as { id: string; leadExecutionId: string; sessionRef: string; opinionArtifactId: string; evidenceArtifactId: string; outcome: "approved" | "blocking"; summary: string; supersedesReviewId: string | null } | undefined)
      : undefined;
    if (existingDelivery) {
      const findings = this.database.authQuery((db) => db.prepare("SELECT id AS findingId, severity, rationale, evidence_ref AS evidenceRef, disposition, repair_instruction AS repairInstruction FROM forge_delivery_findings WHERE review_id = ? ORDER BY id").all(existingDelivery.id) as DeliveryReview["findings"]);
      return DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId: `review_attempt_existing_${existingDelivery.id}`, correctionAttempts: 0, subject, review: { reviewId: existingDelivery.id, leadExecutionId: existingDelivery.leadExecutionId, leadSessionRef: existingDelivery.sessionRef, opinionArtifactId: existingDelivery.opinionArtifactId, evidenceArtifactId: existingDelivery.evidenceArtifactId, opinion: existingDelivery.outcome, summary: existingDelivery.summary, repairPlan: existingDelivery.outcome === "blocking" ? "Existing blocking review requires repair." : null, findings, supersedesReviewId: existingDelivery.supersedesReviewId } });
    }
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, t.description, p.name AS projectSlug,
      CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey,
      b.storage_path AS legacyBriefStoragePath, b.sha256 AS legacyBriefSha256,
      pa.storage_path AS planStoragePath, pa.sha256 AS planSha256,
      da.storage_path AS deliveryStoragePath, da.sha256 AS deliverySha256,
      ea.storage_path AS evidenceStoragePath, ea.sha256 AS evidenceSha256,
      delivery_de.id AS developerExecutionId, delivery_de.session_ref AS developerSessionRef,
      delivery_de.delivery_artifact_id AS deliveryArtifactId, delivery_de.evidence_artifact_id AS developerEvidenceArtifactId,
      delivery_de.result_commit AS developerResultCommit, delivery_de.result_tree AS developerResultTree,
      fm.prior_head AS forwardMergePriorHead, fm.current_base_sha AS forwardMergeTargetBaseSha
      FROM forge_tasks t
      JOIN forge_projects p ON p.id = t.project_id
      JOIN forge_companies c ON c.id = t.company_id
      LEFT JOIN forge_artifacts b ON b.id = t.brief_artifact_id AND b.kind = 'task-brief'
      JOIN forge_developer_executions delivery_de ON delivery_de.id = (SELECT latest.id FROM forge_developer_executions latest
        WHERE latest.task_id = t.id AND latest.company_id = t.company_id
          AND latest.delivery_artifact_id IS NOT NULL AND latest.evidence_artifact_id IS NOT NULL
        ORDER BY latest.finished_at DESC, latest.started_at DESC, latest.id DESC LIMIT 1)
      JOIN forge_artifacts pa ON pa.id = COALESCE(
        (SELECT requested.output_artifact_id FROM forge_agent_executions requested
          WHERE requested.task_id = t.id AND requested.company_id = t.company_id AND requested.output_artifact_id = ? LIMIT 1),
        (SELECT latest.output_artifact_id FROM forge_agent_executions latest
          WHERE latest.task_id = t.id AND latest.company_id = t.company_id AND latest.output_kind = 'plan' AND latest.output_revision = delivery_de.plan_revision
          ORDER BY latest.finished_at DESC, latest.id DESC LIMIT 1))
      JOIN forge_artifacts da ON da.id = delivery_de.delivery_artifact_id
      JOIN forge_artifacts ea ON ea.id = delivery_de.evidence_artifact_id
      LEFT JOIN forge_forward_merges fm ON fm.id = (SELECT latest.id FROM forge_forward_merges latest
        WHERE latest.task_id = t.id AND latest.company_id = t.company_id AND latest.status = 'merged'
        ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.id DESC LIMIT 1)
      WHERE t.id = ? AND t.company_id = ?`).get(
      input.leadOutputArtifactId,
      input.taskId,
      input.companyId,
    ) as (DeliveryReviewContext & { projectSlug: string; issueKey: string | null }) | undefined);
    if (context && (context.developerExecutionId !== subject.developerExecutionId || context.deliveryArtifactId !== subject.deliveryArtifactId || context.developerEvidenceArtifactId !== subject.developerEvidenceArtifactId)) {
      subject = { ...subject, developerExecutionId: context.developerExecutionId, deliveryArtifactId: context.deliveryArtifactId, developerEvidenceArtifactId: context.developerEvidenceArtifactId, developerSessionRef: context.developerSessionRef ?? subject.developerSessionRef };
      input.subject = subject;
    }
    if (!context) {
      const failure = new AgentFailure("scoped-input-missing", "The current delivery artifact is unavailable");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    let repositoryPath: string;
    let worktreePath: string;
    try {
      repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(loadTaskConfiguration(this.database.authQuery((db) => db), this.artifacts, input).repositoryPath));
      worktreePath = await taskScopedPath(this.config.worktreeRoot, input.worktreePath);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("unsafe-working-directory", "The delivery worktree is outside the configured scope");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    const finalContext = isFinalReview ? this.database.authQuery((db) => db.prepare("SELECT r.id, r.base_sha AS baseSha, r.head_sha AS headSha, r.head_tree AS headTree, c.status FROM forge_releases r JOIN forge_ci_runs c ON c.id = ? AND c.release_id = r.id WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ? AND r.superseded_at IS NULL AND c.superseded_at IS NULL AND c.policy_hash IS NOT NULL AND EXISTS (SELECT 1 FROM forge_ci_attempts ca WHERE ca.run_id = c.id AND ca.attempt_number = (SELECT MAX(latest.attempt_number) FROM forge_ci_attempts latest WHERE latest.run_id = c.id) AND ca.outcome = 'passed' AND ca.observed_head_sha = r.head_sha)").get(input.ciRunId, input.releaseId, input.taskId, input.companyId, input.workflowId) as { id: string; baseSha: string; headSha: string; headTree: string; status: string } | undefined) : undefined;
    if (isFinalReview && (!finalContext || finalContext.status !== "passed" || finalContext.headSha.toLowerCase() !== subjectCommit.toLowerCase() || finalContext.headTree.toLowerCase() !== subjectTree.toLowerCase() || finalContext.baseSha.toLowerCase() !== targetBaseSha.toLowerCase())) {
      throw new AgentFailure("ci-not-authoritative", "Final review requires passed CI for the exact reviewed release head");
    }
    if (isFinalReview) {
      const approvedDelivery = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_delivery_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND outcome = 'approved'").get(input.deliveryReviewId, input.taskId, input.companyId, input.workflowId) as { id: string } | undefined);
      if (!approvedDelivery) throw new AgentFailure("delivery-review-not-authoritative", "Final review requires an approved delivery review for this task");
    }
    const existingFinal = isFinalReview ? this.database.authQuery((db) => db.prepare("SELECT id, lead_execution_id AS leadExecutionId, session_ref AS sessionRef, opinion_artifact_id AS opinionArtifactId, evidence_artifact_id AS evidenceArtifactId, outcome, summary FROM forge_final_reviews WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND release_id = ? AND ci_run_id = ? AND delivery_review_id = ? AND developer_execution_id = ? AND subject_commit = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.releaseId, input.ciRunId, input.deliveryReviewId, subject.developerExecutionId, subjectCommit) as { id: string; leadExecutionId: string; sessionRef: string; opinionArtifactId: string; evidenceArtifactId: string; outcome: "approved" | "blocking"; summary: string } | undefined) : undefined;
    if (existingFinal) {
      const findings = this.database.authQuery((db) => db.prepare("SELECT id AS findingId, severity, rationale, evidence_ref AS evidenceRef, disposition, repair_instruction AS repairInstruction FROM forge_final_review_findings WHERE review_id = ? ORDER BY id").all(existingFinal.id) as DeliveryReview["findings"]);
      return DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId: `review_attempt_existing_${existingFinal.id}`, correctionAttempts: 0, subject, review: { reviewId: existingFinal.id, leadExecutionId: existingFinal.leadExecutionId, leadSessionRef: existingFinal.sessionRef, opinionArtifactId: existingFinal.opinionArtifactId, evidenceArtifactId: existingFinal.evidenceArtifactId, opinion: existingFinal.outcome, summary: existingFinal.summary, repairPlan: null, findings, supersedesReviewId: input.supersedesReviewId } });
    }
    const brief = context.description ?? (() => {
      if (!context.legacyBriefStoragePath || !context.legacyBriefSha256) throw new AgentFailure("scoped-input-missing", "Task description is unavailable");
      const migrated = this.artifacts.getArtifactSync({ companyId: input.companyId, storagePath: context.legacyBriefStoragePath, sha256: context.legacyBriefSha256 }).toString("utf8");
      this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET description = ? WHERE id = ? AND company_id = ? AND description IS NULL").run(migrated, input.taskId, input.companyId));
      return migrated;
    })();
    let plan: string;
    let delivery: string;
    let developerEvidence: string;
    let gitEvidence: DeliveryGitEvidence;
    try {
      [plan, delivery, developerEvidence, gitEvidence] = await Promise.all([
        this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
        this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.deliveryStoragePath, sha256: context.deliverySha256 }).then((bytes) => bytes.toString("utf8")),
        this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.evidenceStoragePath, sha256: context.evidenceSha256 }).then((bytes) => bytes.toString("utf8")),
        this.readDeliveryGitEvidence(worktreePath, targetBaseSha, subjectCommit, subjectTree, repositoryPath),
      ]);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("delivery-revision-changed", "The exact Developer delivery evidence could not be verified");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    if (!matchesDeliverySubject(gitEvidence, input.branchName, subjectCommit, subjectTree)) {
      const liveTurn = await this.isTaskTurnLive(input.taskId);
      if (liveTurn.live) {
        const failure = new AgentFailure("delivery-revision-changed", "The Developer turn is still live. Wait for it to finish before reviewing the delivery.");
        if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
        throw failure;
      }
      await this.wait(250);
      try {
        gitEvidence = await this.readDeliveryGitEvidence(worktreePath, targetBaseSha, subjectCommit, subjectTree, repositoryPath);
      } catch (error) {
        const failure = error instanceof AgentFailure ? error : new AgentFailure("delivery-revision-changed", "The exact Developer delivery evidence could not be verified");
        if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
        throw failure;
      }
    }
    if (!matchesDeliverySubject(gitEvidence, input.branchName, subjectCommit, subjectTree)) {
      const failure = new AgentFailure("delivery-revision-changed", "The Developer worktree does not match the reviewed delivery");
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    if (!isFinalReview && input.supersedesReviewId) {
      const superseded = this.database.authQuery((db) => db.prepare(`
        SELECT r.id,
          EXISTS (
            SELECT 1 FROM forge_delivery_repairs p
            WHERE p.review_id = r.id AND p.task_id = r.task_id AND p.company_id = r.company_id AND p.workflow_id = r.workflow_id
              AND p.result_commit = ? AND p.result_tree = ?
              AND p.developer_execution_id = ? AND p.delivery_artifact_id = ? AND p.evidence_artifact_id = ?
          ) AS repaired
        FROM forge_delivery_reviews r
        WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.workflow_id = ?
          AND r.plan_revision = ? AND r.base_sha = ? AND r.outcome = 'blocking'
          AND NOT EXISTS (SELECT 1 FROM forge_delivery_reviews successor WHERE successor.supersedes_review_id = r.id)
      `).get(subjectCommit, subjectTree, subject.developerExecutionId, subject.deliveryArtifactId, subject.developerEvidenceArtifactId, input.supersedesReviewId, input.taskId, input.companyId, input.workflowId, subject.planRevision, targetBaseSha) as { id: string; repaired: number } | undefined);
      if (!superseded || superseded.repaired !== 1) {
        const failure = new AgentFailure("delivery-revision-changed", "The fresh review is not linked to the immediately repaired blocking review subject");
        if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
        throw failure;
      }
    }
    const reviewRole: "planner" | "reviewer" = isFinalReview && input.roleProfiles.reviewer ? "reviewer" : "planner";
    const visualEvidenceMissing = !isFinalReview && input.visualEvidence === "required" && !(await (async () => {
      try {
        const report = jsonRequired(delivery) as { visualEvidence?: { manifestArtifactId?: unknown } };
        if (typeof report.visualEvidence?.manifestArtifactId !== "string") return false;
        return await this.browserProof.verifyDurableReference({ taskId: input.taskId, companyId: input.companyId, developerExecutionId: subject.developerExecutionId, resultCommit: subjectCommit, resultTree: subjectTree, manifestArtifactId: report.visualEvidence.manifestArtifactId });
      } catch { return false; }
    })());
    let leadProfile: Awaited<ReturnType<AgentService["resolveTurnProfile"]>>;
    try {
      leadProfile = await this.resolveTurnProfile(input.roleProfiles[reviewRole], leadSessionRef, reviewRole === "reviewer" ? "Final reviewer" : "Lead review", reviewRole);
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("invalid-session-reference", `Lead session reference is invalid: ${error instanceof Error ? error.message : String(error)}`);
      if (!isFinalReview) return this.blockedDeliveryReviewPreflight(input, failure);
      throw failure;
    }
    const schemaPath = await this.ensureDeliveryReviewSchema();
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    const attemptId = `review_attempt_${randomBytes(12).toString("hex")}`;
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, provider, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, event_offset) VALUES (?, ?, ?, ?, ?, 'starting', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)").run(executionId, input.taskId, input.companyId, input.workflowId, reviewRole, `${input.workflowId}:delivery-review:${subjectCommit}:${attemptId}`, input.planRevision, isFinalReview ? "final-delivery-review" : "delivery-review", leadProfile.id, leadProfile.provider, leadProfile.model, leadProfile.reasoningLevel, leadProfile.servicePriority, leadSessionRef, startedAt);
      if (!isFinalReview) db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref, status, correction_attempts, supersedes_review_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)").run(attemptId, input.taskId, input.companyId, input.workflowId, subject.planRevision, targetBaseSha, subjectCommit, subjectTree, subject.developerExecutionId, subject.deliveryArtifactId, subject.developerEvidenceArtifactId, executionId, leadSessionRef, context.developerSessionRef ?? subject.developerSessionRef, input.supersedesReviewId, startedAt);
    });
    const evidenceLines: string[] = [];
    let correctionAttempts = 0;
    try {
      const coverage = !isFinalReview && input.supersedesReviewId
        ? (this.database.authQuery((db) => db.prepare("SELECT coverage_json AS coverageJson FROM forge_delivery_repairs WHERE review_id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND result_commit = ? ORDER BY finished_at DESC LIMIT 1").get(input.supersedesReviewId, input.taskId, input.companyId, input.workflowId, subjectCommit)) as { coverageJson: string | null } | undefined)
        : undefined;
      const initialPrompt = this.deliveryReviewPrompt(input, context.title, brief, plan, delivery, developerEvidence, gitEvidence, context.forwardMergePriorHead && context.forwardMergeTargetBaseSha ? { priorHead: context.forwardMergePriorHead, targetBaseSha: context.forwardMergeTargetBaseSha } : null, Boolean(context.developerSessionRef), repairCoveragePrompt(coverage?.coverageJson ?? null)) + (isFinalReview ? `\n\n${this.renderTaskPrompt(input, "lead/integrator.md", { release_id: String(input.releaseId), ci_run_id: String(input.ciRunId), status: String(finalContext?.status), head_sha: String(finalContext?.headSha), head_tree: String(finalContext?.headTree) })}` : "");
      const runReviewTurn = async (): Promise<{ review: DeliveryReview; sessionRef: string }> => {
        evidenceLines.push(JSON.stringify({ type: "forge.review-turn-start", turn: 1 }));
        const output = await this.turnRunner.run({ task: { taskId: input.taskId, projectId: input.projectId, projectSlug: context.projectSlug, ...(context.issueKey ? { issueKey: context.issueKey } : {}), worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: reviewRole, ledger: "agent", executionId, promptKind: isFinalReview ? "final-review" : "delivery-review", prompt: initialPrompt, profile: leadProfile, resultSchema: DeliveryReviewSchema, schemaPath, companyId: input.companyId, workflowId: input.workflowId, revision: input.planRevision, signal: runtime.signal });
        evidenceLines.push(JSON.stringify({ type: "forge.review-turn-end", turn: 1 }));
        return { review: output.result, sessionRef: output.roleSessionId };
      };
      const reviewed = await runReviewTurn();
      let review = reviewed.review;
      const reviewSessionRef = reviewed.sessionRef;
      if (visualEvidenceMissing) {
        review = DeliveryReviewSchema.parse({
          ...review,
          findings: [...review.findings, { findingId: `visual_evidence_${randomBytes(12).toString("hex")}`, severity: "advisory", rationale: "The task requires visual evidence, but the Developer delivery has no valid durable browser-proof manifest.", evidenceRef: "developer-delivery:visualEvidence", disposition: "open", repairInstruction: "Capture relevant browser proof under .forge-proof/ so Forge can ingest and attach it to the delivery." }],
        });
      }
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const opinion = await this.artifacts.putArtifact(input.companyId, "delivery-review", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(review, null, 2), "utf8") });
      // One review row per subject commit (UNIQUE workflow_id, subject_commit). A repair that changed nothing yields the
      // same commit as the review it answers, so the fresh review refreshes that row — and must not supersede itself.
      const priorReview = isFinalReview ? undefined : this.database.authQuery((db) => db.prepare("SELECT id FROM forge_delivery_reviews WHERE workflow_id = ? AND subject_commit = ?").get(input.workflowId, subjectCommit) as { id: string } | undefined);
      const supersedesReviewId = priorReview && priorReview.id === input.supersedesReviewId ? null : input.supersedesReviewId ?? null;
      const reviewId = priorReview?.id ?? `delivery_review_${randomBytes(12).toString("hex")}`;
      this.database.authTransaction((db) => {
        if (isFinalReview) {
          db.prepare("INSERT INTO forge_final_reviews (id, task_id, company_id, workflow_id, release_id, ci_run_id, delivery_review_id, developer_execution_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.releaseId, input.ciRunId, input.deliveryReviewId, subject.developerExecutionId, subject.planRevision, targetBaseSha, subjectCommit, subjectTree, executionId, reviewSessionRef, review.outcome, review.summary, opinion.id, evidence.id, this.now().toISOString());
          for (const finding of review.findings) db.prepare("INSERT INTO forge_final_review_findings (id, review_id, task_id, company_id, severity, rationale, evidence_ref, disposition, repair_instruction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(finding.findingId, reviewId, input.taskId, input.companyId, finding.severity, finding.rationale, finding.evidenceRef, finding.disposition, finding.repairInstruction);
        } else {
          if (priorReview) {
            db.prepare("UPDATE forge_delivery_reviews SET lead_execution_id = ?, session_ref = ?, outcome = ?, summary = ?, opinion_artifact_id = ?, evidence_artifact_id = ?, repair_cycle = 0, supersedes_review_id = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").run(executionId, reviewSessionRef, review.outcome, review.summary, opinion.id, evidence.id, supersedesReviewId, reviewId, input.taskId, input.companyId, input.workflowId);
            db.prepare("DELETE FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ?").run(reviewId, input.taskId, input.companyId);
          } else db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, supersedes_review_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.planRevision, targetBaseSha, subjectCommit, subjectTree, executionId, reviewSessionRef, review.outcome, review.summary, opinion.id, evidence.id, input.supersedesReviewId, this.now().toISOString());
          for (const finding of review.findings) db.prepare("INSERT INTO forge_delivery_findings (id, review_id, task_id, company_id, severity, rationale, evidence_ref, disposition, repair_instruction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`delivery_finding_${reviewId}_${finding.findingId}`, reviewId, input.taskId, input.companyId, finding.severity, finding.rationale, finding.evidenceRef, finding.disposition, finding.repairInstruction, this.now().toISOString());
          if (review.outcome === "approved") db.prepare("UPDATE forge_developer_executions SET status = 'completed', failure_code = NULL, failure_summary = NULL WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'blocked' AND dirty_state = 'clean' AND result_commit = ?").run(subject.developerExecutionId, input.taskId, input.companyId, input.workflowId, subjectCommit);
        }
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = ?, finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(reviewSessionRef, this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
        if (!isFinalReview) db.prepare("UPDATE forge_delivery_review_attempts SET status = 'completed', correction_attempts = ?, evidence_artifact_id = ?, completed_review_id = ?, finished_at = ? WHERE id = ?").run(correctionAttempts, evidence.id, reviewId, this.now().toISOString(), attemptId);
      });
      const completed = DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId, correctionAttempts, subject: { ...subject, developerSessionRef: context.developerSessionRef ?? subject.developerSessionRef }, review: { reviewId, leadExecutionId: executionId, leadSessionRef: reviewSessionRef, opinionArtifactId: opinion.id, evidenceArtifactId: evidence.id, opinion: review.outcome, summary: review.summary, findings: review.findings, supersedesReviewId: input.supersedesReviewId } });
      return completed;
    } catch (error) {
      const cancelled = runtime.signal?.aborted === true;
      const expectedFailure = error instanceof AgentFailure && !cancelled;
      const failure = cancelled ? new AgentFailure("cancelled", "The Codex Lead turn was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("delivery-review-failed", "The Codex delivery review failed");
      evidenceLines.push(JSON.stringify({ type: "forge.review-turn-failed", code: failure.code, message: redact(error instanceof Error ? error.message : String(error)) }));
      const evidence = await this.persistEvidence(input.companyId, executionId, evidenceLines);
      const code = failure.code === "cancelled" ? "cancelled" : failure.code === "correction-exhausted" ? "correction-exhausted" : deliveryBlockCode(failure);
      const summary = code === "cancelled" ? failure.message : safeBlockSummary(code, code === "correction-exhausted", failure.message);
      const finalStatus = failure.code === "cancelled" ? "cancelled" : isFinalReview || !expectedFailure ? "failed" : "blocked";
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), code, summary, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId);
        if (!isFinalReview) db.prepare("UPDATE forge_delivery_review_attempts SET status = ?, correction_attempts = ?, evidence_artifact_id = ?, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ?").run(finalStatus === "cancelled" ? "failed" : expectedFailure ? "blocked" : "failed", correctionAttempts, evidence.id, code, summary, this.now().toISOString(), attemptId);
      });
      if (!expectedFailure || isFinalReview) throw failure;
      if (code === "cancelled") throw failure;
      return DeliveryReviewActivityResultSchema.parse({ outcome: "blocked", attemptId, code, summary, evidenceArtifactId: evidence.id, executionId, sessionRef: leadSessionRef, correctionAttempts, subject: { ...subject, developerSessionRef: context.developerSessionRef ?? subject.developerSessionRef } });
    }
  }

  async arbitrateReview(rawInput: ReviewArbitrationActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<ReviewArbitrationActivityResult> {
    const input = ReviewArbitrationActivityInputSchema.parse(rawInput);
    const task = this.database.authQuery((db) => db.prepare("SELECT t.description, p.name AS projectSlug FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id WHERE t.id = ? AND t.company_id = ? AND t.project_id = ?").get(input.taskId, input.companyId, input.projectId) as { description: string | null; projectSlug: string } | undefined);
    if (!task) throw new AgentFailure("scoped-input-missing", "Task details are unavailable");
    const artifact = this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(input.leadOutputArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined);
    if (!artifact) throw new AgentFailure("scoped-input-missing", "The approved plan is unavailable");
    const plan = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: artifact.storagePath, sha256: artifact.sha256 })).toString("utf8");
    const reviews = this.database.authQuery((db) => db.prepare("SELECT summary, outcome, repair_cycle AS repairCycle FROM forge_delivery_reviews WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at, id").all(input.taskId, input.companyId, input.workflowId));
    const repairs = this.database.authQuery((db) => db.prepare("SELECT summary, status, coverage_json AS coverageJson FROM forge_delivery_repairs WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY created_at, id").all(input.taskId, input.companyId, input.workflowId)) as Array<{ summary: string; status: string; coverageJson: string | null }>;
    const profile = await this.resolveTurnProfile(undefined, input.leadSessionRef, "Review arbitration");
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const objections = repairs.flatMap((repair) => {
      const parsed = typeof repair.coverageJson === "string" ? json(repair.coverageJson, {}) as { objections?: unknown[] } : {};
      return Array.isArray(parsed.objections) ? parsed.objections : [];
    });
    const coverage = repairs.flatMap((repair) => {
      const parsed = typeof repair.coverageJson === "string" ? json(repair.coverageJson, {}) as { coverage?: unknown[] } : {};
      return Array.isArray(parsed.coverage) ? parsed.coverage : [];
    });
    const prompt = this.renderTaskPrompt(input, "lead/review-arbitration.md", { brief: task.description ?? "", plan: promptExcerpt(plan, 24_000), reviews: JSON.stringify(reviews), repairs: JSON.stringify(repairs), objections: JSON.stringify(objections), repair_coverage: JSON.stringify(coverage), diff: "The current delivery diff is available in the worktree.", repair_exhausted: String(input.repairExhausted), refused_decision: input.refusedDecision ? "Forge refused repair because its repair budget is spent. Choose ask, accept, or cancel." : "" });
    const output = await this.turnRunner.run({ task: { taskId: input.taskId, projectId: input.projectId, projectSlug: task.projectSlug, worktreePath: input.worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "planner", ledger: "agent", executionId, promptKind: "review-arbitration", prompt, profile, resultSchema: ReviewArbitrationSchema, schemaPath: await this.ensureResultSchema("review-arbitration", ReviewArbitrationSchema), companyId: input.companyId, workflowId: input.workflowId, revision: 0, signal: runtime.signal });
    const arbitration = ReviewArbitrationSchema.parse(output.result);
    if (input.repairExhausted && arbitration.decision === "repair") throw new AgentFailure("invalid-output-schema", "The Planner requested a repair after the repair budget was spent", { nonRetryable: true });
    const resultArtifact = await this.artifacts.putArtifact(input.companyId, "lead-output", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(arbitration, null, 2), "utf8") });
    const evidenceArtifact = await this.persistEvidence(input.companyId, executionId, [JSON.stringify({ type: "forge.review-arbitration" })]);
    return ReviewArbitrationActivityResultSchema.parse({ arbitration, leadExecutionId: executionId, leadSessionRef: output.roleSessionId, outputArtifactId: resultArtifact.id, evidenceArtifactId: evidenceArtifact.id });
  }

  async runSupplementalReview(rawInput: SupplementalReviewActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<SupplementalReviewResult> {
    const input = rawInput;
    const profile = await this.resolveTurnProfile(input.roleProfiles.reviewer, undefined, "Supplemental reviewer");
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, t.description, p.name AS projectSlug,
      CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey,
      b.storage_path AS brief_storage_path, b.sha256 AS brief_sha256, oa.storage_path AS output_storage_path, oa.sha256 AS output_sha256, e.storage_path AS evidence_storage_path, e.sha256 AS evidence_sha256
      FROM forge_tasks t
      JOIN forge_projects p ON p.id = t.project_id
      JOIN forge_companies c ON c.id = t.company_id
      LEFT JOIN forge_artifacts b ON b.id = t.brief_artifact_id AND b.kind = 'task-brief'
      JOIN forge_agent_executions io ON io.task_id = t.id AND io.output_artifact_id = ?
      JOIN forge_artifacts oa ON oa.id = io.output_artifact_id JOIN forge_artifacts e ON e.id = io.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.project_revision_id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId, input.projectRevisionId) as { title: string; description: string | null; projectSlug: string; issueKey: string | null; brief_storage_path: string | null; brief_sha256: string | null; output_storage_path: string; output_sha256: string; evidence_storage_path: string; evidence_sha256: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Supplemental review evidence is unavailable");
    const reviewerProfile = profile;
    const configuration = loadTaskConfiguration(this.database.authQuery((db) => db), this.artifacts, input);
    const normalizedJson = JSON.stringify(configuration);
    const worktreePath = await this.planningWorktree(input, configuration, context.title);
    const brief = context.description ?? (() => {
      if (!context.brief_storage_path || !context.brief_sha256) throw new AgentFailure("scoped-input-missing", "Task description is unavailable");
      const migrated = this.artifacts.getArtifactSync({ companyId: input.companyId, storagePath: context.brief_storage_path, sha256: context.brief_sha256 }).toString("utf8");
      this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET description = ? WHERE id = ? AND company_id = ? AND description IS NULL").run(migrated, input.taskId, input.companyId));
      return migrated;
    })();
    const draft = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.output_storage_path, sha256: context.output_sha256 })).toString("utf8");
    const instructions = await this.repositoryEvidence(worktreePath);
    const images = this.database.authQuery((db) => {
      if (!input.imageArtifactIds.length) return [] as ImageRow[];
      const placeholders = input.imageArtifactIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, storage_path, sha256, filename, mime_type FROM forge_artifacts WHERE company_id = ? AND kind = 'task-image' AND id IN (${placeholders})`).all(input.companyId, ...input.imageArtifactIds) as ImageRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return input.imageArtifactIds.flatMap((imageId) => { const row = byId.get(imageId); return row ? [row] : []; });
    });
    if (images.length !== input.imageArtifactIds.length) throw new AgentFailure("scoped-input-missing", "Supplemental review image evidence is unavailable");
    for (const image of images) await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: image.storage_path, sha256: image.sha256 });
    const schemaPath = await this.ensureResultSchema("supplemental-review", SupplementalReviewSchema);
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, provider, resolved_model, resolved_reasoning_level, resolved_service_priority, started_at, event_offset) VALUES (?, ?, ?, ?, 'reviewer', 'starting', 1, ?, ?, 'supplemental-review', ?, ?, ?, ?, ?, ?, 0)").run(executionId, input.taskId, input.companyId, input.workflowId, `${input.workflowId}:supplemental-review:${input.revision}`, input.revision, reviewerProfile.id, reviewerProfile.provider, reviewerProfile.model, reviewerProfile.reasoningLevel, reviewerProfile.servicePriority, startedAt);
    });
    const lines: string[] = [];
    try {
      const output = await this.turnRunner.run({ task: { taskId: input.taskId, projectId: input.projectId, projectSlug: context.projectSlug, ...(context.issueKey ? { issueKey: context.issueKey } : {}), worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "reviewer", ledger: "agent", executionId, promptKind: "supplemental-review", prompt: this.reviewPrompt(input, context.title, brief, normalizedJson, draft, instructions), profile: reviewerProfile, resultSchema: SupplementalReviewSchema, schemaPath, companyId: input.companyId, workflowId: input.workflowId, revision: input.revision, signal: runtime.signal });
      const review = output.result;
      const sessionRef = output.roleSessionId;
      if (input.primaryLeadSessionRef && sessionRef === input.primaryLeadSessionRef) throw new AgentFailure("session-identity-conflict", "Supplemental reviewer must use a fresh session");
      const evidence = await this.persistEvidence(input.companyId, executionId, lines);
      const reviewArtifact = await this.artifacts.putArtifact(input.companyId, "supplemental-review", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(review, null, 2), "utf8") });
      const reviewId = `review_${randomBytes(12).toString("hex")}`;
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = ?, finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), this.now().toISOString(), evidence.id, executionId);
      });
      this.database.authTransaction((db) => db.prepare("INSERT INTO forge_plan_reviews (id, task_id, company_id, workflow_id, plan_revision, profile_id, execution_id, session_ref, opinion_artifact_id, evidence_artifact_id, summary, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reviewId, input.taskId, input.companyId, input.workflowId, input.revision, profile.id, executionId, sessionRef, reviewArtifact.id, evidence.id, review.summary, review.verdict, this.now().toISOString()));
      return { reviewId, reviewArtifactId: reviewArtifact.id, evidenceArtifactId: evidence.id, executionId, sessionRef, summary: review.summary, verdict: review.verdict, concerns: review.concerns.map((concern) => ({ severity: concern.severity, text: concern.text, ...(concern.step === undefined ? {} : { step: concern.step }) })) };
    } catch (error) {
      const failure = runtime.signal?.aborted ? new AgentFailure("cancelled", "The Codex supplemental review was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("review-failed", "The Codex supplemental review failed");
      const evidence = await this.persistEvidence(input.companyId, executionId, lines);
      const finalStatus = failure.code === "cancelled" ? "cancelled" : "failed";
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId);
      });
      throw failure;
    }
  }

  async consolidateLeadPlan(rawInput: ConsolidateLeadPlanActivityInput, runtime: { signal?: AbortSignal } = {}): Promise<LeadPlanningResult> {
    const lead = await this.resolveTurnProfile(rawInput.roleProfiles.planner, rawInput.leadSessionRef, "The Planner consolidates the plan");
    const task = this.database.authQuery((db) => db.prepare(`SELECT t.title, p.name AS projectSlug,
      CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey
      FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_companies c ON c.id = t.company_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ?`).get(rawInput.taskId, rawInput.companyId, rawInput.projectId, rawInput.workflowId) as { title: string; projectSlug: string; issueKey: string | null } | undefined);
    if (!task) throw new AgentFailure("scoped-input-missing", "Consolidation task is unavailable");
    const draft = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a WHERE a.id = ? AND a.company_id = ?").get(rawInput.leadOutputArtifactId, rawInput.companyId) as { storagePath: string; sha256: string } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT a.storage_path AS storagePath, a.sha256 FROM forge_artifacts a WHERE a.id = ? AND a.company_id = ?").get(rawInput.supplementalReviewArtifactId, rawInput.companyId) as { storagePath: string; sha256: string } | undefined);
    if (!draft || !review) throw new AgentFailure("scoped-input-missing", "Consolidation evidence is unavailable");
    const configuration = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, rawInput));
    const worktreePath = await this.planningWorktree(rawInput, configuration, task.title);
    const draftText = (await this.artifacts.getArtifact({ ...draft, companyId: rawInput.companyId })).toString("utf8");
    const reviewText = (await this.artifacts.getArtifact({ ...review, companyId: rawInput.companyId })).toString("utf8");
    const schemaPath = await this.ensureResultSchema("lead-consolidation", LeadReviewResponseSchema);
    const executionId = `agent_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, turn_key, workflow_revision, purpose, profile_id, provider, resolved_model, resolved_reasoning_level, resolved_service_priority, session_ref, started_at, event_offset) VALUES (?, ?, ?, ?, 'planner', 'starting', 1, ?, ?, 'lead-consolidation', ?, ?, ?, ?, ?, ?, ?, 0)").run(executionId, rawInput.taskId, rawInput.companyId, rawInput.workflowId, `${rawInput.workflowId}:lead-consolidation:${rawInput.revision}`, rawInput.revision, lead.id, lead.provider, lead.model, lead.reasoningLevel, lead.servicePriority, rawInput.leadSessionRef, startedAt);
    });
    const lines: string[] = [];
    try {
      const expectedRevision = rawInput.revision;
      let correction = false;
      let turn;
      let response;
      for (;;) {
        turn = await this.turnRunner.run({ task: { taskId: rawInput.taskId, projectId: rawInput.projectId, projectSlug: task.projectSlug, ...(task.issueKey ? { issueKey: task.issueKey } : {}), worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "planner", ledger: "agent", executionId, promptKind: correction ? "lead-consolidation-correction" : "lead-consolidation", prompt: this.consolidationPrompt(rawInput, draftText, reviewText, correction), profile: lead, resultSchema: LeadReviewResponseSchema, schemaPath, companyId: rawInput.companyId, workflowId: rawInput.workflowId, revision: rawInput.revision, signal: runtime.signal });
        response = turn.result;
        if (response.originalPlanRevision === expectedRevision && response.reviewArtifactId === rawInput.supplementalReviewArtifactId) break;
        if (correction) throw new AgentFailure("invalid-review-response", "Lead supplemental-review response is not pinned to the exact review");
        correction = true;
      }
      const output = response.result;
      const persisted = await this.persistOutput({ taskId: rawInput.taskId, companyId: rawInput.companyId, workflowId: rawInput.workflowId, projectId: rawInput.projectId, projectRevisionId: rawInput.projectRevisionId, briefArtifactId: rawInput.briefArtifactId, imageArtifactIds: rawInput.imageArtifactIds, roleProfiles: rawInput.roleProfiles, revision: rawInput.revision }, executionId, turn.roleSessionId, lines, output);
      const responseArtifact = await this.artifacts.putArtifact(rawInput.companyId, "lead-review-response", { filename: `${executionId}-review-response.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(response, null, 2), "utf8") });
      const reviewRow = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_plan_reviews WHERE opinion_artifact_id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(rawInput.supplementalReviewArtifactId, rawInput.taskId, rawInput.companyId, rawInput.workflowId) as { id: string } | undefined);
      if (reviewRow) this.database.authQuery((db) => db.prepare("UPDATE forge_plan_reviews SET planner_response_artifact_id = ? WHERE id = ?").run(responseArtifact.id, reviewRow.id));
      await this.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = ?, process_pid = NULL, process_group_id = NULL, finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = ?").run(turn.roleSessionId, this.now().toISOString(), this.now().toISOString(), persisted.evidence.id, executionId));
      return { ...persisted.result, leadReviewResponseArtifactId: responseArtifact.id };
    } catch (error) {
      const failure = runtime.signal?.aborted ? new AgentFailure("cancelled", "The Codex The Planner consolidates the plan was cancelled.", { nonRetryable: true }) : error instanceof AgentFailure ? error : new AgentFailure("consolidation-failed", "The Planner consolidates the plan failed");
      const evidence = await this.persistEvidence(rawInput.companyId, executionId, lines);
      const finalStatus = failure.code === "cancelled" ? "cancelled" : "failed";
      this.database.authTransaction((db) => { db.prepare("UPDATE forge_agent_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, cancelled_at = ?, evidence_artifact_id = ? WHERE id = ?").run(finalStatus, this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, finalStatus === "cancelled" ? this.now().toISOString() : null, evidence.id, executionId); });
      throw failure;
    }
  }

  private deliveryRepairPlanPrompt(input: DeliveryRepairPlanActivityInput, findings: DeliveryFinding[]): string {
    return this.renderTaskPrompt(input, "lead/delivery-repair-plan.md", { context: JSON.stringify({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectId: input.projectId, projectRevisionId: input.projectRevisionId, source: input.source, leadSessionRef: input.leadSessionRef, releaseId: input.releaseId ?? null, deliveryReviewId: input.deliveryReviewId ?? null, finalReviewId: input.finalReviewId ?? null, ciRunId: input.ciRunId ?? null, acceptanceId: input.acceptanceId ?? null, branchName: input.branchName, worktreePath: input.worktreePath, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree }), findings: JSON.stringify(findings) });
  }

  private mergeConflictPlanPrompt(title: string, brief: string, plan: string, input: MergeConflictPlanInput, conflict: ForwardMergeConflictArtifact, pinnedCommands: { setupCommand: string; verificationCommand: string }): string {
    return this.renderTaskPrompt(input, "lead/merge-conflict-plan.md", { title, brief, plan, forward_merge_identity: JSON.stringify({ branchName: input.branchName, priorHead: input.priorHead, targetBaseSha: input.targetBaseSha }), conflict_files: conflict.conflictFiles.join("\n"), combined_diff: conflict.combinedDiff, pinned_commands: JSON.stringify(pinnedCommands), operator_decision: input.operatorNotes?.join("\n") || "None." });
  }

  private ciRepairPrompt(title: string, input: CiRepairPlanActivityInput, failedChecks: Array<{ name: string; conclusion: string; summary: string | null }>, failedLogs: Array<{ name: string; runId: string; log: string }> = []): string {
    return this.renderTaskPrompt(input, "lead/ci-repair.md", { title, ci_context: JSON.stringify({ ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, failedHeadSha: input.failedHeadSha }), failed_checks: JSON.stringify(failedChecks), required_checks: JSON.stringify(input.requiredChecks), local_verification: JSON.stringify(input.localVerification), evidence_artifact: input.evidenceArtifactId, failed_logs: failedLogs.length ? `\nFailing job logs (tail):\n${failedLogs.map((entry) => `--- ${entry.name} (run ${entry.runId}) ---\n${entry.log}`).join("\n\n")}` : "" });
  }

  private deliveryReviewPrompt(input: { taskId: string; companyId: string; deliverySummary?: string | undefined; visualEvidence?: "off" | "capture" | "required" | undefined }, title: string, brief: string, plan: string, delivery: string, developerEvidence: string, gitEvidence: { targetBaseSha: string; subjectCommit: string; subjectTree: string; status: string; branch: string; head: string; tree: string; diff: string; commit: string; instructions: string }, forwardMerge: { priorHead: string; targetBaseSha: string } | null, hasDeveloperSession: boolean, repairCoverage = ""): string {
    const verificationFailure = input.deliverySummary?.startsWith(PROJECT_VERIFICATION_FAILURE_PREFIX)
      ? `\n\nProject verification failed on this commit: ${input.deliverySummary.slice(PROJECT_VERIFICATION_FAILURE_PREFIX.length).trim()}`
      : "";
    return this.renderTaskPrompt(input, "lead/delivery-review.md", { title, brief: promptExcerpt(brief, 8_000), plan: promptExcerpt(plan, 24_000), delivery: promptExcerpt(delivery, 32_000), developer_evidence: promptExcerpt(developerEvidence, 16_000), developer_session_note: hasDeveloperSession ? "" : "\n\nThere is no Developer session for this head; review the current diff against the base and treat the available delivery evidence as supplemental context.", forward_merge_note: forwardMerge ? `\n\nThis head is a clean forward merge of an already-reviewed delivery. Review the merge diff against the new base; its lineage is ${JSON.stringify(forwardMerge)}. Its pinned post-merge verification and prior delivery proof remain authoritative for unchanged behavior. Do not block solely because broader checks or manual smoke steps were not repeated after the merge; report those as advisory unless the exact merge diff shows a concrete regression or new risk.` : "", repair_coverage: repairCoverage, git_subject: JSON.stringify({ targetBaseSha: gitEvidence.targetBaseSha, branch: gitEvidence.branch, subjectCommit: gitEvidence.subjectCommit, subjectTree: gitEvidence.subjectTree, observedHead: gitEvidence.head, observedTree: gitEvidence.tree, dirtyState: gitEvidence.status ? "dirty" : "clean" }), instructions: promptExcerpt(gitEvidence.instructions || "(none found)", 12_000), diff: promptExcerpt(gitEvidence.diff, 72_000), commit: promptExcerpt(gitEvidence.commit, 12_000), visual_evidence_control: this.visualEvidenceInstruction(input.visualEvidence ?? "off") }) + verificationFailure;
  }

  private reviewPrompt(input: { taskId: string; companyId: string }, title: string, brief: string, revision: string, draft: string, instructions: string): string {
    return this.renderTaskPrompt(input, "lead/review.md", { title, brief, revision, draft, instructions: instructions || "(none found)" });
  }

  private consolidationPrompt(input: { taskId: string; companyId: string }, draft: string, review: string, correction: boolean): string {
    return this.renderTaskPrompt(input, "lead/consolidation.md", { instruction: correction ? "Your previous response did not satisfy the exact envelope or pinned identifiers. Continue the same Lead session and return one corrected JSON object only." : "Reconsider the complete Lead plan in this same session after an independent supplemental review.", draft, review });
  }

  private async planningWorktree(input: { taskId: string }, configuration: ReturnType<typeof loadTaskConfiguration>, title: string, revisionRequest?: { disposition: "reuse" | "new"; worktreePath: string | null }): Promise<string> {
    const repositoryPath = await taskScopedPath(this.config.repositoryRoot, await realpath(configuration.repositoryPath));
    const worktreeRoot = await taskScopedPath(this.config.worktreeRoot, configuration.worktreeRoot);
    if (revisionRequest?.disposition === "reuse" && revisionRequest.worktreePath) return taskScopedPath(this.config.worktreeRoot, revisionRequest.worktreePath);
    try {
      if (configuration.source) {
        const branchName = configuration.source.kind === "pull_request" ? configuration.source.headBranch : configuration.source.branch;
        return (await this.worktrees.adopt({ repositoryPath, worktreeRoot, taskId: input.taskId, branchName, baseBranch: configuration.baseBranch, sourceHeadSha: configuration.source.headSha, preserveLocal: true })).worktreePath;
      }
      const targetBaseSha = await this.worktrees.currentBaseSha(repositoryPath, configuration.baseBranch);
      const branchName = buildGitBranchName({ branchSlug: fallbackGitPresentation(title).branchSlug, taskId: input.taskId });
      return (await this.worktrees.reuse({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName })).worktreePath;
    } catch (error) {
      if (error instanceof WorktreeFailure) throw new AgentFailure(error.code, error.message);
      throw error;
    }
  }

  private async resolveTurnProfile(profileId: string | undefined, sessionRef: string | undefined, label: string, role: "planner" | "reviewer" | "integrator" = "planner"): Promise<{ id: string; provider: AgentProviderKind; model: string; reasoningLevel: "low" | "medium" | "high" | "xhigh"; servicePriority: "standard" | "priority" | "fast" }> {
    const pinned = sessionRef ? this.database.authQuery((db) => db.prepare("SELECT e.profile_id AS profileId, COALESCE(e.provider, p.provider, 'codex') AS provider, e.resolved_model AS model, e.resolved_reasoning_level AS reasoningLevel, e.resolved_service_priority AS servicePriority FROM forge_agent_executions e LEFT JOIN forge_profiles p ON p.id = e.profile_id WHERE e.session_ref = ? AND e.role = ? AND e.resolved_model IS NOT NULL ORDER BY e.started_at DESC LIMIT 1").get(sessionRef, role) as { profileId: string | null; provider: string; model: string; reasoningLevel: string; servicePriority: string } | undefined) : undefined;
    const profile = pinned ? undefined : this.database.authQuery((db) => (profileId
      ? db.prepare("SELECT id, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE id = ?").get(profileId)
      : db.prepare("SELECT id, provider, model, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE provider = ? ORDER BY id LIMIT 1").get("codex")) as { id: string; provider: AgentProviderKind; model: string; reasoningLevel: string; servicePriority: string } | undefined);
    if (!pinned && !profile) throw new AgentFailure("profile-unavailable", `${label} profile is unavailable`);
    const model = pinned?.model ?? profile!.model;
    const reasoningLevel = pinned?.reasoningLevel ?? profile!.reasoningLevel;
    const servicePriority = pinned?.servicePriority ?? profile!.servicePriority;
    const provider = pinned?.provider ?? profile!.provider;
    if (!AGENT_PROVIDER_KINDS.includes(provider as AgentProviderKind) || !/^[a-z0-9][a-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,119})?$/.test(model) || !["low", "medium", "high", "xhigh"].includes(reasoningLevel) || !["standard", "priority", "fast"].includes(servicePriority)) {
      throw new AgentFailure("scope_configuration", `${label} profile has invalid pinned turn settings`, { nonRetryable: true });
    }
    return { id: pinned?.profileId ?? profile!.id, provider: provider as AgentProviderKind, model, reasoningLevel: reasoningLevel as "low" | "medium" | "high" | "xhigh", servicePriority: servicePriority as "standard" | "priority" | "fast" };
  }

  private async ensureResultSchema(name: string, schema: z.ZodType): Promise<string> {
    const directory = join(this.config.runtimeRoot, "schemas");
    const filename = join(directory, `${name}.schema.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(filename, JSON.stringify(z.toJSONSchema(schema)), { encoding: "utf8", mode: 0o600 });
    await chmod(filename, 0o600);
    return filename;
  }

  private async ensureDeliveryReviewSchema(): Promise<string> {
    return this.ensureResultSchema("delivery-review", DeliveryReviewSchema);
  }

  private async repositoryEvidence(repositoryPath: string): Promise<string> {
    const [status, head] = await Promise.all([
      execFileAsync("git", ["status", "--short", "--branch"], { cwd: repositoryPath, timeout: 8_000, maxBuffer: 16 * 1024 }),
      execFileAsync("git", ["log", "-1", "--format=%H%n%s"], { cwd: repositoryPath, timeout: 8_000, maxBuffer: 4 * 1024 }),
    ]);
    return JSON.stringify({ status: redact(status.stdout), head: redact(head.stdout) });
  }

  private initialPrompt(input: { taskId: string; companyId: string }, title: string, brief: string, revision: string, profiles: ProfileSettings[], repositoryEvidence: string, revisionContext?: Record<string, unknown>): string {
    const task = this.database.authQuery((db) => db.prepare("SELECT run_project_tests AS runProjectTests, visual_evidence AS visualEvidence FROM forge_tasks WHERE id = ? AND company_id = ?").get(input.taskId, input.companyId) as { runProjectTests: number | null; visualEvidence: "off" | "capture" | "required" | null } | undefined);
    const testControl = task?.runProjectTests === 0
      ? "Project tests are disabled for this task. Do not include test-suite commands in verificationCommands; use only non-test checks such as type checking, linting, builds, and git status."
      : "Include appropriate verificationCommands, including the configured project suite when it applies.";
    return this.renderTaskPrompt(input, "lead/plan.md", { title, brief, revision, profiles: JSON.stringify(profiles), repository_evidence: repositoryEvidence, revision_request: revisionContext ? `\n\nRevision request:\n${JSON.stringify(revisionContext)}` : "", test_control: testControl, visual_evidence_control: this.visualEvidenceInstruction(task?.visualEvidence ?? "off") });
  }

  private visualEvidenceInstruction(value: "off" | "capture" | "required"): string {
    if (value === "off") return "Browser proof (screenshots, Playwright/browser inspection) is turned OFF for this task by the member. Do not require, plan, or request it, and never block on its absence, even if repository instructions such as AGENTS.md ask for it. At most mention it as advisory.";
    return value === "capture"
      ? "Browser proof is optional for this task. Do not block on its absence."
      : "Browser proof is required for this task; missing valid durable proof is a blocking finding.";
  }
  private revisionPrompt(note: string): string {
    return `Continue the existing primary Planner session and revise the complete plan. Work read-only and preserve the issue scope.\n\nOperator note\nThe operator note below is authoritative over the prior plan. Revise the plan to honour it by adding, removing, or undoing steps as needed; keep everything else, and explain in the summary what changed.\n${note}\n\nReturn exactly one corrected JSON object matching the required plan or decision_blocker schema. Do not include markdown fences or commentary.`;
  }

  private async persistEvidence(companyId: string, executionId: string, lines: string[]): Promise<StoredArtifact> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    return this.artifacts.putArtifact(companyId, "agent-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: content.length ? content : Buffer.from("{\"type\":\"empty\"}\n") });
  }

  private async completedPlanningResult(input: LeadPlanningActivityInput): Promise<LeadPlanningResult | undefined> {
    const persisted = this.database.authQuery((db) => db.prepare(`SELECT e.id AS executionId, e.session_ref AS sessionRef, e.output_artifact_id AS outputArtifactId, e.output_revision AS outputRevision, e.evidence_artifact_id AS evidenceArtifactId, e.output_summary AS summary,
        output.storage_path AS outputStoragePath, output.sha256 AS outputSha256, evidence.storage_path AS evidenceStoragePath, evidence.sha256 AS evidenceSha256
      FROM forge_agent_executions e
      JOIN forge_artifacts output ON output.id = e.output_artifact_id AND output.company_id = e.company_id
      JOIN forge_artifacts evidence ON evidence.id = e.evidence_artifact_id AND evidence.company_id = e.company_id
      WHERE e.id IS NOT NULL AND e.task_id = ? AND e.company_id = ? AND e.workflow_id = ? AND e.workflow_revision = ? AND e.turn_key = ? AND e.role = 'planner' AND e.status = 'completed'
      ORDER BY e.finished_at DESC LIMIT 1`).get(input.taskId, input.companyId, input.workflowId, input.revision, `${input.workflowId}:lead-planning:${input.revision}`) as {
        executionId: string;
        sessionRef: string;
        outputArtifactId: string;
        outputRevision: number;
        evidenceArtifactId: string;
        summary: string;
        outputStoragePath: string;
        outputSha256: string;
        evidenceStoragePath: string;
        evidenceSha256: string;
      } | undefined);
    if (!persisted) return undefined;
    if (!/^session_[A-Za-z0-9._:-]{1,128}$/.test(persisted.sessionRef)) throw new AgentFailure("internal_persistence", "The completed Lead session reference is invalid", { nonRetryable: true });
    const output = PersistedLeadOutputSchema.parse(jsonRequired((await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: persisted.outputStoragePath, sha256: persisted.outputSha256 })).toString("utf8")));
    await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: persisted.evidenceStoragePath, sha256: persisted.evidenceSha256 });
    const result: LeadPlanningResult = output.kind === "plan"
      ? { kind: "plan", leadOutputKind: "plan", leadSessionRef: persisted.sessionRef, leadExecutionId: persisted.executionId, leadEvidenceArtifactId: persisted.evidenceArtifactId, leadOutputArtifactId: persisted.outputArtifactId, leadSummary: persisted.summary, planSubject: { planRevision: persisted.outputRevision, artifactId: persisted.outputArtifactId, leadSessionRef: persisted.sessionRef } }
      : { kind: "decision_blocker", leadOutputKind: "decision_blocker", leadSessionRef: persisted.sessionRef, leadExecutionId: persisted.executionId, leadEvidenceArtifactId: persisted.evidenceArtifactId, leadOutputArtifactId: persisted.outputArtifactId, leadSummary: persisted.summary, blockedCategory: "human_decision", unblockOwner: "human", resumePhase: "planning", blockerSubject: { companyId: input.companyId, issueId: input.taskId, workflowId: input.workflowId, artifactId: persisted.outputArtifactId, leadSessionRef: persisted.sessionRef, leadExecutionId: persisted.executionId, category: "human_decision", resumePhase: "planning" } };
    return result;
  }

  private async persistOutput(input: LeadPlanningActivityInput, executionId: string, sessionRef: string, lines: string[], output: LeadOutput): Promise<{ evidence: StoredArtifact; result: LeadPlanningResult }> {
    const evidence = await this.persistEvidence(input.companyId, executionId, lines);
    const outputKind = output.kind === "plan" ? "lead-plan" : "decision-blocker";
    const outputArtifact = await this.artifacts.putArtifact(input.companyId, outputKind, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(output, null, 2), "utf8") });
    const summary = output.summary;
    const planSubject = output.kind === "plan" ? { planRevision: input.revision, artifactId: outputArtifact.id, leadSessionRef: sessionRef } : undefined;
    const blockerSubject = output.kind === "decision_blocker" ? { companyId: input.companyId, issueId: input.taskId, workflowId: input.workflowId, artifactId: outputArtifact.id, leadSessionRef: sessionRef, leadExecutionId: executionId, category: "human_decision" as const, resumePhase: "planning" as const } : undefined;
    if (planSubject) {
      new PlanGovernanceRepository(this.database).appendPlanVersion({ subject: planSubject, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, leadExecutionId: executionId, kind: output.kind, evidenceArtifactId: evidence.id, summary });
    } else {
      this.database.authTransaction((db) => db.prepare("UPDATE forge_agent_executions SET output_kind = ?, output_artifact_id = ?, output_revision = ?, output_summary = ?, evidence_artifact_id = ?, session_ref = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").run(output.kind, outputArtifact.id, input.revision, summary, evidence.id, sessionRef, executionId, input.taskId, input.companyId, input.workflowId));
    }
    const result: LeadPlanningResult = output.kind === "plan"
      ? { kind: "plan", leadSessionRef: sessionRef, leadExecutionId: executionId, leadEvidenceArtifactId: evidence.id, leadOutputArtifactId: outputArtifact.id, leadOutputKind: "plan", leadSummary: summary, preservedWorktreeCompatibility: output.preservedWorktreeCompatibility, ...(planSubject ? { planSubject } : {}) }
      : { kind: "decision_blocker", leadSessionRef: sessionRef, leadExecutionId: executionId, leadEvidenceArtifactId: evidence.id, leadOutputArtifactId: outputArtifact.id, leadOutputKind: "decision_blocker", leadSummary: summary, blockedCategory: "human_decision", unblockOwner: "human", resumePhase: "planning", ...(blockerSubject ? { blockerSubject } : {}) };
    return { evidence, result };
  }
}

export function hashLeadOutput(output: LeadOutput): string {
  return createHash("sha256").update(JSON.stringify(output)).digest("hex");
}
