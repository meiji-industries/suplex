import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";
import type Database from "better-sqlite3";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { AgentFailure } from "./agent-failure.js";
import { resolveAgentProvider } from "./agent-providers/index.js";
import type { AgentProvider, LeadProcessRunner, SessionStore } from "./agent-providers/provider.js";
import { CapacityManager } from "./capacity.js";
import { ForgeDatabase } from "./database.js";
import { redact, StructuredLogger } from "./logging.js";
import { toSafeSummary } from "./temporal/contracts/primitives.js";
import type { GithubReleasePort } from "./github-release.js";
import { createGitCommandGuard, withWorktreeMiseTrust, WorktreeFailure, WorktreeManager } from "./worktrees.js";
import { activateOwnedWorktree, reserveOwnedWorktree } from "./worktrees.js";
import { DeveloperEvidenceBuilder } from "./developer-evidence.js";
import { releaseDeveloperExecutionLease } from "./developer-execution-leases.js";
import { collectDeveloperGitObservation, developerReconciliationSummary, isLegacyReceiptOnlyRecovery, reconcileDeveloperDelivery, DeveloperReconciliationArtifactSchema } from "./developer-reconciliation.js";
import { AuthorizedPlanSubjectSchema, EvidenceManifestSchema, ExecutionReceiptSchema, OwnedWorktreeSchema, type ExecutionReceipt, type EvidenceManifest } from "./developer-contracts.js";
import { createGithubAdapter, type GithubAdapter, type GithubMutationSurface } from "./github.js";
import { ForwardMergeConflictArtifactSchema, type ForwardMergeConflictArtifact } from "./forward-merge.js";
import { runPinnedVerification } from "./verification.js";
import { parseAcceptedProjectRevision } from "./projects.js";
import { DeliveryReviewSubjectSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, type CiRepairActivityInput, type CiRepairActivityResult, type DeliveryFinding, type DeveloperExecutionActivityInput, type DeveloperExecutionResult, type DeveloperRepairActivityInput, type DeveloperRepairActivityResult, type DeveloperSupervisorActivityIdentity, type MergeConflictResolutionActivityInput, type MergeConflictResolutionActivityResult } from "./temporal/issue-contracts.js";
import { buildGitBranchName } from "./git-branch-name.js";
import { fallbackGitPresentation } from "./git-presentation.js";

const execFileAsync = promisify(execFile);

export function buildDeveloperExecutionPrompt(input: { executionId: string; reuseWorktree: boolean; startingSha: string; verificationSteps: string }): string {
  const worktreeInstruction = input.reuseWorktree
    ? ` This is a linked retry: inspect and continue the preserved partial changes; do not discard them. If, and only if, \`git log --oneline ${input.startingSha}..HEAD\` shows a commit directly on the accepted starting SHA that already implements the plan, verify that existing commit instead of creating a duplicate.`
    : " This is a fresh turn: the worktree is at the accepted starting SHA with no prior work; you must make the change and create exactly one commit.";
  return `You are Forge's Developer. Execute only the authorized final plan in this isolated worktree. The final plan is staged at .forge-context/${input.executionId}/final-plan.json. Read only the other files under that exact execution directory. Stop before editing if repository facts contradict the plan.${worktreeInstruction} During execution, post concise public progress updates before each substantive action and after notable results: say what you are inspecting, changing, or verifying and why, without exposing private chain-of-thought. Create exactly one ordinary local commit for the authorized work when a new commit is required, leave the worktree clean, and return exactly one JSON object with no markdown fences or commentary matching: {"kind":"delivery","summary":"...","steps":[{"number":1,"status":"completed|incomplete|not_completed|blocked","filesChanged":[],"notes":"..."}],"authorizedStepsNotCompleted":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Include every approved step number exactly once and keep filesChanged to the exact changed paths. For any incomplete, not_completed, or blocked step, list its number in authorizedStepsNotCompleted and provide a non-null blocker. Forge will run the accepted pinned setup and final verification independently after the Developer process exits. Expected plan verification commands for context:\n${input.verificationSteps}\nDo not push, create PRs, merge, rebase, amend, reset, clean, force, or use provider mutation.`;
}

class StaleRecovery extends Error {}

interface StoredRecoveryRow {
  status: string;
  failureCode: string | null;
  sessionRef: string | null;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  deliveryArtifactId: string | null;
  resultCommit: string | null;
  resultTree: string | null;
  authorizationId: string;
  worktreeLeaseId: string;
  manifestArtifactId: string;
  manifestSha256: string;
  beforeProviderArtifactId: string | null;
  beforeProviderSha256: string | null;
  rawReportArtifactId: string | null;
  rawReportSha256: string | null;
  reconciliationArtifactId: string | null;
  reconciliationSha256: string | null;
  startingCommit: string;
  startingTree: string;
  finalCommit: string | null;
  finalTree: string | null;
}

type RepairBlockCode = import("./temporal/issue-contracts.js").DeliveryOperationBlockCode;
function repairBlockCode(failure: AgentFailure): RepairBlockCode {
  if (failure.code === "repair-cap-exhausted") return "repair-cap-exhausted";
  if (failure.code === "repair-cycle-conflict") return "repair-cap-exhausted";
  if (["missing-repair-report", "malformed-repair-report", "invalid-repair-report"].includes(failure.code)) return "invalid-output";
  if (failure.code === "repair-incomplete") return "repair-incomplete";
  if (failure.code === "repair-scope-violation") return "repair-scope";
  if (failure.code === "session-identity-conflict" || failure.code === "session-conflict") return "session-conflict";
  if (failure.code === "repair-subject-changed" || failure.code === "repair-identity-mismatch") return "subject-changed";
  if (failure.code === "repair-revision-invalid" || failure.code === "repair-revision-mismatch") return "worktree-unsafe";
  if (failure.code === "login-expired" || failure.code === "authentication-required") return "authentication-required";
  if (failure.code === "rate-limited") return "rate-limited";
  if (failure.code === "evidence-too-large") return "evidence-too-large";
  return "process-failed";
}
const repairSummary: Record<RepairBlockCode, string> = {
  "invalid-output": "The Developer repair report was not machine-readable; retry the repair.",
  "correction-exhausted": "The Developer repair report remained invalid; retry the repair.",
  "session-conflict": "The Developer repair returned a different session identity; retry the repair.",
  "authentication-required": "Agent provider authentication is unavailable; sign in again, then retry.",
  "rate-limited": "Agent provider rate limiting prevented the repair from completing; retry later.",
  "process-failed": "The Developer repair process did not complete; inspect the evidence and retry.",
  "evidence-too-large": "Developer repair evidence exceeded the local artifact limit; retry with bounded output.",
  "subject-changed": "The reviewed delivery subject changed; produce a fresh exact delivery.",
  "repair-incomplete": "The repair did not address every open blocking finding.",
  "repair-scope": "The repair exceeded the supplied blocking-finding scope.",
  "worktree-unsafe": "The repair did not produce the required clean child commit.",
  "repair-cap-exhausted": "The configured repair-cycle limit has been reached.",
};

type MergeConflictResolutionInput = MergeConflictResolutionActivityInput;

const ProjectRevisionSchema = z.object({
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  baseBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
});
const DeveloperDeliveryStepSchema = z.object({
  number: z.number().int().positive(),
  status: z.enum(["completed", "incomplete", "not_completed", "blocked"]),
  filesChanged: z.array(z.string().max(500)).max(128),
  commandsRun: z.array(z.string().max(500)).max(128).optional(),
  testResults: z.array(z.string().max(2_000)).max(64).optional(),
  notes: z.string().max(4_000),
});
const RepairAuthorityEnvelopeSchema = z.object({
  source: z.enum(["ci_failure", "final_review_blocking", "member_requested_changes"]),
  planRevision: z.number().int().nonnegative(),
  exactContext: z.object({
    taskId: z.string(),
    companyId: z.string(),
    workflowId: z.string(),
    projectId: z.string(),
    projectRevisionId: z.string(),
    releaseId: z.string().nullable(),
    deliveryReviewId: z.string().nullable(),
    finalReviewId: z.string().nullable(),
    ciRunId: z.string().nullable(),
    acceptanceId: z.string().nullable(),
    reasonArtifactId: z.string().nullable(),
    branchName: z.string(),
    targetBaseSha: z.string(),
    subjectCommit: z.string(),
    subjectTree: z.string(),
    leadSessionRef: z.string(),
  }),
  findingIds: z.array(z.string()),
});

function parseRepairAuthorityEnvelope(plan: string): z.infer<typeof RepairAuthorityEnvelopeSchema> {
  const match = /^<!-- forge-repair-authority (\{.*\}) -->/.exec(plan);
  if (!match?.[1]) throw new AgentFailure("repair-authority-mismatch", "The Lead repair-plan artifact is missing its source-bound authority envelope");
  try {
    return RepairAuthorityEnvelopeSchema.parse(JSON.parse(match[1]));
  } catch {
    throw new AgentFailure("repair-authority-mismatch", "The Lead repair-plan authority envelope is invalid");
  }
}
export const DeveloperDeliveryReportSchema = z.object({
  kind: z.literal("delivery"),
  summary: z.string().min(1).max(2_000),
  steps: z.array(DeveloperDeliveryStepSchema).min(1).max(64),
  authorizedStepsNotCompleted: z.array(z.number().int().positive()).max(64),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().max(4_000).nullable(),
});

export const DeveloperRepairReportSchema = z.object({
  kind: z.literal("repair"),
  summary: z.string().min(1).max(2_000),
  addressedFindingIds: z.array(z.string().min(1).max(256)).max(64),
  commandsRun: z.array(z.string().max(500)).max(128),
  testResults: z.array(z.string().max(2_000)).max(64),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().max(4_000).nullable(),
});

export const DeveloperMergeConflictResolutionReportSchema = z.object({
  kind: z.literal("merge_conflict_resolution"),
  summary: z.string().min(1).max(2_000),
  resolvedFiles: z.array(z.string().min(1).max(1_000)).max(128),
  commandsRun: z.array(z.string().max(500)).min(1).max(128),
  testResults: z.array(z.string().max(2_000)).min(1).max(64),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().max(4_000).nullable(),
});

export type DeveloperDeliveryReport = z.infer<typeof DeveloperDeliveryReportSchema>;

interface DeveloperContext {
  title: string;
  normalizedJson: string;
  briefStoragePath: string;
  briefSha256: string;
  planStoragePath: string;
  planSha256: string;
  evidenceStoragePath: string;
  evidenceSha256: string;
}

interface DeveloperProfile {
  id: string;
  model: string;
  provider: string;
  reasoningLevel: string;
  servicePriority: string;
}

interface PriorDeveloperExecution {
  id: string;
  status: string;
  branch_name: string;
  worktree_path: string;
  target_base_sha: string;
}

function registerArtifact(db: Database.Database, artifact: StoredArtifact): void {
  db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
  const row = db.prepare("SELECT company_id AS companyId, kind, filename, mime_type AS mimeType, byte_size AS byteSize, sha256, storage_path AS storagePath, created_at AS createdAt FROM forge_artifacts WHERE id = ?").get(artifact.id) as Omit<StoredArtifact, "id"> | undefined;
  if (!row || row.companyId !== artifact.companyId || row.kind !== artifact.kind || row.filename !== artifact.filename || row.mimeType !== artifact.mimeType || row.byteSize !== artifact.byteSize || row.sha256 !== artifact.sha256 || row.storagePath !== artifact.storagePath || row.createdAt !== artifact.createdAt) throw new AgentFailure("artifact-idempotency-conflict", "Developer artifact metadata conflicts with an existing stable claim artifact", { nonRetryable: true });
}

function isSupervisorTerminalError(error: unknown): boolean {
  return error instanceof Error && error.name === "SupervisedDeveloperTerminalError";
}

export interface DeveloperServiceOptions {
  command?: string;
  provider?: AgentProvider;
  processRunner?: LeadProcessRunner;
  sessionStore?: SessionStore;
  worktrees?: WorktreeManager;
  now?: () => Date;
  github?: Pick<GithubReleasePort, "getPullRequest">;
  githubObservation?: GithubAdapter;
}

function safeJsonLine(line: string): string {
  try { return JSON.stringify(redact(JSON.parse(line))) ?? JSON.stringify({ type: "empty" }); } catch { return JSON.stringify({ type: "text", text: redact(line) }); }
}

function parseDeliveryReport(lines: string[], provider: AgentProvider): DeveloperDeliveryReport {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-delivery-report", "Codex Developer did not return a delivery report");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-delivery-report", "Codex Developer returned malformed delivery JSON"); }
  const report = DeveloperDeliveryReportSchema.safeParse(parsed);
  if (!report.success) throw new AgentFailure("invalid-delivery-report", "Codex Developer returned a delivery report outside the required schema");
  return report.data;
}

function parseRepairReport(lines: string[], provider: AgentProvider): z.infer<typeof DeveloperRepairReportSchema> {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-repair-report", "Codex Developer did not return a repair report");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-repair-report", "Codex Developer returned malformed repair JSON"); }
  const result = DeveloperRepairReportSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-repair-report", "Codex Developer returned a repair report outside the required schema");
  return result.data;
}

function parseMergeConflictResolutionReport(lines: string[], provider: AgentProvider): z.infer<typeof DeveloperMergeConflictResolutionReportSchema> {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-merge-resolution-report", "Codex Developer did not return a merge-conflict resolution report");
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-merge-resolution-report", "Codex Developer returned malformed merge-conflict resolution JSON"); }
  const result = DeveloperMergeConflictResolutionReportSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-merge-resolution-report", "Codex Developer returned a merge-conflict resolution outside the required schema");
  return result.data;
}

function scopedRepository(root: string, candidate: string): Promise<string> {
  return Promise.all([realpath(root), realpath(candidate)]).then(([absoluteRoot, absoluteCandidate]) => {
    const path = relative(absoluteRoot, absoluteCandidate);
    if (path.startsWith(`..${sep}`) || path === "..") throw new AgentFailure("unsafe-working-directory", "Developer repository is outside the configured repository root");
    return absoluteCandidate;
  });
}

/**
 * Roll a Forge-owned CI-repair worktree back to the commit the repair started
 * from. A repair turn that fails after committing otherwise leaves its own
 * commit as HEAD and every later pre-flight refuses forever. Only unpushed
 * commits are ever discarded: `origin/<branch>` must already be an ancestor of
 * the prior commit, and the prior commit an ancestor of HEAD.
 */
export async function rollbackUnpushedRepairCommits(worktreePath: string, branchName: string, priorCommit: string): Promise<boolean> {
  const git = async (args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd: worktreePath, timeout: 8_000, maxBuffer: 64 * 1024 })).stdout.trim();
  try {
    if (await git(["rev-parse", "--abbrev-ref", "HEAD"]) !== branchName) return false;
    if ((await git(["rev-parse", "HEAD"])).toLowerCase() === priorCommit.toLowerCase()) return true;
    await git(["merge-base", "--is-ancestor", priorCommit, "HEAD"]);
    await git(["merge-base", "--is-ancestor", await git(["rev-parse", `refs/remotes/origin/${branchName}`]), priorCommit]);
    await git(["reset", "--hard", priorCommit]);
    return true;
  } catch { return false; }
}

async function processStartIdentity(pid: number, fallback: string): Promise<string> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { maxBuffer: 4 * 1024 });
    const value = result.stdout.trim();
    return value ? `${pid}:${value}` : `${pid}:${fallback}`;
  } catch { return `${pid}:${fallback}`; }
}

export class DeveloperService {
  private readonly artifacts: ArtifactStore;
  private readonly provider: AgentProvider;
  private readonly command: string;
  private readonly processRunner: LeadProcessRunner;
  private readonly sessionStore: SessionStore;
  private readonly worktrees: WorktreeManager;
  private readonly now: () => Date;
  private readonly github: Pick<GithubReleasePort, "getPullRequest"> | undefined;
  private readonly githubObservation: GithubAdapter;

  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig, options: DeveloperServiceOptions = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot);
    this.provider = options.provider ?? resolveAgentProvider();
    this.command = this.provider.resolveCommand(options.command);
    this.processRunner = options.processRunner ?? this.provider.processRunner;
    this.sessionStore = options.sessionStore ?? this.provider.createSessionStore(config.runtimeRoot);
    this.worktrees = options.worktrees ?? new WorktreeManager();
    this.now = options.now ?? (() => new Date());
    this.github = options.github;
    this.githubObservation = options.githubObservation ?? createGithubAdapter();
  }

  private bindCapacityInTransaction(db: Database.Database, input: { capacityRequestId?: string | undefined }, executionId: string, sessionRef?: string, worktreePath?: string): void {
    if (!input.capacityRequestId) return;
    const request = new CapacityManager(this.database, this.config).bindExecutionInTransaction(db, input.capacityRequestId, { executionKind: "developer", executionId, ...(sessionRef ? { sessionRef } : {}), ...(worktreePath ? { worktreePath } : {}) });
    db.prepare("UPDATE forge_developer_executions SET capacity_request_id = ?, profile_id = ?, provider = ?, model = ?, reasoning_level = ?, service_priority = ? WHERE id = ?").run(request.id, request.profileId, request.provider, request.model, request.reasoningLevel, request.servicePriority, executionId);
  }

  private executionProfile(input: { capacityRequestId?: string | undefined }, profileId?: string): DeveloperProfile | undefined {
    if (input.capacityRequestId) return this.database.authQuery((db) => db.prepare("SELECT profile_id AS id, model, provider, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_capacity_requests WHERE id = ?").get(input.capacityRequestId) as DeveloperProfile | undefined);
    if (!profileId) return undefined;
    return this.database.authQuery((db) => db.prepare("SELECT id, model, provider, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE id = ?").get(profileId) as DeveloperProfile | undefined);
  }

  async run(rawInput: DeveloperExecutionActivityInput & Partial<DeveloperSupervisorActivityIdentity>): Promise<DeveloperExecutionResult> {
    const input = rawInput;
    if (input.authorization) return this.runAuthorized(input as DeveloperExecutionActivityInput & Partial<DeveloperSupervisorActivityIdentity> & { authorization: NonNullable<DeveloperExecutionActivityInput["authorization"]> });
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, r.normalized_json AS normalizedJson, b.storage_path AS briefStoragePath, b.sha256 AS briefSha256, pa.storage_path AS planStoragePath, pa.sha256 AS planSha256, ea.storage_path AS evidenceStoragePath, ea.sha256 AS evidenceSha256, io.id AS outputId, io.original_plan_revision AS originalPlanRevision, io.revision AS outputRevision, io.final_version AS finalVersion, io.output_artifact_id AS artifactId, io.artifact_sha256 AS artifactSha256, io.session_ref AS leadSessionRef, io.execution_id AS leadExecutionId, io.evidence_manifest_artifact_id AS evidenceManifestArtifactId, io.evidence_manifest_sha256 AS evidenceManifestSha256
      FROM forge_tasks t JOIN forge_project_revisions r ON r.id = (SELECT current.id FROM forge_project_revisions current WHERE current.project_id = t.project_id AND current.state = 'accepted' ORDER BY current.revision DESC LIMIT 1)
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id JOIN forge_issue_outputs io ON io.output_artifact_id = ? AND io.task_id = t.id AND io.workflow_id = t.workflow_id
      JOIN forge_artifacts pa ON pa.id = io.output_artifact_id JOIN forge_artifacts ea ON ea.id = io.evidence_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId) as DeveloperContext & { outputId?: string; originalPlanRevision?: number; outputRevision?: number; finalVersion?: number; artifactId?: string; artifactSha256?: string; leadSessionRef?: string; leadExecutionId?: string; evidenceManifestArtifactId?: string; evidenceManifestSha256?: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Authorized Lead delivery evidence is unavailable");
    if (!input.finalPlanSubject) throw new AgentFailure("plan-authority-missing", "Developer execution requires the final Lead plan subject");
    const projectRevision = ProjectRevisionSchema.safeParse(JSON.parse(context.normalizedJson));
    if (!projectRevision.success) throw new AgentFailure("scoped-input-missing", "Pinned project execution configuration is unavailable");
    const repositoryPath = await scopedRepository(this.config.repositoryRoot, projectRevision.data.repositoryPath);
    const [brief, planText, leadEvidence] = await Promise.all([
      this.artifacts.read({ companyId: input.companyId, storagePath: context.briefStoragePath, sha256: context.briefSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.read({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.read({ companyId: input.companyId, storagePath: context.evidenceStoragePath, sha256: context.evidenceSha256 }).then((bytes) => bytes.toString("utf8")),
    ]);
    const plan = JSON.parse(planText) as { kind?: unknown; steps?: Array<{ number: number; instruction: string; verification: string }> };
    if (plan.kind !== "plan" || !Array.isArray(plan.steps) || !plan.steps.length) throw new AgentFailure("plan-unavailable", "A final Lead plan is required before development");
    const profile = this.executionProfile(input, input.roleProfiles.builder);
    if (!profile || profile.provider !== this.provider.id) throw new AgentFailure("developer-profile-unavailable", "Developer execution requires an allowed Codex profile");
    const prior = input.supersedesExecutionId
      ? this.database.authQuery((db) => db.prepare("SELECT id, status, branch_name, worktree_path, target_base_sha FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.supersedesExecutionId, input.taskId, input.companyId, input.workflowId) as PriorDeveloperExecution | undefined)
      : this.database.authQuery((db) => db.prepare("SELECT id, status, branch_name, worktree_path, target_base_sha FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND plan_revision = ? AND status IN ('interrupted', 'cancelled', 'failed', 'blocked') ORDER BY attempt DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.planRevision) as PriorDeveloperExecution | undefined);
    if (input.supersedesExecutionId && (!prior || !["interrupted", "cancelled", "failed", "blocked"].includes(prior.status))) throw new AgentFailure("retry-not-available", "Only an interrupted, cancelled, failed, or blocked Developer attempt can be retried");
    const revisionAuthorization = input.revisionRequestId ? this.database.authQuery((db) => db.prepare(`SELECT id, disposition, status, authorized_plan_revision AS authorizedPlanRevision, worktree_path AS worktreePath, branch_name AS branchName, base_sha AS baseSha, head_sha AS headSha, tree_sha AS treeSha, exact_base_sha AS exactBaseSha
      FROM forge_plan_revision_requests WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.revisionRequestId, input.taskId, input.companyId, input.workflowId) as { id: string; disposition: "reuse" | "new"; status: "accepted" | "authorized"; authorizedPlanRevision: number | null; worktreePath: string | null; branchName: string | null; baseSha: string | null; headSha: string | null; treeSha: string | null; exactBaseSha: string | null } | undefined) : undefined;
    if (input.revisionRequestId && (!revisionAuthorization || revisionAuthorization.status !== "authorized" || revisionAuthorization.authorizedPlanRevision !== input.planRevision)) throw new AgentFailure("revision-not-authorized", "Developer execution is not authorized for this plan revision");
    const executionId = input.developerTurnExecutionId ?? input.executionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const existing = this.database.authQuery((db) => db.prepare("SELECT task_id AS taskId, company_id AS companyId, workflow_id AS workflowId, plan_revision AS planRevision, attempt, status, branch_name AS branchName, worktree_path AS worktreePath, target_base_sha AS targetBaseSha, supersedes_execution_id AS supersedesExecutionId, session_ref AS sessionRef FROM forge_developer_executions WHERE id = ?").get(executionId) as { taskId: string; companyId: string; workflowId: string; planRevision: number; attempt: number; status: string; branchName: string; worktreePath: string; targetBaseSha: string; supersedesExecutionId: string | null; sessionRef: string | null } | undefined);
    const pinnedBase = existing?.targetBaseSha ?? prior?.target_base_sha ?? (revisionAuthorization?.disposition === "new" ? revisionAuthorization.exactBaseSha : revisionAuthorization?.baseSha);
    // Build on the base branch as it is right now: the project-revision snapshot goes stale
    // the moment another task merges. A recorded execution base stays authoritative on retry.
    const targetBaseSha = pinnedBase ?? await this.worktrees.currentBaseSha(repositoryPath, projectRevision.data.baseBranch).catch(() => projectRevision.data.targetSha);
    if (!/^[a-f0-9]{40,64}$/i.test(targetBaseSha)) throw new AgentFailure("pinned-revision-missing", "The accepted project revision does not contain an exact target SHA");
    let branchName = prior?.branch_name ?? buildGitBranchName({ branchSlug: fallbackGitPresentation(context.title).branchSlug, taskId: input.taskId });
    const worktreeRoot = await scopedRepository(this.config.worktreeRoot, projectRevision.data.worktreeRoot);
    const attempt = input.developerAttempt ?? Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    if (existing && (existing.taskId !== input.taskId || existing.companyId !== input.companyId || existing.workflowId !== input.workflowId || existing.planRevision !== input.planRevision || existing.attempt !== attempt || existing.branchName !== branchName || existing.targetBaseSha !== targetBaseSha || existing.supersedesExecutionId !== (prior?.id ?? null) || !["starting", "running"].includes(existing.status))) throw new AgentFailure("developer-execution-identity-conflict", "The deterministic Developer execution ID is already bound to different coordinates", { nonRetryable: true });
    let worktree;
    try {
      if (existing) {
        worktree = { branchName: existing.branchName, worktreePath: await scopedRepository(this.config.worktreeRoot, existing.worktreePath), targetBaseSha: existing.targetBaseSha };
      } else if (revisionAuthorization?.disposition === "reuse") {
        if (!revisionAuthorization.worktreePath || !revisionAuthorization.branchName || !revisionAuthorization.baseSha || !revisionAuthorization.headSha || !revisionAuthorization.treeSha) throw new AgentFailure("revision-coordinates-missing", "Authorized preserved worktree coordinates are incomplete");
        const inspected = await this.worktrees.inspectForPlanRevision({ repositoryPath, worktreeRoot, worktreePath: revisionAuthorization.worktreePath, branchName: revisionAuthorization.branchName, baseSha: revisionAuthorization.baseSha, resultCommit: revisionAuthorization.headSha, resultTree: revisionAuthorization.treeSha });
        branchName = inspected.branchName;
        worktree = { branchName: inspected.branchName, worktreePath: revisionAuthorization.worktreePath, targetBaseSha: inspected.baseSha };
      } else if (revisionAuthorization?.disposition === "new") {
        branchName = `${buildGitBranchName({ branchSlug: fallbackGitPresentation(context.title).branchSlug, taskId: input.taskId })}-r${input.planRevision}`;
        worktree = await this.worktrees.create({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName, pathSegment: `${input.taskId}-revision-${input.planRevision}` });
      } else {
        worktree = input.reuseWorktree || prior ? await this.worktrees.reuse({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName }) : await this.worktrees.create({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName });
      }
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      if (error instanceof Error && "code" in error) throw new AgentFailure(String((error as { code: string }).code), error.message);
      throw error;
    }
    const startedAt = this.now().toISOString();
    const wrapperId = `wrapper_${randomBytes(12).toString("hex")}`;
    let guard: Awaited<ReturnType<typeof createGitCommandGuard>> | undefined;
    guard = await createGitCommandGuard(this.config.runtimeRoot);
    this.database.authTransaction((db) => {
      db.prepare(`INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, started_at, heartbeat_at, current_step) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, worktree.branchName, worktree.worktreePath, worktree.targetBaseSha, wrapperId, guard!.directory, prior?.id ?? null, startedAt, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, existing?.sessionRef ?? undefined, worktree.worktreePath);
    });
    const prompt = this.prompt(context.title, brief, planText, leadEvidence, worktree);
    const evidenceLines = [JSON.stringify({ type: "forge.prompt", text: redact(prompt) })];
    const outputLines: string[] = [];
    let sessionRef: string | undefined = existing?.sessionRef ?? undefined;
    let rawSessionId: string | undefined = sessionRef ? await this.sessionStore.read(sessionRef) : undefined;
    try {
      const heartbeat = setInterval(() => void this.heartbeat(executionId), 5_000);
      try {
        const result = await this.processRunner({
          command: this.command,
          args: this.provider.buildTurnArgs({ prompt, profile }),
          stdin: prompt,
          cwd: worktree.worktreePath,
          env: withWorktreeMiseTrust(guard.env, worktree.worktreePath),
          detached: true,
          onStart: async (pid, processStartedAt) => { const identity = await processStartIdentity(pid, processStartedAt); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', process_pid = ?, process_group_id = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, pid, identity, this.now().toISOString(), executionId)); },
          onLine: async (line) => {
            const sanitized = safeJsonLine(line);
            evidenceLines.push(sanitized);
            outputLines.push(line);
            const event = this.provider.parseEvent(line);
            if (event.threadId && rawSessionId && event.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "Developer returned a different session identity for the same durable execution");
            if (event.threadId && !sessionRef) { rawSessionId = event.threadId; sessionRef = await this.sessionStore.create(rawSessionId); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET session_ref = ?, heartbeat_at = ? WHERE id = ?").run(sessionRef, this.now().toISOString(), executionId)); }
            await this.heartbeat(executionId);
          },
        });
        if (result.exitCode !== 0) {
          evidenceLines.push(JSON.stringify({ type: "forge.process-failure", exitCode: result.exitCode, stderr: redact(result.stderr) }));
          throw this.provider.classifyProcessFailure(result, outputLines, profile.model);
        }
        if (!sessionRef || !rawSessionId || sessionRef === input.leadSessionRef) throw new AgentFailure("session-identity-conflict", "Developer session must be distinct from the Lead session");
        const report = parseDeliveryReport(evidenceLines, this.provider);
        const gitState = await this.worktrees.inspectDelivery(worktree.worktreePath);
        if (gitState.branchName !== worktree.branchName) throw new AgentFailure("delivery-revision-invalid", "Developer delivery was produced on the wrong issue branch");
        const expectedNumbers = plan.steps.map((step) => step.number).sort((a, b) => a - b);
        const actualNumbers = report.steps.map((step) => step.number).sort((a, b) => a - b);
        if (JSON.stringify(expectedNumbers) !== JSON.stringify(actualNumbers)) throw new AgentFailure("delivery-step-mismatch", "Developer delivery does not map every approved plan step");
        if (JSON.stringify(report.authorizedStepsNotCompleted.sort((a, b) => a - b)) !== JSON.stringify(report.steps.filter((step) => step.status !== "completed").map((step) => step.number).sort((a, b) => a - b))) throw new AgentFailure("delivery-step-mismatch", "Developer delivery did not identify incomplete authorized steps consistently");
        if (report.resultCommit.toLowerCase() !== gitState.headSha.toLowerCase() || report.resultTree.toLowerCase() !== gitState.treeSha.toLowerCase() || report.dirtyState !== gitState.dirtyState) throw new AgentFailure("delivery-revision-mismatch", "Developer delivery report does not match the exact Git result");
        const deliveryArtifact = await this.artifacts.putIdempotent(input.companyId, "developer-delivery", `${executionId}:delivery`, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ ...report, branchName: worktree.branchName, worktreePath: worktree.worktreePath, targetBaseSha: worktree.targetBaseSha }, null, 2), "utf8") });
        const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
        const blocked = gitState.headSha === worktree.targetBaseSha || report.authorizedStepsNotCompleted.length > 0 || report.dirtyState !== "clean" || report.blocker !== null;
        const terminalStatus = this.database.authTransaction((db) => {
          registerArtifact(db, evidence);
          registerArtifact(db, deliveryArtifact);
          const updated = db.prepare("UPDATE forge_developer_executions SET status = ?, session_ref = ?, finished_at = ?, heartbeat_at = ?, current_step = NULL, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(blocked ? "blocked" : "completed", sessionRef, this.now().toISOString(), this.now().toISOString(), gitState.headSha, gitState.treeSha, gitState.dirtyState, deliveryArtifact.id, evidence.id, executionId);
          if (updated.changes === 1) releaseDeveloperExecutionLease(db, executionId);
          return updated.changes === 1 ? blocked ? "blocked" : "completed" : (db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId) as { status: string } | undefined)?.status;
        });
        if (terminalStatus === "cancelled" || terminalStatus === "interrupted") throw new AgentFailure("developer-cancelled", "Developer execution was cancelled before completion");
        if (terminalStatus !== (blocked ? "blocked" : "completed")) throw new AgentFailure("developer-superseded", "Developer execution was superseded before completion");
        return { developerExecutionId: executionId, developerSessionRef: sessionRef, worktreePath: worktree.worktreePath, branchName: worktree.branchName, targetBaseSha: worktree.targetBaseSha, currentStep: null, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState, deliveryArtifactId: deliveryArtifact.id, evidenceArtifactId: evidence.id, deliverySummary: report.summary, outcome: blocked ? "blocked" : "completed" };
      } finally { clearInterval(heartbeat); }
    } catch (error) {
      if (isSupervisorTerminalError(error)) throw error;
      const failure = error instanceof AgentFailure ? error : new AgentFailure("developer-failed", "Codex Developer execution failed");
      const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
      this.database.authTransaction((db) => {
        registerArtifact(db, evidence);
        const finishedAt = this.now().toISOString();
        const updated = db.prepare("UPDATE forge_developer_executions SET status = CASE WHEN status IN ('starting', 'running') THEN 'failed' ELSE status END, session_ref = COALESCE(session_ref, ?), finished_at = COALESCE(finished_at, ?), heartbeat_at = ?, failure_code = CASE WHEN status IN ('starting', 'running') THEN ? ELSE failure_code END, failure_summary = CASE WHEN status IN ('starting', 'running') THEN ? ELSE failure_summary END, evidence_artifact_id = COALESCE(evidence_artifact_id, ?) WHERE id = ?").run(sessionRef ?? null, finishedAt, finishedAt, failure.code, failure.message, evidence.id, executionId);
        if (updated.changes === 1) releaseDeveloperExecutionLease(db, executionId);
      });
      throw failure;
    } finally { await guard?.cleanup(); }
  }

  private persistDeveloperReceipts(executionId: string, receipts: ExecutionReceipt[]): void {
    if (!receipts.length) return;
    this.database.authTransaction((db) => {
      for (const receipt of receipts) {
        db.prepare("INSERT OR IGNORE INTO forge_developer_execution_events (event_id, execution_id, attempt, sequence, kind, step_number, source_item_id, occurred_at, summary, exit_code, artifact_id, artifact_sha256, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(receipt.eventId, executionId, receipt.attempt, receipt.sequence, receipt.kind, receipt.stepNumber, receipt.sourceItemId, receipt.occurredAt, receipt.summary, receipt.exitCode, receipt.artifactId, receipt.artifactSha256, receipt.idempotencyKey);
      }
      db.prepare("UPDATE forge_developer_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(this.now().toISOString(), executionId);
    });
  }

  async reconcileStoredDelivery(input: { taskId: string; companyId: string; workflowId: string; developerExecutionId: string }): Promise<DeveloperExecutionResult | null> {
    let row: StoredRecoveryRow | undefined;
    try {
      row = this.database.authQuery((db) => db.prepare(`SELECT e.status, e.failure_code AS failureCode, e.session_ref AS sessionRef, e.worktree_path AS worktreePath, e.branch_name AS branchName, e.target_base_sha AS targetBaseSha, e.delivery_artifact_id AS deliveryArtifactId, e.result_commit AS resultCommit, e.result_tree AS resultTree,
          t.authorization_id AS authorizationId, t.worktree_lease_id AS worktreeLeaseId, t.manifest_artifact_id AS manifestArtifactId, t.manifest_sha256 AS manifestSha256,
          t.before_provider_artifact_id AS beforeProviderArtifactId, t.before_provider_sha256 AS beforeProviderSha256, t.raw_report_artifact_id AS rawReportArtifactId, t.raw_report_sha256 AS rawReportSha256,
          t.reconciliation_artifact_id AS reconciliationArtifactId, t.reconciliation_sha256 AS reconciliationSha256, t.starting_commit AS startingCommit, t.starting_tree AS startingTree, t.final_commit AS finalCommit, t.final_tree AS finalTree
        FROM forge_developer_executions e
        JOIN forge_developer_execution_truth t ON t.execution_id = e.id
        WHERE e.id = ? AND e.task_id = ? AND e.company_id = ? AND e.workflow_id = ?
          AND NOT EXISTS (SELECT 1 FROM forge_developer_executions successor WHERE successor.supersedes_execution_id = e.id)`).get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as StoredRecoveryRow | undefined);
    } catch (error) {
      this.logRecoveryFault(input, "eligibility-query", error);
      return null;
    }
    if (!row || !row.reconciliationArtifactId || !row.reconciliationSha256) return null;
    const readArtifactJson = async (artifactId: string, sha256: string, kind: string): Promise<unknown> => {
      const artifact = this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = ?").get(artifactId, input.companyId, kind) as { storagePath: string; sha256: string } | undefined);
      if (!artifact || artifact.sha256 !== sha256) throw new Error("artifact identity mismatch");
      return JSON.parse((await this.artifacts.read({ companyId: input.companyId, storagePath: artifact.storagePath, sha256: artifact.sha256 })).toString("utf8")) as unknown;
    };
    if (row.status === "completed") {
      try {
        const completed = DeveloperReconciliationArtifactSchema.parse(await readArtifactJson(row.reconciliationArtifactId, row.reconciliationSha256, "developer-reconciliation"));
        const persistedManifest = EvidenceManifestSchema.parse(await readArtifactJson(row.manifestArtifactId, row.manifestSha256, "developer-evidence-manifest"));
        const artifact = this.database.authQuery((db) => db.prepare("SELECT filename FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'developer-reconciliation' AND sha256 = ?").get(row.reconciliationArtifactId, input.companyId, row.reconciliationSha256) as { filename: string } | undefined);
        const authorized = completed.authorization;
        const manifestAuthorization = completed.manifest.authorizedPlan;
        const valid = completed.policyVersion === 2 && completed.outcome === "completed" && completed.executionId === input.developerExecutionId && completed.companyId === input.companyId
          && authorized.authorizationId === row.authorizationId && authorized.taskId === input.taskId && authorized.companyId === input.companyId && authorized.workflowId === input.workflowId
          && JSON.stringify(manifestAuthorization) === JSON.stringify(authorized) && JSON.stringify(persistedManifest.authorizedPlan) === JSON.stringify(authorized)
          && completed.manifest.projectRevision.projectRevisionId === persistedManifest.projectRevision.projectRevisionId
          && completed.git.head === row.finalCommit && completed.git.tree === row.finalTree && completed.git.head === row.resultCommit && completed.git.tree === row.resultTree
          && row.deliveryArtifactId === row.reconciliationArtifactId && row.failureCode === null && artifact?.filename === `${input.developerExecutionId}-recovery.json`;
        return valid ? this.storedAuthorizedResult(input.developerExecutionId) ?? null : null;
      } catch (error) {
        this.logRecoveryFault(input, "repeat-read", error);
        return null;
      }
    }
    if (row.status !== "blocked" || row.failureCode !== "delivery-reconciliation-failed" || !row.beforeProviderArtifactId || !row.beforeProviderSha256 || !row.rawReportArtifactId || !row.rawReportSha256) return null;
    let stored: z.infer<typeof DeveloperReconciliationArtifactSchema>;
    let authorization: z.infer<typeof AuthorizedPlanSubjectSchema>;
    let manifest: EvidenceManifest;
    let rawReport: unknown;
    try {
      stored = DeveloperReconciliationArtifactSchema.parse(await readArtifactJson(row.reconciliationArtifactId, row.reconciliationSha256, "developer-reconciliation"));
      if (!isLegacyReceiptOnlyRecovery(stored)) return null;
      if (!stored.observations?.startingSha || !stored.observations.developerSessionId || !stored.observations.leadSessionId || stored.observations.processExitCode === undefined) return null;
      if (stored.observations.startingSha.toLowerCase() !== row.startingCommit.toLowerCase() || stored.observations.neutralBranch !== row.branchName || stored.provider.beforeSha256 !== row.beforeProviderSha256) return null;
      const authorizationRow = this.database.authQuery((db) => db.prepare("SELECT id AS authorizationId, task_id AS taskId, company_id AS companyId, project_id AS projectId, workflow_id AS workflowId, plan_revision AS planRevision, plan_artifact_id AS planArtifactId, plan_sha256 AS planSha256, authorization_kind AS authorizationKind, approval_decision_id AS approvalDecisionId, authorized_at AS authorizedAt FROM forge_plan_authorizations WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(row.authorizationId, input.taskId, input.companyId, input.workflowId) as Record<string, unknown> | undefined);
      authorization = AuthorizedPlanSubjectSchema.parse(authorizationRow);
      manifest = EvidenceManifestSchema.parse(await readArtifactJson(row.manifestArtifactId, row.manifestSha256, "developer-evidence-manifest"));
      rawReport = await readArtifactJson(row.rawReportArtifactId, row.rawReportSha256, "developer-delivery-raw");
      const providerArtifact = this.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'developer-provider-observation'").get(row.beforeProviderArtifactId, input.companyId) as { storagePath: string; sha256: string } | undefined);
      if (!providerArtifact) throw new Error("provider artifact unavailable");
      const providerBefore = JSON.parse((await this.artifacts.read({ companyId: input.companyId, storagePath: providerArtifact.storagePath, sha256: providerArtifact.sha256 })).toString("utf8")) as unknown;
      if (!providerBefore || typeof providerBefore !== "object" || (providerBefore as { sha256?: unknown }).sha256 !== row.beforeProviderSha256) return null;
      if (JSON.stringify(authorization) !== JSON.stringify(manifest.authorizedPlan) || stored.authorization.authorizationId !== authorization.authorizationId || stored.manifest.projectRevision.projectRevisionId !== manifest.projectRevision.projectRevisionId) return null;
    } catch (error) { this.logRecoveryFault(input, "eligibility-read", error); return null; }
    let ownedRow: (Record<string, unknown> & { legacy: number }) | undefined;
    try {
      ownedRow = this.database.authQuery((db) => db.prepare("SELECT id AS leaseId, lease_token_hash AS leaseTokenHash, task_id AS taskId, company_id AS companyId, project_id AS projectId, workflow_id AS workflowId, repository_path AS repositoryRoot, worktree_root AS worktreeRoot, worktree_path AS worktreePath, branch_name AS branchName, starting_sha AS startingSha, legacy, status FROM forge_issue_worktrees WHERE id = ? AND task_id = ? AND company_id = ? AND project_id = ? AND workflow_id = ?").get(row.worktreeLeaseId, input.taskId, input.companyId, authorization!.projectId, input.workflowId) as (Record<string, unknown> & { legacy: number }) | undefined);
    } catch (error) {
      this.logRecoveryFault(input, "worktree-query", error);
      return null;
    }
    if (!ownedRow || ownedRow.status === "released" || row.worktreePath !== ownedRow.worktreePath || row.branchName !== ownedRow.branchName || row.targetBaseSha.toLowerCase() !== String(ownedRow.startingSha).toLowerCase() || row.startingCommit.toLowerCase() !== String(ownedRow.startingSha).toLowerCase()) return null;
    let owned;
    try {
      owned = OwnedWorktreeSchema.parse({ ...ownedRow, legacy: ownedRow.legacy === 1 });
      const repositoryPath = await scopedRepository(this.config.repositoryRoot, owned.repositoryRoot);
      await scopedRepository(this.config.worktreeRoot, owned.worktreePath);
      const inspection = await this.worktrees.inspectOwned(owned, repositoryPath);
      if (!inspection.repositoryRegistered || !inspection.pathExists || inspection.pathIsSymlink || inspection.branch !== owned.branchName || inspection.head === null) return null;
    } catch (error) { this.logRecoveryFault(input, "worktree-inspection", error); return null; }
    let guard: Awaited<ReturnType<typeof createGitCommandGuard>> | undefined;
    try {
      const acceptedRevision = this.loadAcceptedVerificationRevision(input, manifest!);
      guard = await createGitCommandGuard(this.config.runtimeRoot);
      const independentVerification = await runPinnedVerification({ worktreePath: owned.worktreePath, setupCommand: acceptedRevision.setupCommand, verificationCommand: acceptedRevision.verificationCommand }, { guard });
      const git = await collectDeveloperGitObservation(owned.worktreePath, owned.startingSha);
      const after = await this.observeProvider({ companyId: input.companyId, executionId: input.developerExecutionId, phase: "after", cwd: owned.repositoryRoot, repository: manifest!.projectRevision.repositoryIdentity });
      const reconciliation = reconcileDeveloperDelivery({ executionId: input.developerExecutionId, companyId: input.companyId, report: rawReport, independentVerification, git, startingSha: stored!.observations.startingSha, neutralBranch: stored!.observations.neutralBranch, providerBeforeSha256: row.beforeProviderSha256, providerAfterSha256: after.observation?.sha256 ?? null, processExitCode: stored!.observations.processExitCode, developerSessionId: stored!.observations.developerSessionId, leadSessionId: stored!.observations.leadSessionId, authorization: authorization!, manifest: manifest!, verificationProjectRevisionId: acceptedRevision.projectRevisionId });
      if (reconciliation.outcome !== "completed") return null;
      const artifact = await this.artifacts.putIdempotent(input.companyId, "developer-reconciliation", `${input.developerExecutionId}:reconciliation:v3:recovery:${reconciliation.sha256}`, { filename: `${input.developerExecutionId}-recovery.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(reconciliation), "utf8") });
      this.database.authTransaction((db) => {
        for (const candidate of [after.artifact, artifact]) registerArtifact(db, candidate);
        const execution = db.prepare("UPDATE forge_developer_executions SET status = 'completed', current_step = NULL, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, failure_code = NULL, failure_summary = NULL WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'blocked' AND failure_code = 'delivery-reconciliation-failed' AND NOT EXISTS (SELECT 1 FROM forge_developer_executions successor WHERE successor.supersedes_execution_id = forge_developer_executions.id)").run(git.head, git.tree, git.status ? "dirty" : "clean", artifact.id, input.developerExecutionId, input.taskId, input.companyId, input.workflowId);
        if (execution.changes !== 1) throw new StaleRecovery("developer recovery execution CAS conflict");
        releaseDeveloperExecutionLease(db, input.developerExecutionId);
        const truth = db.prepare("UPDATE forge_developer_execution_truth SET after_provider_artifact_id = ?, after_provider_sha256 = ?, reconciliation_artifact_id = ?, reconciliation_sha256 = ?, final_commit = ?, final_tree = ? WHERE execution_id = ? AND reconciliation_artifact_id = ? AND reconciliation_sha256 = ?").run(after.artifact.id, after.observation?.sha256 ?? null, artifact.id, artifact.sha256, git.head, git.tree, input.developerExecutionId, row.reconciliationArtifactId, row.reconciliationSha256);
        if (truth.changes !== 1) throw new StaleRecovery("developer recovery truth CAS conflict");
      });
      return this.storedAuthorizedResult(input.developerExecutionId) ?? null;
    } catch (error) {
      if (!(error instanceof StaleRecovery)) this.logRecoveryFault(input, "reconcile", error);
      return null;
    } finally { await guard?.cleanup(); }
  }

  private logRecoveryFault(input: { taskId: string; companyId: string; workflowId: string; developerExecutionId: string }, phase: string, error: unknown): void {
    const redacted = String(redact(error instanceof Error ? error.message : String(error))).trim();
    const summary = toSafeSummary(redacted || "unknown error");
    new StructuredLogger().error("Developer stored-delivery recovery fault", { workflowId: input.workflowId, issueId: input.taskId, companyId: input.companyId }, { executionId: input.developerExecutionId, phase, error: summary });
  }

  private storedAuthorizedResult(executionId: string): DeveloperExecutionResult | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT e.status, e.session_ref AS sessionRef, e.worktree_path AS worktreePath, e.branch_name AS branchName, e.target_base_sha AS targetBaseSha, e.current_step AS currentStep, e.result_commit AS resultCommit, e.result_tree AS resultTree, e.dirty_state AS dirtyState, e.delivery_artifact_id AS deliveryArtifactId, e.evidence_artifact_id AS evidenceArtifactId, e.failure_code AS failureCode, e.failure_summary AS failureSummary, t.reconciliation_artifact_id AS reconciliationArtifactId, t.before_provider_artifact_id AS providerObservationArtifactId
      FROM forge_developer_executions e JOIN forge_developer_execution_truth t ON t.execution_id = e.id WHERE e.id = ?`).get(executionId) as { status: string; sessionRef: string | null; worktreePath: string; branchName: string; targetBaseSha: string; currentStep: number | null; resultCommit: string | null; resultTree: string | null; dirtyState: "clean" | "dirty" | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null; failureCode: string | null; failureSummary: string | null; reconciliationArtifactId: string | null; providerObservationArtifactId: string | null } | undefined);
    if (!row || !["completed", "blocked"].includes(row.status) || !row.sessionRef || !row.resultCommit || !row.resultTree || !row.dirtyState || !row.deliveryArtifactId || !row.evidenceArtifactId || !row.reconciliationArtifactId) return undefined;
    return { developerExecutionId: executionId, developerSessionRef: row.sessionRef, worktreePath: row.worktreePath, branchName: row.branchName, targetBaseSha: row.targetBaseSha, currentStep: row.currentStep, resultCommit: row.resultCommit, resultTree: row.resultTree, dirtyState: row.dirtyState, deliveryArtifactId: row.deliveryArtifactId, evidenceArtifactId: row.evidenceArtifactId, deliverySummary: row.failureSummary ?? (row.status === "completed" ? "Developer delivery reconciled" : "Developer delivery was blocked by reconciliation"), outcome: row.status as "completed" | "blocked", failureCode: row.failureCode, reconciliationArtifactId: row.reconciliationArtifactId, ...(row.providerObservationArtifactId ? { providerObservationArtifactId: row.providerObservationArtifactId } : {}) };
  }

  private async observeProvider(input: { companyId: string; executionId: string; phase: "before" | "after"; cwd: string; repository: string }): Promise<{ observation: GithubMutationSurface | null; artifact: StoredArtifact }> {
    let observation: GithubMutationSurface | null = null;
    try {
      if (!this.githubObservation.observeMutationSurface) throw new Error("Provider observation is unavailable");
      observation = await this.githubObservation.observeMutationSurface({ cwd: input.cwd, nameWithOwner: input.repository });
    } catch (error) {
      const message = toSafeSummary(String(redact(error instanceof Error ? error.message : String(error))).trim() || "unknown error");
      new StructuredLogger().warn("Developer provider observation failed", {}, { executionId: input.executionId, phase: input.phase, error: message });
    }
    const artifact = await this.artifacts.put(input.companyId, "developer-provider-observation", { filename: `${input.executionId}-${input.phase}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(observation ?? { available: false, reason: "provider-observation-unavailable" }), "utf8") });
    return { observation, artifact };
  }

  private loadAcceptedVerificationRevision(input: { taskId: string; companyId: string; workflowId: string }, manifest: EvidenceManifest) {
    const row = this.database.authQuery((db) => db.prepare(`SELECT r.id AS projectRevisionId, r.normalized_json AS normalizedJson
      FROM forge_tasks t
      JOIN forge_project_revisions r ON r.id = (SELECT current.id FROM forge_project_revisions current WHERE current.project_id = t.project_id AND current.state = 'accepted' ORDER BY current.revision DESC LIMIT 1)
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_id = ?`).get(input.taskId, input.companyId, input.workflowId, manifest.projectRevision.projectId) as { projectRevisionId: string; normalizedJson: string } | undefined);
    if (!row) throw new AgentFailure("pinned-revision-missing", "The accepted project revision is unavailable for deterministic verification");
    let revision;
    try { revision = parseAcceptedProjectRevision(row.normalizedJson); } catch { throw new AgentFailure("pinned-revision-missing", "The accepted project revision does not contain valid pinned verification commands"); }
    return { ...revision, projectRevisionId: row.projectRevisionId };
  }

  private async runAuthorized(input: DeveloperExecutionActivityInput & Partial<DeveloperSupervisorActivityIdentity> & { authorization: NonNullable<DeveloperExecutionActivityInput["authorization"]> }): Promise<DeveloperExecutionResult> {
    const authorization = AuthorizedPlanSubjectSchema.parse(input.authorization);
    if (authorization.taskId !== input.taskId || authorization.companyId !== input.companyId || authorization.projectId !== input.projectId || authorization.workflowId !== input.workflowId || authorization.planRevision !== input.planRevision || authorization.planArtifactId !== input.leadOutputArtifactId) throw new AgentFailure("plan-authorization-mismatch", "Developer authorization coordinates do not match the requested issue plan");
    const profile = this.executionProfile(input, input.roleProfiles.builder);
    if (!profile || profile.provider !== this.provider.id) throw new AgentFailure("developer-profile-unavailable", "Developer execution requires an allowed Codex profile");
    const attempt = input.developerAttempt ?? Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    const executionId = input.developerTurnExecutionId ?? input.executionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const stored = this.storedAuthorizedResult(executionId);
    if (stored) return stored;
    const evidenceBuilder = new DeveloperEvidenceBuilder(this.database, this.config);
    const evidence = await evidenceBuilder.build({ subject: authorization, executionId });
    const project = evidence.manifest.projectRevision;
    const repositoryPath = await scopedRepository(this.config.repositoryRoot, project.repositoryPath);
    const worktreeRoot = await scopedRepository(this.config.worktreeRoot, project.worktreeRoot);
    const existingOwned = this.database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath, branch_name AS branchName FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND status <> 'released'").get(input.taskId, input.companyId, input.workflowId) as { worktreePath: string; branchName: string } | undefined);
    const owned = reserveOwnedWorktree(this.database, { taskId: input.taskId, companyId: input.companyId, projectId: input.projectId, workflowId: input.workflowId, repositoryRoot: repositoryPath, worktreeRoot, worktreePath: existingOwned?.worktreePath ?? resolve(worktreeRoot, input.taskId), branchName: existingOwned?.branchName ?? buildGitBranchName({ branchSlug: evidence.gitPresentation.branchSlug, taskId: input.taskId }), startingSha: project.targetSha });
    const inspection = input.reuseWorktree && owned.status === "active"
      ? await this.worktrees.inspectOwned(owned)
      : await this.worktrees.materialize(owned);
    if (input.reuseWorktree && owned.status === "active") {
      await this.worktrees.reuse({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha: owned.startingSha, branchName: owned.branchName });
    }
    const activeWorktree = owned.status === "active" ? owned : activateOwnedWorktree(this.database, inspection);
    const startingTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: activeWorktree.worktreePath, timeout: 8_000, maxBuffer: 4 * 1024 })).stdout.trim();
    const before = await this.observeProvider({ companyId: input.companyId, executionId, phase: "before", cwd: repositoryPath, repository: project.repositoryIdentity });
    const beforeObservation = before.observation;
    const registeredExecution = this.database.authQuery((db) => db.prepare("SELECT 1 FROM forge_developer_executions WHERE id = ?").get(executionId));
    if (!registeredExecution) await evidenceBuilder.cleanup(activeWorktree.worktreePath, executionId);
    const staged = await evidenceBuilder.stage(evidence.manifest, activeWorktree.worktreePath, executionId);
    const guard = await createGitCommandGuard(this.config.runtimeRoot);
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => {
      registerArtifact(db, before.artifact);
      db.prepare("INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, started_at, heartbeat_at, current_step) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, activeWorktree.branchName, activeWorktree.worktreePath, activeWorktree.startingSha, `wrapper_${randomBytes(12).toString("hex")}`, guard.directory, input.supersedesExecutionId ?? null, startedAt, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, undefined, activeWorktree.worktreePath);
      db.prepare("INSERT OR IGNORE INTO forge_developer_execution_truth (execution_id, authorization_id, worktree_lease_id, manifest_artifact_id, manifest_sha256, boundary_mode, before_provider_artifact_id, before_provider_sha256, starting_commit, starting_tree) VALUES (?, ?, ?, ?, ?, 'owner_controlled_observed', ?, ?, ?, ?)").run(executionId, authorization.authorizationId, activeWorktree.leaseId, evidence.artifact.id, evidence.artifact.sha256, before.artifact.id, beforeObservation?.sha256 ?? null, inspection.head ?? activeWorktree.startingSha, startingTree);
    });
    const steps = evidence.manifest.verificationCommands.map((step) => `${step.stepNumber}: ${step.commands.join(" && ") || "(file/Git state verification)"}`).join("\n");
    const prompt = buildDeveloperExecutionPrompt({ executionId, reuseWorktree: Boolean(input.reuseWorktree), startingSha: activeWorktree.startingSha, verificationSteps: steps });
    const outputLines: string[] = [];
    let sessionRef: string | undefined;
    let rawSessionId: string | undefined;
    let parserState: unknown;
    try {
      const result = await this.processRunner({
        command: this.command,
        args: this.provider.buildTurnArgs({ prompt, profile, imagePaths: staged.imagePaths }),
        stdin: prompt,
        cwd: activeWorktree.worktreePath,
        env: withWorktreeMiseTrust(guard.env, activeWorktree.worktreePath),
        detached: true,
        onStart: async (pid, processStartedAt) => { const identity = await processStartIdentity(pid, processStartedAt); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', process_pid = ?, process_group_id = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, pid, identity, this.now().toISOString(), executionId)); },
        onLine: async (line) => {
          outputLines.push(line);
          const incremental = this.provider.parseExecutionTranscript([line], { executionId, attempt, worktreePath: activeWorktree.worktreePath, ...(parserState ? { state: parserState } : {}) });
          parserState = incremental.parserState;
          this.persistDeveloperReceipts(executionId, incremental.receipts);
          const event = this.provider.parseEvent(line);
          if (event.threadId && rawSessionId && event.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "Developer returned a different session identity");
          if (event.threadId && !rawSessionId) { rawSessionId = event.threadId; sessionRef = await this.sessionStore.create(rawSessionId); }
          await this.heartbeat(executionId);
        },
      });
      const parsed = this.provider.parseExecutionTranscript(outputLines, { executionId, attempt, worktreePath: activeWorktree.worktreePath });
      if (parsed.threadId && rawSessionId && parsed.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "Developer returned conflicting session identities");
      rawSessionId ??= parsed.threadId;
      sessionRef ??= rawSessionId ? await this.sessionStore.create(rawSessionId) : undefined;
      const leadSessionId = await this.sessionStore.read(input.leadSessionRef).catch(() => undefined);
      await evidenceBuilder.cleanup(activeWorktree.worktreePath, executionId).catch(() => undefined);
      const acceptedRevision = this.loadAcceptedVerificationRevision(input, evidence.manifest);
      const independentVerification = await runPinnedVerification({ worktreePath: activeWorktree.worktreePath, setupCommand: acceptedRevision.setupCommand, verificationCommand: acceptedRevision.verificationCommand }, { guard });
      const git = await collectDeveloperGitObservation(activeWorktree.worktreePath, activeWorktree.startingSha);
      const after = await this.observeProvider({ companyId: input.companyId, executionId, phase: "after", cwd: repositoryPath, repository: project.repositoryIdentity });
      const rawReportArtifact = await this.artifacts.put(input.companyId, "developer-delivery-raw", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(parsed.finalReport ?? null), "utf8") });
      const gitArtifact = await this.artifacts.put(input.companyId, "developer-git-snapshot", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(git), "utf8") });
      const receipts = parsed.receipts.map((receipt) => ExecutionReceiptSchema.parse(receipt));
      receipts.push(ExecutionReceiptSchema.parse({ eventId: `receipt_${createHash("sha256").update(`${executionId}:git-snapshot`).digest("hex").slice(0, 32)}`, executionId, attempt, sequence: Math.max(0, ...receipts.map((receipt) => receipt.sequence)) + 1, kind: "git_snapshot", stepNumber: null, sourceItemId: null, occurredAt: this.now().toISOString(), summary: "Final Git snapshot", exitCode: null, artifactId: gitArtifact.id, artifactSha256: gitArtifact.sha256, idempotencyKey: `git-snapshot:${gitArtifact.id}` }));
      const reconciliation = reconcileDeveloperDelivery({ executionId, companyId: input.companyId, report: parsed.finalReport, independentVerification, git, startingSha: activeWorktree.startingSha, neutralBranch: activeWorktree.branchName, providerBeforeSha256: beforeObservation?.sha256 ?? null, providerAfterSha256: after.observation?.sha256 ?? null, processExitCode: result.exitCode, malformedLines: parsed.malformedLines, developerSessionId: rawSessionId ?? null, leadSessionId: leadSessionId ?? null, authorization, manifest: evidence.manifest, verificationProjectRevisionId: acceptedRevision.projectRevisionId });
      const deliverySummary = developerReconciliationSummary(reconciliation);
      const reconciliationArtifact = await this.artifacts.putIdempotent(input.companyId, "developer-reconciliation", `${executionId}:reconciliation:v3`, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(reconciliation), "utf8") });
      this.database.authTransaction((db) => {
        for (const artifact of [after.artifact, rawReportArtifact, gitArtifact, reconciliationArtifact]) registerArtifact(db, artifact);
        for (const receipt of receipts) db.prepare("INSERT OR IGNORE INTO forge_developer_execution_events (event_id, execution_id, attempt, sequence, kind, step_number, source_item_id, occurred_at, summary, exit_code, artifact_id, artifact_sha256, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(receipt.eventId, executionId, receipt.attempt, receipt.sequence, receipt.kind, receipt.stepNumber, receipt.sourceItemId, receipt.occurredAt, receipt.summary, receipt.exitCode, receipt.artifactId, receipt.artifactSha256, receipt.idempotencyKey);
        db.prepare("UPDATE forge_developer_execution_truth SET after_provider_artifact_id = ?, after_provider_sha256 = ?, raw_report_artifact_id = ?, raw_report_sha256 = ?, reconciliation_artifact_id = ?, reconciliation_sha256 = ?, final_commit = ?, final_tree = ? WHERE execution_id = ?").run(after.artifact.id, after.observation?.sha256 ?? null, rawReportArtifact.id, rawReportArtifact.sha256, reconciliationArtifact.id, reconciliationArtifact.sha256, git.head, git.tree, executionId);
        const execution = db.prepare("UPDATE forge_developer_executions SET status = ?, session_ref = ?, finished_at = ?, heartbeat_at = ?, current_step = NULL, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ?, failure_code = ?, failure_summary = ? WHERE id = ? AND status IN ('starting', 'running')").run(reconciliation.outcome, sessionRef ?? `unavailable_${executionId}`, this.now().toISOString(), this.now().toISOString(), git.head, git.tree, git.status ? "dirty" : "clean", reconciliationArtifact.id, evidence.artifact.id, reconciliation.failureCode, reconciliation.outcome === "blocked" ? deliverySummary : null, executionId);
        if (execution.changes === 1) releaseDeveloperExecutionLease(db, executionId);
      });
      this.persistDeveloperReceipts(executionId, receipts);
      return { developerExecutionId: executionId, developerSessionRef: sessionRef ?? `unavailable_${executionId}`, worktreePath: activeWorktree.worktreePath, branchName: activeWorktree.branchName, targetBaseSha: activeWorktree.startingSha, currentStep: null, resultCommit: git.head, resultTree: git.tree, dirtyState: git.status ? "dirty" : "clean", deliveryArtifactId: reconciliationArtifact.id, evidenceArtifactId: evidence.artifact.id, deliverySummary, outcome: reconciliation.outcome, failureCode: reconciliation.failureCode, reconciliationArtifactId: reconciliationArtifact.id, providerObservationArtifactId: before.artifact.id };
    } catch (error) {
      if (isSupervisorTerminalError(error)) throw error;
      const failure = error instanceof AgentFailure ? error : new AgentFailure("developer-execution-failed", toSafeSummary(`Developer execution could not be reconciled: ${String(redact(error instanceof Error ? error.message : String(error)))}`));
      this.database.authTransaction((db) => {
        const execution = db.prepare("UPDATE forge_developer_executions SET status = CASE WHEN status IN ('starting', 'running') THEN 'blocked' ELSE status END, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ?").run(failure.code, failure.message, this.now().toISOString(), executionId);
        if (execution.changes === 1) releaseDeveloperExecutionLease(db, executionId);
      });
      throw failure;
    } finally {
      await evidenceBuilder.cleanup(activeWorktree.worktreePath, executionId).catch(() => undefined);
      await guard.cleanup();
    }
  }

  async runMergeConflictResolution(rawInput: MergeConflictResolutionActivityInput & Partial<DeveloperSupervisorActivityIdentity>): Promise<MergeConflictResolutionActivityResult> {
    const input = rawInput;
    const prior = this.database.authQuery((db) => db.prepare(`SELECT id, status, session_ref, branch_name, worktree_path, delivery_artifact_id, evidence_artifact_id
      FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; status: string; session_ref: string | null; branch_name: string; worktree_path: string; delivery_artifact_id: string | null; evidence_artifact_id: string | null } | undefined);
    const planRow = this.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'merge-conflict-plan'").get(input.planArtifactId, input.companyId) as { storage_path: string; sha256: string } | undefined);
    if (!prior || !planRow || !["completed", "blocked"].includes(prior.status) || prior.session_ref !== input.developerSessionRef || prior.branch_name !== input.branchName || prior.worktree_path !== input.worktreePath) {
      throw new AgentFailure("merge-resolution-identity-mismatch", "Merge-conflict resolution coordinates do not match the owned Developer worktree");
    }
    let conflict: ForwardMergeConflictArtifact;
    const conflictRow = this.database.authQuery((db) => db.prepare("SELECT a.storage_path, a.sha256 FROM forge_artifacts a JOIN forge_forward_merges f ON f.conflict_artifact_id = a.id AND f.id = ? AND f.task_id = ? AND f.company_id = ? WHERE a.id = ? AND a.company_id = ? AND a.kind = 'forward-merge-conflict'").get(input.forwardMergeId, input.taskId, input.companyId, input.conflictArtifact.id, input.companyId) as { storage_path: string; sha256: string } | undefined);
    if (!conflictRow || conflictRow.sha256 !== input.conflictArtifact.sha256) throw new AgentFailure("merge-resolution-evidence-missing", "Forward-merge conflict evidence is unavailable");
    try {
      conflict = ForwardMergeConflictArtifactSchema.parse(JSON.parse((await this.artifacts.read({ companyId: input.companyId, storagePath: conflictRow.storage_path, sha256: conflictRow.sha256 })).toString("utf8")));
    } catch {
      throw new AgentFailure("merge-resolution-evidence-corrupt", "Forward-merge conflict evidence failed integrity validation");
    }
    if (conflict.priorHead.toLowerCase() !== input.priorHead.toLowerCase() || conflict.observedBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase() || conflict.conflictFiles.length !== input.conflictFileCount) throw new AgentFailure("merge-resolution-identity-mismatch", "Forward-merge conflict evidence does not match the owned merge");
    const mergeState = await this.mergeState(input.worktreePath);
    if (mergeState.head !== input.priorHead || mergeState.mergeHead !== input.targetBaseSha || JSON.stringify(mergeState.conflicts) !== JSON.stringify([...conflict.conflictFiles].sort())) {
      throw new AgentFailure("merge_state_ownership_mismatch", "The in-progress merge no longer matches the recorded forward-merge operation");
    }
    const plan = (await this.artifacts.read({ companyId: input.companyId, storagePath: planRow.storage_path, sha256: planRow.sha256 })).toString("utf8");
    const profile = this.executionProfile(input);
    if (profile && profile.provider !== this.provider.id) throw new AgentFailure("developer-profile-unavailable", "Developer profile is unavailable for merge-conflict resolution");
    const rawSessionId = await this.sessionStore.read(input.developerSessionRef);
    const executionId = input.developerTurnExecutionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const attempt = input.developerAttempt ?? Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    const existing = this.database.authQuery((db) => db.prepare("SELECT task_id AS taskId, company_id AS companyId, workflow_id AS workflowId, plan_revision AS planRevision, attempt, status, branch_name AS branchName, worktree_path AS worktreePath, target_base_sha AS targetBaseSha, supersedes_execution_id AS supersedesExecutionId, session_ref AS sessionRef FROM forge_developer_executions WHERE id = ?").get(executionId) as { taskId: string; companyId: string; workflowId: string; planRevision: number; attempt: number; status: string; branchName: string; worktreePath: string; targetBaseSha: string; supersedesExecutionId: string | null; sessionRef: string | null } | undefined);
    if (existing && (existing.taskId !== input.taskId || existing.companyId !== input.companyId || existing.workflowId !== input.workflowId || existing.planRevision !== input.planRevision || existing.attempt !== attempt || existing.branchName !== input.branchName || existing.worktreePath !== input.worktreePath || existing.targetBaseSha !== input.targetBaseSha || existing.supersedesExecutionId !== input.developerExecutionId || existing.sessionRef !== input.developerSessionRef || !["starting", "running"].includes(existing.status))) throw new AgentFailure("developer-execution-identity-conflict", "The deterministic merge-resolution ID is already bound to different coordinates", { nonRetryable: true });
    const guard = await createGitCommandGuard(this.config.runtimeRoot);
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => {
      db.prepare("INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, session_ref, started_at, heartbeat_at, execution_kind) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'forward_merge')").run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, input.branchName, input.worktreePath, input.targetBaseSha, `wrapper_${randomBytes(12).toString("hex")}`, guard.directory, input.developerExecutionId, input.developerSessionRef, startedAt, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, input.developerSessionRef, input.worktreePath);
    });
    const evidenceLines: string[] = [];
    const expectedRawSessionId = rawSessionId;
    const mergePrompt = this.mergeConflictResolutionPrompt(plan, input, conflict);
    let verificationArtifact: StoredArtifact | undefined;
    let completedMerge: { headSha: string; treeSha: string } | undefined;
    try {
      const result = await this.processRunner({
        command: this.command,
        args: this.provider.buildTurnArgs({ prompt: mergePrompt, resumeSessionId: rawSessionId, profile }),
        stdin: mergePrompt,
        cwd: input.worktreePath,
        env: withWorktreeMiseTrust(guard.env, input.worktreePath),
        detached: true,
        onStart: async (pid, processStartedAt) => { const identity = await processStartIdentity(pid, processStartedAt); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', process_pid = ?, process_group_id = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, pid, identity, this.now().toISOString(), executionId)); },
        onLine: async (line) => {
          const event = this.provider.parseEvent(line);
          if (event.threadId && event.threadId !== expectedRawSessionId) throw new AgentFailure("session-identity-conflict", "Merge-conflict resolution returned a different Developer session identity");
          evidenceLines.push(safeJsonLine(line));
          await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET heartbeat_at = ? WHERE id = ?").run(this.now().toISOString(), executionId));
        },
      });
      if (result.exitCode !== 0) throw this.provider.classifyProcessFailure(result, evidenceLines);
      const report = parseMergeConflictResolutionReport(evidenceLines, this.provider);
      const missingFiles = conflict.conflictFiles.filter((file) => !report.resolvedFiles.includes(file));
      if (missingFiles.length || report.blocker !== null) throw new AgentFailure("merge-resolution-incomplete", missingFiles.length ? `The Developer did not resolve: ${missingFiles.join(", ")}` : report.blocker ?? "Merge-conflict resolution is blocked");
      const gitState = await this.worktrees.inspectDelivery(input.worktreePath);
      completedMerge = { headSha: gitState.headSha, treeSha: gitState.treeSha };
      const parents = (await execFileAsync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: input.worktreePath, timeout: 8_000, maxBuffer: 4 * 1024 })).stdout.trim().split(/\s+/);
      if (gitState.branchName !== input.branchName || gitState.dirtyState !== "clean" || gitState.headSha.toLowerCase() !== report.resultCommit.toLowerCase() || gitState.treeSha.toLowerCase() !== report.resultTree.toLowerCase() || parents.length !== 3 || (parents[1] ?? "").toLowerCase() !== input.priorHead.toLowerCase() || (parents[2] ?? "").toLowerCase() !== input.targetBaseSha.toLowerCase()) {
        throw new AgentFailure("merge-resolution-revision-invalid", "Developer resolution did not produce the required clean two-parent merge commit");
      }
      const revision = this.database.authQuery((db) => db.prepare("SELECT r.normalized_json FROM forge_tasks t JOIN forge_project_revisions r ON r.id = (SELECT current.id FROM forge_project_revisions current WHERE current.project_id = t.project_id AND current.state = 'accepted' ORDER BY current.revision DESC LIMIT 1) WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) as { normalized_json: string } | undefined);
      if (!revision) throw new AgentFailure("artifact_unavailable", "The accepted project revision is unavailable for deterministic verification");
      let parsed;
      try { parsed = parseAcceptedProjectRevision(revision.normalized_json); } catch { throw new AgentFailure("artifact_unavailable", "The accepted project revision does not contain valid pinned verification commands"); }
      const verification = await runPinnedVerification({ worktreePath: input.worktreePath, setupCommand: parsed.setupCommand, verificationCommand: parsed.verificationCommand }, { guard });
      const verificationArtifactRecord = await this.artifacts.putIdempotent(input.companyId, "forward-merge-verification", `${executionId}:verification`, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(verification), "utf8") });
      verificationArtifact = verificationArtifactRecord;
      const afterVerification = await this.worktrees.inspectDelivery(input.worktreePath);
      const afterParents = (await execFileAsync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: input.worktreePath, timeout: 8_000, maxBuffer: 4 * 1024 })).stdout.trim().split(/\s+/);
      if (afterVerification.branchName !== input.branchName || afterVerification.headSha.toLowerCase() !== gitState.headSha.toLowerCase() || afterVerification.treeSha.toLowerCase() !== gitState.treeSha.toLowerCase() || afterVerification.dirtyState !== "clean" || afterParents.length !== 3 || afterParents[1]?.toLowerCase() !== input.priorHead.toLowerCase() || afterParents[2]?.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new AgentFailure("merge_state_ownership_mismatch", "Pinned verification changed the forward-merge delivery");
      if (verification.outcome !== "passed") throw new AgentFailure(verification.code ?? "verification_failed", verification.summary);
      const resolutionArtifact = await this.artifacts.putIdempotent(input.companyId, "merge-conflict-resolution", `${executionId}:resolution`, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(report, null, 2), "utf8") });
      const deliveryArtifact = await this.artifacts.putIdempotent(input.companyId, "forward-merge-delivery", `${executionId}:delivery`, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, checkId: input.forwardMergeId, priorHead: input.priorHead, priorTree: conflict.priorTree, targetBaseSha: input.targetBaseSha, resultCommit: gitState.headSha, resultTree: gitState.treeSha, developerExecutionId: executionId, supersedesDeveloperExecutionId: input.developerExecutionId, supersededDeliveryArtifactId: prior.delivery_artifact_id, supersededEvidenceArtifactId: prior.evidence_artifact_id, verificationArtifactId: verificationArtifactRecord.id, verification }, null, 2), "utf8") });
      const evidence = await this.artifacts.putIdempotent(input.companyId, "agent-evidence", `${executionId}:evidence`, { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        const artifacts = [evidence, resolutionArtifact, verificationArtifactRecord, deliveryArtifact];
        for (const artifact of artifacts) registerArtifact(db, artifact);
        db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, gitState.headSha, gitState.treeSha, deliveryArtifact.id, evidence.id, executionId);
        releaseDeveloperExecutionLease(db, executionId);
        db.prepare("UPDATE forge_forward_merges SET status = 'merged', merge_commit = ?, tree = ?, result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, verification_artifact_sha256 = ?, delivery_artifact_id = ?, delivery_artifact_sha256 = ?, updated_at = ? WHERE task_id = ? AND company_id = ? AND conflict_artifact_id = ?").run(gitState.headSha, gitState.treeSha, gitState.headSha, gitState.treeSha, executionId, verificationArtifactRecord.id, verificationArtifactRecord.sha256, deliveryArtifact.id, deliveryArtifact.sha256, now, input.taskId, input.companyId, input.conflictArtifact.id);
        db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, result_commit = ?, result_tree = ?, status = 'completed', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, gitState.headSha, gitState.treeSha, now, input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
      });
      return { developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, resultCommit: gitState.headSha, resultTree: gitState.treeSha, deliveryArtifactId: deliveryArtifact.id, deliveryArtifactSha256: deliveryArtifact.sha256, evidenceArtifactId: evidence.id, evidenceArtifactSha256: evidence.sha256, verificationArtifactId: verificationArtifactRecord.id, verificationArtifactSha256: verificationArtifactRecord.sha256, summary: report.summary };
    } catch (error) {
      if (isSupervisorTerminalError(error)) throw error;
      const failure = error instanceof AgentFailure ? error : new AgentFailure("merge-resolution-failed", "Codex Developer merge-conflict resolution failed");
      const evidence = await this.artifacts.putIdempotent(input.companyId, "agent-evidence", `${executionId}:evidence`, { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      if (verificationArtifact && completedMerge && ["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(failure.code)) {
        const blockedVerificationArtifact = verificationArtifact;
        const blockedMerge = completedMerge;
        const now = this.now().toISOString();
        this.database.authTransaction((db) => {
          for (const artifact of [evidence, blockedVerificationArtifact]) db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
          db.prepare("UPDATE forge_developer_executions SET status = 'blocked', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, blockedMerge.headSha, blockedMerge.treeSha, failure.code, failure.message, evidence.id, executionId);
          releaseDeveloperExecutionLease(db, executionId);
          db.prepare("UPDATE forge_forward_merges SET status = 'merged', merge_commit = ?, tree = ?, result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, verification_artifact_sha256 = ?, failure_code = ?, failure_summary = ?, updated_at = ? WHERE task_id = ? AND company_id = ? AND conflict_artifact_id = ?").run(blockedMerge.headSha, blockedMerge.treeSha, blockedMerge.headSha, blockedMerge.treeSha, executionId, blockedVerificationArtifact.id, blockedVerificationArtifact.sha256, failure.code, failure.message, now, input.taskId, input.companyId, input.conflictArtifact.id);
          db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, result_commit = ?, result_tree = ?, status = 'blocked', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, blockedMerge.headSha, blockedMerge.treeSha, now, input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
        });
        return { outcome: "verification_blocked", developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, resultCommit: blockedMerge.headSha, resultTree: blockedMerge.treeSha, evidenceArtifactId: evidence.id, verificationArtifact: { id: blockedVerificationArtifact.id, sha256: blockedVerificationArtifact.sha256, kind: "forward-merge-verification" as const }, code: failure.code as "verification_failed" | "verification_timed_out" | "verification_evidence_too_large", summary: failure.message };
      }
      this.database.authTransaction((db) => {
        registerArtifact(db, evidence);
        db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId);
        releaseDeveloperExecutionLease(db, executionId);
        db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, status = 'blocked', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, this.now().toISOString(), input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
      });
      throw failure;
    } finally { await guard.cleanup(); }
  }

  private async mergeState(worktreePath: string): Promise<{ head: string; mergeHead: string; conflicts: string[] }> {
    const run = async (args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd: worktreePath, timeout: 8_000, maxBuffer: 128 * 1024 })).stdout.trim();
    const [head, mergeHead, files] = await Promise.all([
      run(["rev-parse", "HEAD"]),
      run(["rev-parse", "MERGE_HEAD"]),
      run(["diff", "--name-only", "--diff-filter=U"]),
    ]);
    return { head, mergeHead, conflicts: files.split("\n").filter(Boolean).sort() };
  }

  async runRepair(rawInput: DeveloperRepairActivityInput & Partial<DeveloperSupervisorActivityIdentity>): Promise<DeveloperRepairActivityResult> {
    const input = { ...DeveloperRepairActivityInputSchema.parse(rawInput), ...(rawInput.developerTurnExecutionId ? { developerTurnExecutionId: rawInput.developerTurnExecutionId } : {}), ...(rawInput.developerAttempt ? { developerAttempt: rawInput.developerAttempt } : {}), ...(rawInput.turnKind ? { turnKind: rawInput.turnKind } : {}) };
    let repairPlan = input.repairPlan;
    if (input.repairPlanArtifactId) {
      const plan = this.database.authQuery((db) => db.prepare("SELECT filename, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'delivery-repair-plan'").get(input.repairPlanArtifactId, input.companyId) as { filename: string; storagePath: string; sha256: string } | undefined);
      if (!plan || plan.sha256 !== input.repairPlanSha256) throw new AgentFailure("repair-plan-integrity", "The Lead repair-plan artifact is unavailable or has the wrong hash");
      repairPlan = (await this.artifacts.read({ companyId: input.companyId, storagePath: plan.storagePath, sha256: plan.sha256 })).toString("utf8");
    }
    if (input.repairAuthority !== "delivery_review" && !input.repairPlanArtifactId) throw new AgentFailure("repair-authority-mismatch", "This repair authority requires a source-bound Lead repair-plan artifact");
    if (!repairPlan) throw new AgentFailure("repair-plan-missing", "A verified Lead repair plan is required");
    if (input.repairAuthority !== "delivery_review") this.validateRepairAuthority(input, parseRepairAuthorityEnvelope(repairPlan));
    const prior = this.database.authQuery((db) => db.prepare(`SELECT id, status, session_ref, branch_name, worktree_path, target_base_sha, result_commit, result_tree, delivery_artifact_id, evidence_artifact_id
      FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; status: string; session_ref: string | null; branch_name: string; worktree_path: string; target_base_sha: string; result_commit: string | null; result_tree: string | null; delivery_artifact_id: string | null; evidence_artifact_id: string | null } | undefined);
    const review = this.database.authQuery((db) => db.prepare(`SELECT id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, session_ref, outcome
      FROM forge_delivery_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.reviewId, input.taskId, input.companyId, input.workflowId) as { id: string; task_id: string; company_id: string; workflow_id: string; plan_revision: number; base_sha: string; subject_commit: string; subject_tree: string; session_ref: string; outcome: string } | undefined);
    if (!prior || !review) throw new AgentFailure("repair-identity-mismatch", "Developer repair coordinates do not match the immutable review subject");
    const priorSubject = DeliveryReviewSubjectSchema.parse({ planRevision: review.plan_revision, targetBaseSha: review.base_sha, subjectCommit: review.subject_commit, subjectTree: review.subject_tree, developerExecutionId: prior.id, deliveryArtifactId: prior.delivery_artifact_id, developerEvidenceArtifactId: prior.evidence_artifact_id, leadSessionRef: review.session_ref, developerSessionRef: prior.session_ref });
    const profile = this.executionProfile(input);
    if (profile && profile.provider !== this.provider.id) throw new AgentFailure("developer-profile-unavailable", "Developer profile is unavailable for repair");
    const executionId = input.developerTurnExecutionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const existing = this.database.authQuery((db) => db.prepare("SELECT task_id AS taskId, company_id AS companyId, workflow_id AS workflowId, plan_revision AS planRevision, attempt, status, branch_name AS branchName, worktree_path AS worktreePath, target_base_sha AS targetBaseSha, supersedes_execution_id AS supersedesExecutionId, session_ref AS sessionRef FROM forge_developer_executions WHERE id = ?").get(executionId) as { taskId: string; companyId: string; workflowId: string; planRevision: number; attempt: number; status: string; branchName: string; worktreePath: string; targetBaseSha: string; supersedesExecutionId: string | null; sessionRef: string | null } | undefined);
    const attempt = input.developerAttempt ?? Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    if (existing && (existing.taskId !== input.taskId || existing.companyId !== input.companyId || existing.workflowId !== input.workflowId || existing.planRevision !== input.planRevision || existing.attempt !== attempt || existing.branchName !== input.branchName || existing.targetBaseSha !== input.targetBaseSha || existing.supersedesExecutionId !== input.developerExecutionId || existing.sessionRef !== input.developerSessionRef || !["starting", "running"].includes(existing.status))) throw new AgentFailure("developer-execution-identity-conflict", "The deterministic Developer repair ID is already bound to different coordinates", { nonRetryable: true });
    const previousRepairs = this.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_delivery_repairs WHERE workflow_id = ? AND review_id = ?").get(input.workflowId, input.reviewId) as { count: number }).count;
    if (previousRepairs !== input.cycle - (existing ? 0 : 1)) throw new AgentFailure("repair-cycle-conflict", "Developer repair cycle does not match the durable review history");
    const startedAt = this.now().toISOString();
    const wrapperId = `wrapper_${randomBytes(12).toString("hex")}`;
    const repairAttemptId = `delivery_repair_${executionId.slice("developer_".length)}`;
    let guard: Awaited<ReturnType<typeof createGitCommandGuard>> | undefined;
    let repairRowCreated = false;
    let worktreePath = input.worktreePath;
    let rawSessionId = "";
    const evidenceLines: string[] = [];
    const outputLines: string[] = [];
    try {
      guard = await createGitCommandGuard(this.config.runtimeRoot);
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, session_ref, started_at, heartbeat_at, current_step) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, input.branchName, worktreePath, input.targetBaseSha, wrapperId, guard!.directory, input.developerExecutionId, input.developerSessionRef, startedAt, startedAt);
        db.prepare("INSERT OR IGNORE INTO forge_delivery_repairs (id, task_id, company_id, workflow_id, review_id, developer_execution_id, cycle, status, subject_commit, subject_tree, developer_session_ref, branch_name, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)").run(repairAttemptId, input.taskId, input.companyId, input.workflowId, input.reviewId, executionId, input.cycle, input.subjectCommit, input.subjectTree, input.developerSessionRef, input.branchName, worktreePath, startedAt);
        this.bindCapacityInTransaction(db, input, executionId, input.developerSessionRef, worktreePath);
        repairRowCreated = true;
      });
      if (input.cycle > input.repairCycleLimit) throw new AgentFailure("repair-cap-exhausted", "The configured Developer repair-cycle limit has been reached");
      if (input.blockingFindings.some((finding) => finding.severity !== "blocking" || finding.disposition !== "open")) throw new AgentFailure("repair-scope-violation", "Developer repair input must contain only open blocking findings");
      if (prior.status !== "completed" || prior.session_ref !== input.developerSessionRef || input.leadSessionRef !== review.session_ref || prior.branch_name !== input.branchName || prior.worktree_path !== input.worktreePath || prior.target_base_sha !== input.targetBaseSha || review.plan_revision !== input.planRevision || review.base_sha !== input.targetBaseSha || review.subject_commit !== input.subjectCommit || review.subject_tree !== input.subjectTree || review.outcome !== "blocking") throw new AgentFailure("repair-identity-mismatch", "Developer repair coordinates do not match the immutable review subject");
      const previousRepairs = this.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_delivery_repairs WHERE workflow_id = ? AND review_id = ?").get(input.workflowId, input.reviewId) as { count: number }).count;
      if (previousRepairs !== input.cycle) throw new AgentFailure("repair-cycle-conflict", "Developer repair cycle does not match the durable review history");
      worktreePath = await scopedRepository(this.config.worktreeRoot, input.worktreePath);
      this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET worktree_path = ? WHERE id = ?").run(worktreePath, executionId));
      this.database.authQuery((db) => db.prepare("UPDATE forge_delivery_repairs SET worktree_path = ? WHERE id = ?").run(worktreePath, repairAttemptId));
      const current = await this.worktrees.inspectDelivery(worktreePath);
      if (current.branchName !== input.branchName || current.headSha.toLowerCase() !== input.subjectCommit.toLowerCase() || current.treeSha.toLowerCase() !== input.subjectTree.toLowerCase() || current.dirtyState !== "clean") throw new AgentFailure("repair-subject-changed", "The reviewed Developer worktree is no longer the same clean exact revision");
      rawSessionId = await this.sessionStore.read(input.developerSessionRef) ?? "";
      if (!rawSessionId) throw new AgentFailure("session-conflict", "Developer session reference is invalid");
      const repairPrompt = this.repairPrompt(repairPlan, input.blockingFindings, { branchName: input.branchName, worktreePath, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree });
      evidenceLines.push(JSON.stringify({ type: "forge.prompt", text: redact(repairPrompt) }));
      let evidenceBytes = Buffer.byteLength(evidenceLines[0]!, "utf8") + 1;
      const heartbeat = setInterval(() => void this.heartbeat(executionId), 5_000);
      try {
        const result = await this.processRunner({
          command: this.command,
          args: this.provider.buildTurnArgs({ prompt: repairPrompt, resumeSessionId: rawSessionId, profile }),
          stdin: repairPrompt,
          cwd: worktreePath,
          env: withWorktreeMiseTrust(guard.env, worktreePath),
          detached: true,
          onStart: async (pid, processStartedAt) => { const identity = await processStartIdentity(pid, processStartedAt); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', process_pid = ?, process_group_id = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, pid, identity, this.now().toISOString(), executionId)); },
          onLine: async (line) => {
            const sanitized = safeJsonLine(line);
            evidenceBytes += Buffer.byteLength(sanitized, "utf8") + 1;
            if (evidenceBytes > 6 * 1024 * 1024) throw new AgentFailure("evidence-too-large", "Developer repair evidence exceeded the local artifact limit");
            evidenceLines.push(sanitized);
            outputLines.push(line);
            const event = this.provider.parseEvent(line);
            if (event.threadId && event.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "Developer repair returned a different session identity");
            await this.heartbeat(executionId);
          },
        });
        if (result.exitCode !== 0) {
          evidenceLines.push(JSON.stringify({ type: "forge.process-failure", exitCode: result.exitCode, stderr: redact(result.stderr) }));
          throw this.provider.classifyProcessFailure(result, outputLines);
        }
        const report = parseRepairReport(outputLines, this.provider);
        if (report.addressedFindingIds.some((id) => !input.blockingFindings.some((finding) => finding.findingId === id))) throw new AgentFailure("repair-scope-violation", "Developer repair reported a finding outside the bounded blocking set");
        const openBlockingIds = input.blockingFindings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open").map((finding) => finding.findingId);
        if (report.blocker === null && openBlockingIds.some((id) => !report.addressedFindingIds.includes(id))) throw new AgentFailure("repair-incomplete", "Developer repair did not address every open blocking finding");
        const gitState = await this.worktrees.inspectDelivery(worktreePath);
        const parents = (await execFileAsync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: worktreePath, timeout: 8_000, maxBuffer: 4 * 1024 })).stdout.trim().split(/\s+/);
        const blockedTurnChangedSubject = report.blocker !== null && (gitState.branchName !== input.branchName || gitState.headSha.toLowerCase() !== input.subjectCommit.toLowerCase() || gitState.treeSha.toLowerCase() !== input.subjectTree.toLowerCase() || gitState.dirtyState !== "clean");
        const completedTurnLacksChildCommit = report.blocker === null && (gitState.branchName !== input.branchName || gitState.headSha.toLowerCase() === input.subjectCommit.toLowerCase() || parents.length !== 2 || (parents[1] ?? "").toLowerCase() !== input.subjectCommit.toLowerCase());
        if (blockedTurnChangedSubject || completedTurnLacksChildCommit) throw new AgentFailure("repair-revision-invalid", "Developer repair must preserve the reviewed revision when blocked or create one ordinary child commit when completed");
        if (report.resultCommit.toLowerCase() !== gitState.headSha.toLowerCase() || report.resultTree.toLowerCase() !== gitState.treeSha.toLowerCase() || report.dirtyState !== gitState.dirtyState) throw new AgentFailure("repair-revision-mismatch", "Developer repair report does not match the exact Git result");
        const repairArtifact = await this.artifacts.putIdempotent(input.companyId, "developer-repair", `${executionId}:delivery`, { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ ...report, cycle: input.cycle, reviewId: input.reviewId, supersedesExecutionId: input.developerExecutionId }, null, 2), "utf8") });
        const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
        const blocked = report.blocker !== null || report.dirtyState !== "clean";
        this.database.authTransaction((db) => {
          const row = db.prepare("SELECT id FROM forge_delivery_repairs WHERE developer_execution_id = ? AND cycle = ?").get(executionId, input.cycle) as { id: string } | undefined;
          const failureCode = blocked ? report.blocker !== null ? "repair-scope" : "worktree-unsafe" : null;
          const failureSummary = blocked ? report.blocker ?? "The Developer repair did not leave a clean worktree." : null;
          registerArtifact(db, evidence);
          registerArtifact(db, repairArtifact);
          db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(blocked ? "blocked" : "completed", this.now().toISOString(), this.now().toISOString(), gitState.headSha, gitState.treeSha, gitState.dirtyState, repairArtifact.id, evidence.id, executionId);
          releaseDeveloperExecutionLease(db, executionId);
          db.prepare("UPDATE forge_delivery_repairs SET status = ?, result_commit = ?, result_tree = ?, delivery_artifact_id = ?, evidence_artifact_id = ?, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ?").run(blocked ? "blocked" : "completed", gitState.headSha, gitState.treeSha, repairArtifact.id, evidence.id, failureCode, failureSummary, this.now().toISOString(), row?.id);
          return row?.id;
        });
        if (blocked) return DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, code: report.blocker !== null ? "repair-scope" : "worktree-unsafe", summary: report.blocker ?? "The Developer repair did not leave a clean worktree.", evidenceArtifactId: evidence.id, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState });
        return DeveloperRepairActivityResultSchema.parse({ outcome: "completed", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: "clean", deliveryArtifactId: repairArtifact.id, evidenceArtifactId: evidence.id, summary: report.summary });
      } finally { clearInterval(heartbeat); }
    } catch (error) {
      if (isSupervisorTerminalError(error)) throw error;
      const expectedFailure = error instanceof AgentFailure;
      const failure = error instanceof AgentFailure ? error : new AgentFailure("developer-repair-failed", "Codex Developer repair failed");
      const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
      const code = repairBlockCode(failure);
      const expected = expectedFailure && ["invalid-output", "repair-cap-exhausted", "repair-incomplete", "repair-scope", "session-conflict", "subject-changed", "worktree-unsafe", "authentication-required", "rate-limited", "process-failed", "evidence-too-large"].includes(code);
      let observed: { headSha: string; treeSha: string; dirtyState: "clean" | "dirty" } | undefined;
      try {
        const observedPath = await scopedRepository(this.config.worktreeRoot, worktreePath);
        const gitState = await this.worktrees.inspectDelivery(observedPath);
        observed = { headSha: gitState.headSha, treeSha: gitState.treeSha, dirtyState: gitState.dirtyState };
      } catch { /* Preserve the typed blocker even when the worktree can no longer be inspected. */ }
      const worktreeUnsafe = observed !== undefined && (
        observed.headSha.toLowerCase() !== input.subjectCommit.toLowerCase()
        || observed.treeSha.toLowerCase() !== input.subjectTree.toLowerCase()
        || observed.dirtyState !== "clean"
      );
      const effectiveCode = worktreeUnsafe ? "worktree-unsafe" as const : code;
      const effectiveSummary = worktreeUnsafe ? "The failed repair changed or dirtied the reviewed worktree." : repairSummary[effectiveCode];
      const effectiveExpected = expected && ["invalid-output", "repair-cap-exhausted", "repair-incomplete", "repair-scope", "session-conflict", "subject-changed", "worktree-unsafe", "authentication-required", "rate-limited", "process-failed", "evidence-too-large"].includes(effectiveCode);
      this.database.authTransaction((db) => {
        registerArtifact(db, evidence);
        db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, result_commit = ?, result_tree = ?, dirty_state = ?, evidence_artifact_id = ? WHERE id = ?").run(effectiveExpected ? "blocked" : "failed", this.now().toISOString(), this.now().toISOString(), effectiveCode, effectiveSummary, observed?.headSha ?? null, observed?.treeSha ?? null, observed?.dirtyState ?? null, evidence.id, executionId);
        releaseDeveloperExecutionLease(db, executionId);
        if (repairRowCreated) db.prepare("UPDATE forge_delivery_repairs SET status = ?, result_commit = ?, result_tree = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ?, finished_at = ? WHERE developer_execution_id = ? AND cycle = ?").run(effectiveExpected ? "blocked" : "failed", observed?.headSha ?? null, observed?.treeSha ?? null, effectiveCode, effectiveSummary, evidence.id, this.now().toISOString(), executionId, input.cycle);
      });
      if (!effectiveExpected) throw error;
      return DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, code: effectiveCode, summary: effectiveSummary, evidenceArtifactId: evidence.id, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: observed?.headSha ?? null, resultTree: observed?.treeSha ?? null, dirtyState: observed?.dirtyState ?? null });
    } finally { await guard?.cleanup(); }
  }

  private validateRepairAuthority(input: z.infer<typeof DeveloperRepairActivityInputSchema>, authority: z.infer<typeof RepairAuthorityEnvelopeSchema>): void {
    const expectedSource = input.repairAuthority === "final_review" ? "final_review_blocking" : input.repairAuthority;
    const context = authority.exactContext;
    const exactContextMatches = authority.source === expectedSource
      && authority.planRevision === input.planRevision
      && context.taskId === input.taskId
      && context.companyId === input.companyId
      && context.workflowId === input.workflowId
      && context.projectId === input.projectId
      && context.projectRevisionId === input.projectRevisionId
      && context.deliveryReviewId === input.reviewId
      && context.branchName === input.branchName
      && context.targetBaseSha.toLowerCase() === input.targetBaseSha.toLowerCase()
      && context.subjectCommit.toLowerCase() === input.subjectCommit.toLowerCase()
      && context.subjectTree.toLowerCase() === input.subjectTree.toLowerCase()
      && context.leadSessionRef === input.leadSessionRef
      && JSON.stringify([...authority.findingIds].sort()) === JSON.stringify(input.blockingFindings.map((finding) => finding.findingId).sort());
    if (!exactContextMatches) throw new AgentFailure("repair-authority-mismatch", "The Lead repair-plan authority does not match the exact repair subject");

    let sourceExists = false;
    if (authority.source === "final_review_blocking" && context.finalReviewId && context.releaseId && context.ciRunId) {
      sourceExists = Boolean(this.database.authQuery((db) => db.prepare(`SELECT id FROM forge_final_reviews
        WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND release_id = ? AND ci_run_id = ? AND delivery_review_id = ? AND developer_execution_id = ? AND plan_revision = ? AND base_sha = ? AND subject_commit = ? AND subject_tree = ? AND session_ref = ? AND outcome = 'blocking'`).get(context.finalReviewId, input.taskId, input.companyId, input.workflowId, context.releaseId, context.ciRunId, input.reviewId, input.developerExecutionId, input.planRevision, input.targetBaseSha, input.subjectCommit, input.subjectTree, input.leadSessionRef)));
    } else if (authority.source === "member_requested_changes" && context.acceptanceId && context.releaseId && context.finalReviewId && context.ciRunId && context.reasonArtifactId) {
      sourceExists = Boolean(this.database.authQuery((db) => db.prepare(`SELECT id FROM forge_acceptances
        WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND project_revision_id = ? AND release_id = ? AND review_id = ? AND final_review_id = ? AND ci_run_id = ? AND reason_artifact_id = ? AND decision = 'request_changes' AND status = 'requested_changes'`).get(context.acceptanceId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId, context.releaseId, input.reviewId, context.finalReviewId, context.ciRunId, context.reasonArtifactId)));
    } else if (authority.source === "ci_failure" && context.ciRunId && context.releaseId) {
      sourceExists = Boolean(this.database.authQuery((db) => db.prepare(`SELECT c.id FROM forge_ci_runs c
        JOIN forge_ci_attempts a ON a.run_id = c.id AND a.attempt_number = c.attempt AND a.outcome = 'failed' AND a.observed_head_sha = c.expected_head_sha
        WHERE c.id = ? AND c.task_id = ? AND c.company_id = ? AND c.release_id = ? AND c.expected_head_sha = ? AND c.superseded_at IS NULL`).get(context.ciRunId, input.taskId, input.companyId, context.releaseId, input.subjectCommit)));
    }
    if (!sourceExists) throw new AgentFailure("repair-authority-mismatch", "The Lead repair plan is not bound to a durable authorized repair source");
  }

  async runCiRepair(rawInput: CiRepairActivityInput): Promise<CiRepairActivityResult> {
    const input = rawInput;
    const plan = this.database.authQuery((db) => db.prepare(`SELECT p.id, p.status, p.task_id AS taskId, p.company_id AS companyId, p.workflow_id AS workflowId, p.ci_run_id AS ciRunId, p.ci_attempt_id AS ciAttemptId, p.failed_head_sha AS failedHeadSha, p.plan_artifact_id AS planArtifactId, p.evidence_artifact_id AS planEvidenceArtifactId, a.storage_path AS planStoragePath, a.sha256 AS planSha256, ce.storage_path AS ciEvidenceStoragePath, ce.sha256 AS ciEvidenceSha256, r.repository, r.pr_number AS pullRequestNumber, r.pr_url AS pullRequestUrl, r.head_branch AS headBranch, r.base_branch AS baseBranch, r.base_sha AS baseSha
      FROM forge_ci_repair_plans p
      JOIN forge_ci_runs c ON c.id = p.ci_run_id AND c.task_id = p.task_id AND c.company_id = p.company_id AND c.superseded_at IS NULL
      JOIN forge_ci_attempts ca ON ca.id = p.ci_attempt_id AND ca.run_id = c.id AND ca.outcome = 'failed' AND ca.observed_head_sha = p.failed_head_sha
      JOIN forge_releases r ON r.id = c.release_id AND r.task_id = p.task_id AND r.company_id = p.company_id AND r.superseded_at IS NULL
      JOIN forge_artifacts a ON a.id = p.plan_artifact_id AND a.company_id = p.company_id
      JOIN forge_artifacts pe ON pe.id = p.evidence_artifact_id AND pe.company_id = p.company_id
      JOIN forge_artifacts ce ON ce.id = ca.evidence_artifact_id AND ce.company_id = p.company_id
      WHERE p.id = ? AND p.task_id = ? AND p.company_id = ? AND p.workflow_id = ? AND p.ci_run_id = ? AND p.ci_attempt_id = ? AND p.failed_head_sha = ? AND p.plan_artifact_id = ? AND p.evidence_artifact_id = ?`).get(input.repairPlanId, input.taskId, input.companyId, input.workflowId, input.ciRunId, input.ciAttemptId, input.failedHeadSha, input.repairPlanArtifactId, input.repairPlanEvidenceArtifactId) as { id: string; status: string; taskId: string; companyId: string; workflowId: string; ciRunId: string; ciAttemptId: string; failedHeadSha: string; planArtifactId: string; planEvidenceArtifactId: string; planStoragePath: string; planSha256: string; ciEvidenceStoragePath: string; ciEvidenceSha256: string; repository: string; pullRequestNumber: number; pullRequestUrl: string; headBranch: string; baseBranch: string; baseSha: string } | undefined);
    if (!plan || plan.status !== "planned") throw new AgentFailure("ci-repair-plan-unavailable", "CI repair plan is not active");
    const prior = this.database.authQuery((db) => db.prepare(`SELECT id, status, session_ref AS sessionRef, worktree_path AS worktreePath, branch_name AS branchName, result_commit AS resultCommit, result_tree AS resultTree
      FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.priorDeveloperExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; status: string; sessionRef: string | null; worktreePath: string; branchName: string; resultCommit: string | null; resultTree: string | null } | undefined);
    if (!prior || prior.status !== "completed" || prior.sessionRef !== input.priorDeveloperSessionRef || prior.worktreePath !== input.worktreePath || prior.branchName !== input.branchName || prior.resultCommit?.toLowerCase() !== input.priorCommit.toLowerCase() || prior.resultTree?.toLowerCase() !== input.priorTree.toLowerCase() || input.priorCommit.toLowerCase() !== input.failedHeadSha.toLowerCase()) throw new AgentFailure("ci-repair-identity-mismatch", "CI repair does not match the original Developer delivery");
    if (!this.github?.getPullRequest) throw new AgentFailure("ci-repair-provider-unavailable", "The current pull request cannot be verified before repair");
    const pullRequest = await this.github.getPullRequest({ repository: plan.repository, number: plan.pullRequestNumber });
    // Draft is not part of the pull request identity: acceptance marks a delivery ready for review while CI is still observed, so CI repair must still run on the exact head.
    if (pullRequest.state !== "open" || pullRequest.repository.toLowerCase() !== plan.repository.toLowerCase() || pullRequest.number !== plan.pullRequestNumber || pullRequest.url.replace(/\/$/, "").toLowerCase() !== plan.pullRequestUrl.replace(/\/$/, "").toLowerCase() || pullRequest.headBranch !== plan.headBranch || pullRequest.baseBranch !== plan.baseBranch || pullRequest.baseSha.toLowerCase() !== plan.baseSha.toLowerCase() || pullRequest.headSha.toLowerCase() !== input.failedHeadSha.toLowerCase()) throw new AgentFailure("ci-repair-pull-request-changed", "The pull request changed before CI repair");
    const worktreePath = await scopedRepository(this.config.worktreeRoot, input.worktreePath);
    let current = await this.worktrees.inspectDelivery(worktreePath);
    // A previously failed repair attempt can leave its own unpushed commit on HEAD.
    // Discard it and retry the same exact repair instead of refusing forever.
    if (current.headSha.toLowerCase() !== input.priorCommit.toLowerCase() && await rollbackUnpushedRepairCommits(worktreePath, input.branchName, input.priorCommit)) current = await this.worktrees.inspectDelivery(worktreePath);
    if (current.branchName !== input.branchName || current.dirtyState !== "clean") throw new AgentFailure("ci-repair-subject-changed", "The CI repair worktree is not a clean task branch");
    const rawSessionId = await this.sessionStore.read(input.priorDeveloperSessionRef);
    if (!rawSessionId) throw new AgentFailure("invalid-session-reference", "Developer session reference is invalid");
    const planText = (await this.artifacts.read({ companyId: input.companyId, storagePath: plan.planStoragePath, sha256: plan.planSha256 })).toString("utf8");
    const evidenceText = (await this.artifacts.read({ companyId: input.companyId, storagePath: plan.ciEvidenceStoragePath, sha256: plan.ciEvidenceSha256 })).toString("utf8");
    const executionId = `developer_${randomBytes(12).toString("hex")}`;
    const repairId = `ci_repair_${randomBytes(12).toString("hex")}`;
    const startedAt = this.now().toISOString();
    const guard = await createGitCommandGuard(this.config.runtimeRoot);
    this.database.authTransaction((db) => {
      // Attempt must climb: (workflow_id, plan_revision, attempt) is unique, so a
      // hardcoded attempt 1 made every CI repair after the first fail on insert.
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, session_ref, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 0, (SELECT COALESCE(MAX(attempt), 0) + 1 FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = 0), 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.workflowId, input.branchName, worktreePath, plan.baseSha, `wrapper_${randomBytes(12).toString("hex")}`, guard.directory, input.priorDeveloperExecutionId, input.priorDeveloperSessionRef, startedAt, startedAt);
      db.prepare("INSERT INTO forge_ci_repairs (id, repair_plan_id, prior_developer_execution_id, prior_developer_session_ref, worktree_path, branch_name, prior_commit, prior_tree, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?)").run(repairId, input.repairPlanId, input.priorDeveloperExecutionId, input.priorDeveloperSessionRef, worktreePath, input.branchName, input.priorCommit, input.priorTree, startedAt);
    });
    const evidenceLines = [JSON.stringify({ type: "forge.ci-repair-context", ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, failedHeadSha: input.failedHeadSha, plan: redact(planText), evidence: redact(evidenceText) })];
    const outputLines: string[] = [];
    const ciRepairPrompt = this.ciRepairPrompt(planText, { branchName: input.branchName, worktreePath, priorCommit: input.priorCommit, priorTree: input.priorTree });
    try {
      const result = await this.processRunner({ command: this.command, args: this.provider.buildTurnArgs({ prompt: ciRepairPrompt, resumeSessionId: rawSessionId }), stdin: ciRepairPrompt, cwd: worktreePath, env: withWorktreeMiseTrust(guard.env, worktreePath), detached: true, onStart: async (pid, processStartedAt) => { const identity = await processStartIdentity(pid, processStartedAt); await this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', process_pid = ?, process_group_id = ?, process_start_identity = ?, heartbeat_at = ? WHERE id = ?").run(pid, pid, identity, this.now().toISOString(), executionId)); }, onLine: async (line) => { const event = this.provider.parseEvent(line); if (event.threadId && event.threadId !== rawSessionId) throw new AgentFailure("session-identity-conflict", "CI repair returned a different Developer session identity"); evidenceLines.push(safeJsonLine(line)); outputLines.push(line); await this.heartbeat(executionId); } });
      if (result.exitCode !== 0) throw this.provider.classifyProcessFailure(result, outputLines);
      const report = parseRepairReport(outputLines, this.provider);
      const gitState = await this.worktrees.inspectDelivery(worktreePath);
      if (gitState.branchName !== input.branchName || gitState.dirtyState !== "clean" || report.resultCommit.toLowerCase() !== gitState.headSha.toLowerCase() || report.resultTree.toLowerCase() !== gitState.treeSha.toLowerCase()) throw new AgentFailure("ci-repair-revision-invalid", "CI repair did not leave a clean task branch");
      const delivery = await this.artifacts.put(input.companyId, "developer-repair", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ ...report, ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, priorCommit: input.priorCommit, priorTree: input.priorTree }, null, 2), "utf8") });
      const evidence = await this.artifacts.put(input.companyId, "ci-repair-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(delivery.id, delivery.companyId, delivery.kind, delivery.filename, delivery.mimeType, delivery.byteSize, delivery.sha256, delivery.storagePath, delivery.createdAt, evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, gitState.headSha, gitState.treeSha, delivery.id, evidence.id, executionId);
        releaseDeveloperExecutionLease(db, executionId);
        db.prepare("UPDATE forge_ci_repairs SET result_developer_execution_id = ?, result_developer_session_ref = ?, new_commit = ?, new_tree = ?, delivery_artifact_id = ?, evidence_artifact_id = ?, status = 'completed', summary = ?, completed_at = ? WHERE id = ?").run(executionId, input.priorDeveloperSessionRef, gitState.headSha, gitState.treeSha, delivery.id, evidence.id, report.summary, now, repairId);
        db.prepare("UPDATE forge_ci_repair_plans SET status = 'consumed', consumed_at = ?, updated_at = ? WHERE id = ?").run(now, now, input.repairPlanId);
        if (input.releaseId) {
          db.prepare("UPDATE forge_releases SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND superseded_at IS NULL").run(now, now, input.releaseId, input.taskId, input.companyId);
          db.prepare("UPDATE forge_ci_runs SET superseded_at = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND superseded_at IS NULL").run(now, now, input.ciRunId, input.taskId, input.companyId);
        }
      });
      return { repairId, developerExecutionId: executionId, developerSessionRef: input.priorDeveloperSessionRef, worktreePath, branchName: input.branchName, priorCommit: input.priorCommit, priorTree: input.priorTree, resultCommit: gitState.headSha, resultTree: gitState.treeSha, deliveryArtifactId: delivery.id, evidenceArtifactId: evidence.id, summary: report.summary, outcome: "completed" };
    } catch (error) {
      const failure = error instanceof AgentFailure ? error : new AgentFailure("ci-repair-failed", "CI repair failed");
      // Leave the worktree on the recorded failed head so the retry starts clean.
      await rollbackUnpushedRepairCommits(worktreePath, input.branchName, input.priorCommit);
      const evidence = await this.persistEvidence(input.companyId, evidenceLines);
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId); releaseDeveloperExecutionLease(db, executionId); db.prepare("UPDATE forge_ci_repairs SET status = 'failed', failure_code = ?, summary = ?, evidence_artifact_id = ?, completed_at = ? WHERE id = ?").run(failure.code, failure.message, evidence.id, this.now().toISOString(), repairId); });
      throw failure;
    } finally { await guard.cleanup(); }
  }

  private mergeConflictResolutionPrompt(plan: string, input: MergeConflictResolutionInput, conflict: ForwardMergeConflictArtifact): string {
    return [
      "You are Forge's Integrator, continuing the same authenticated session in the exact owned issue worktree: your job is to get the Builder's branch merged against the current base. A guarded normal merge is already in progress. Resolve only the listed conflicts using the authored plan.",
      "Do not abort the merge, rebase, amend, reset, clean, force-push, use GitHub/provider commands, or modify another checkout. Inspect both sides and the combined conflict markers, apply the bounded resolutions, run the complete relevant local verification suite from the approved plan, stage only the resolved worktree, and create exactly one ordinary merge commit with both parents. Leave the worktree clean.",
      'Return exactly one JSON object with no markdown fences or commentary matching: {"kind":"merge_conflict_resolution","summary":"...","resolvedFiles":[],"commandsRun":[],"testResults":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Include every listed conflict file in resolvedFiles and report any blocker instead of claiming success.',
      "Merge identity:\n" + JSON.stringify({ branchName: input.branchName, priorHead: input.priorHead, targetBaseSha: input.targetBaseSha, conflictFiles: conflict.conflictFiles }),
      "Lead-authored resolution plan:\n" + plan,
    ].join("\n\n");
  }

  private ciRepairPrompt(plan: string, input: { branchName: string; worktreePath: string; priorCommit: string; priorTree: string }): string {
    return `You are Forge's Integrator, continuing the same authenticated session in the same worktree and branch: your job is to get the Builder's branch merged, so fix what CI reported. Apply only the exact CI repair plan below. Do not create a PR, use provider commands, rerun CI, merge, rebase, amend, reset, clean, force-push, or rewrite history. Run the complete pinned local verification. Create exactly one ordinary child commit whose parent is the failed commit, leave the worktree clean, and return exactly one JSON object with no markdown fences or commentary matching: {"kind":"repair","summary":"...","addressedFindingIds":[],"commandsRun":[],"testResults":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Use no other keys.\n\nCoordinates: ${JSON.stringify(input)}\nCI repair plan:\n${plan}`;
  }

  private repairPrompt(repairPlan: string, findings: DeliveryFinding[], worktree: { branchName: string; worktreePath: string; targetBaseSha: string; subjectCommit: string; subjectTree: string }): string {
    return [
      'You are Forge\'s authenticated Developer continuing the same Developer session. Apply only the bounded repair plan for the listed blocking Lead findings in the exact existing issue worktree. Do not redesign the authorized plan, expand scope, modify another checkout, use GitHub or any provider, push, create a pull request, merge, rebase, amend, reset, clean, or rewrite history. Run only local verification relevant to these findings. Create exactly one ordinary new local commit whose parent is the reviewed subject commit, leave the worktree clean, and return exactly one JSON object with no markdown fences or commentary matching: {"kind":"repair","summary":"...","addressedFindingIds":[],"commandsRun":[],"testResults":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Address only finding IDs supplied below; if the repository contradicts the repair plan, stop and report a blocker.',
      `Bounded repair plan:\n${repairPlan}`,
      `Blocking findings:\n${JSON.stringify(findings)}`,
      `Exact worktree coordinates:\n${JSON.stringify(worktree)}`,
    ].join("\n\n");
  }

  private prompt(title: string, brief: string, plan: string, evidence: string, worktree: { branchName: string; worktreePath: string; targetBaseSha: string }): string {
    return `You are Forge's authenticated Developer. Execute the authorized Lead plan prescriptively in the isolated worktree only. Do not redesign the plan, expand scope, modify the target repository, use GitHub or any provider, push, create a pull request, merge, rebase, amend, reset, clean, or rewrite history. If the repository contradicts the authorized plan, stop before unrelated edits and report a blocker. You may edit files in this worktree, run safe local verification, and create ordinary local commits. During execution, post concise public progress updates before each substantive action and after notable results: say what you are inspecting, changing, or verifying and why, without exposing private chain-of-thought. Before finishing, ensure the worktree is clean and return exactly one JSON object with no markdown fences or commentary matching: {"kind":"delivery","summary":"...","steps":[{"number":1,"status":"completed|incomplete|not_completed|blocked","filesChanged":[],"commandsRun":[],"testResults":[],"notes":"..."}],"authorizedStepsNotCompleted":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Include every approved step number exactly once, concrete files, commands, test outcomes, exact resulting commit/tree, and any incomplete authorized step. For any incomplete, not_completed, or blocked step, list its number in authorizedStepsNotCompleted and provide a non-null blocker.

Task: ${title}
Brief:
${brief}

Authorized final Lead plan:
${plan}

Prior scoped Lead evidence:
${evidence}

Execution coordinates:
${JSON.stringify(worktree)}`;
  }

  private async heartbeat(executionId: string): Promise<void> {
    this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(this.now().toISOString(), executionId));
  }

  private async persistEvidence(companyId: string, lines: string[], stableKey?: string): Promise<StoredArtifact> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const artifactInput = { filename: stableKey ? `${stableKey.split(":")[0]}.jsonl` : `developer_${randomBytes(12).toString("hex")}.jsonl`, mimeType: "application/x-ndjson", bytes: content.length ? content : Buffer.from("{\"type\":\"empty\"}\n") };
    return stableKey ? this.artifacts.putIdempotent(companyId, "agent-evidence", stableKey, artifactInput) : this.artifacts.put(companyId, "agent-evidence", artifactInput);
  }
}
