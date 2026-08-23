import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";
import type Database from "better-sqlite3";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { AgentFailure } from "./agent-failure.js";
import { resolveAgentProvider } from "./agent-providers/index.js";
import type { AgentProvider, LeadProcessRunner, SessionStore } from "./agent-providers/provider.js";
import { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";
import type { GithubReleasePort } from "./github-release.js";
import { createGitCommandGuard, withWorktreeMiseTrust, WorktreeFailure, WorktreeManager } from "./worktrees.js";
import { ForwardMergeConflictArtifactSchema, type ForwardMergeConflictArtifact } from "./forward-merge.js";
import { runPinnedVerification } from "./verification.js";
import { loadTaskConfiguration } from "./task-project-configuration.js";
import { loadDefaultPrompts, renderPrompt } from "./prompts.js";
import { DeliveryReviewSubjectSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, type CiRepairActivityInput, type CiRepairActivityResult, type DeliveryFinding, type DeveloperExecutionActivityInput, type DeveloperExecutionResult, type DeveloperRepairActivityInput, type DeveloperRepairActivityResult, type DeveloperSupervisorActivityIdentity, type MergeConflictResolutionActivityInput, type MergeConflictResolutionActivityResult } from "./temporal/issue-contracts.js";
import { buildGitBranchName } from "./git-branch-name.js";
import { fallbackGitPresentation } from "./git-presentation.js";
import { jsonRequired } from "./task-utils.js";


const execFileAsync = promisify(execFile);

export function buildDeveloperExecutionPrompt(input: { executionId: string; reuseWorktree: boolean; startingSha: string; verificationSteps: string; operatorNote?: string }): string {
  const worktreeInstruction = input.reuseWorktree
    ? ` This is a linked retry: preserved work on this branch is yours to continue. If \`git merge-base --is-ancestor ${input.startingSha} HEAD\` fails, bring the branch up to date first: \`git rebase ${input.startingSha}\` (preferred; resolve conflicts) or, if the rebase is messy, \`git merge ${input.startingSha}\`. Never discard preserved commits; never reset to the base.`
    : " This is a fresh turn: the worktree is at the accepted starting SHA with no prior work; you must make the change.";
  const gitRestriction = input.reuseWorktree
    ? "Do not push, create PRs, reset, clean, force, or use provider mutation. Do not amend or rewrite commits that already exist on the branch unless rebasing onto the target base requires it."
    : "Do not push, create PRs, merge, rebase, amend, reset, clean, force, or use provider mutation.";
  return `You are Forge's Developer. Execute only the authorized final plan in this isolated worktree. The final plan is staged at .forge-context/${input.executionId}/final-plan.json. Read only the other files under that execution directory. Current target base SHA: ${input.startingSha}. The plan describes intent and scope, not an exact file manifest. If the repository has changed (files moved/renamed/deleted, migrations regenerated), implement the intent against the current tree and note the deviation in the step notes. Only report incomplete when the intent itself cannot be achieved. If a step requires deployment, physical devices, production access, external services, an unrelated pre-existing test failure, or a local server that cannot start, mark it \`not_applicable_locally\` with a one-line reason and continue with the remaining steps.${worktreeInstruction}${input.operatorNote ? ` Operator note (verbatim): ${input.operatorNote}` : ""} During execution, post concise public progress updates before each substantive action and after notable results: say what you are inspecting, changing, or verifying and why, without exposing private chain-of-thought. Create one or more ordinary local commits for the authorized work when new commits are required; do not amend or rewrite commits that already exist on the branch unless rebasing onto the target base requires it. Leave the worktree clean, and return exactly one JSON object with no markdown fences or commentary matching: {"kind":"delivery","summary":"...","steps":[{"number":1,"status":"completed|incomplete|not_completed|blocked|not_applicable_locally","filesChanged":[],"notes":"..."}],"authorizedStepsNotCompleted":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Include every approved step number once and keep filesChanged to changed paths. For any incomplete, not_completed, or blocked step, list its number in authorizedStepsNotCompleted and provide a non-null blocker. Forge will run the accepted pinned setup and final verification independently after the Developer process exits. Expected plan verification commands for context:\n${input.verificationSteps}\n${gitRestriction}`;
}



type RepairBlockCode = import("./temporal/issue-contracts.js").DeliveryOperationBlockCode;
function repairBlockCode(failure: AgentFailure): RepairBlockCode {
  if (["missing-repair-report", "malformed-repair-report", "invalid-repair-report"].includes(failure.code)) return "invalid-output";
  if (failure.code === "session-identity-conflict" || failure.code === "session-conflict") return "session-conflict";
  if (failure.code === "login-expired" || failure.code === "authentication-required") return "authentication-required";
  if (failure.code === "rate-limited") return "rate-limited";
  if (failure.code === "evidence-too-large") return "evidence-too-large";
  return "process-failed";
}

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
  status: z.enum(["completed", "incomplete", "not_completed", "blocked", "not_applicable_locally"]),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(z.string()).optional(),
  testResults: z.array(z.string()).optional(),
  notes: z.string(),
});
export const DeveloperDeliveryReportSchema = z.object({
  kind: z.literal("delivery"),
  summary: z.string().min(1),
  steps: z.array(DeveloperDeliveryStepSchema).min(1),
  authorizedStepsNotCompleted: z.array(z.number().int().positive()),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().nullable(),
  visualEvidence: z.object({ captured: z.boolean(), paths: z.array(z.string().min(1)), summary: z.string().optional() }).optional(),
});

export const DeveloperRepairReportSchema = z.object({
  summary: z.string().min(1),
  blocker: z.string().nullable(),
}).strict();

export const DeveloperMergeConflictResolutionReportSchema = z.object({
  kind: z.literal("merge_conflict_resolution"),
  summary: z.string().min(1),
  resolvedFiles: z.array(z.string().min(1)),
  commandsRun: z.array(z.string()).min(1),
  testResults: z.array(z.string()).min(1),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().nullable(),
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
  githubObservation?: unknown;
  prompts?: ReadonlyMap<string, string>;
}

function safeJsonLine(line: string): string {
  try { return JSON.stringify(redact(jsonRequired(line))) ?? JSON.stringify({ type: "empty" }); } catch { return JSON.stringify({ type: "text", text: redact(line) }); }
}

function parseDeliveryReport(lines: string[], provider: AgentProvider): DeveloperDeliveryReport {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-delivery-report", "Codex Developer did not return a delivery report");
  let parsed: unknown;
  try { parsed = jsonRequired(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-delivery-report", "Codex Developer returned malformed delivery JSON"); }
  const report = DeveloperDeliveryReportSchema.safeParse(parsed);
  if (!report.success) throw new AgentFailure("invalid-delivery-report", "Codex Developer returned a delivery report outside the required schema");
  return report.data;
}

function parseRepairReport(lines: string[], provider: AgentProvider): z.infer<typeof DeveloperRepairReportSchema> {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-repair-report", "Codex Developer did not return a repair report");
  let parsed: unknown;
  try { parsed = jsonRequired(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-repair-report", "Codex Developer returned malformed repair JSON"); }
  const result = DeveloperRepairReportSchema.safeParse(parsed);
  if (!result.success) throw new AgentFailure("invalid-repair-report", "Codex Developer returned a repair report outside the required schema");
  return result.data;
}

function parseMergeConflictResolutionReport(lines: string[], provider: AgentProvider): z.infer<typeof DeveloperMergeConflictResolutionReportSchema> {
  const text = provider.agentMessages(lines).at(-1);
  if (!text) throw new AgentFailure("missing-merge-resolution-report", "Codex Developer did not return a merge-conflict resolution report");
  let parsed: unknown;
  try { parsed = jsonRequired(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new AgentFailure("malformed-merge-resolution-report", "Codex Developer returned malformed merge-conflict resolution JSON"); }
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
  private prompts: ReadonlyMap<string, string>;


  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig, options: DeveloperServiceOptions = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot, database);
    this.provider = options.provider ?? resolveAgentProvider();
    this.command = this.provider.resolveCommand(options.command);
    this.processRunner = options.processRunner ?? this.provider.processRunner;
    this.sessionStore = options.sessionStore ?? this.provider.createSessionStore(config.runtimeRoot);
    this.worktrees = options.worktrees ?? new WorktreeManager();
    this.now = options.now ?? (() => new Date());
    this.github = options.github;
    this.prompts = options.prompts ?? loadDefaultPrompts();
  }

  private bindCapacityInTransaction(_db: Database.Database, _input: { capacityRequestId?: string | undefined }, _executionId: string, _sessionRef?: string, _worktreePath?: string): void {}

  private executionProfile(_input: { capacityRequestId?: string | undefined }, profileId?: string): DeveloperProfile | undefined {
    if (!profileId) return undefined;
    return this.database.authQuery((db) => db.prepare("SELECT id, model, provider, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE id = ?").get(profileId) as DeveloperProfile | undefined);
  }

  async run(rawInput: DeveloperExecutionActivityInput & Partial<DeveloperSupervisorActivityIdentity>): Promise<DeveloperExecutionResult> {
    const input = rawInput;
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, b.storage_path AS briefStoragePath, b.sha256 AS briefSha256, pa.storage_path AS planStoragePath, pa.sha256 AS planSha256, ea.storage_path AS evidenceStoragePath, ea.sha256 AS evidenceSha256, e.id AS outputId, e.original_plan_revision AS originalPlanRevision, e.output_revision AS outputRevision, e.final_version AS finalVersion, e.output_artifact_id AS artifactId, pa.sha256 AS artifactSha256, e.session_ref AS leadSessionRef, e.id AS leadExecutionId, e.evidence_manifest_artifact_id AS evidenceManifestArtifactId, em.sha256 AS evidenceManifestSha256
      FROM forge_tasks t
      JOIN forge_artifacts b ON b.id = t.brief_artifact_id JOIN forge_agent_executions e ON e.output_artifact_id = ? AND e.task_id = t.id AND e.workflow_id = t.workflow_id
      JOIN forge_artifacts pa ON pa.id = e.output_artifact_id JOIN forge_artifacts ea ON ea.id = e.evidence_artifact_id
      LEFT JOIN forge_artifacts em ON em.id = e.evidence_manifest_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId) as DeveloperContext & { outputId?: string; originalPlanRevision?: number; outputRevision?: number; finalVersion?: number; artifactId?: string; artifactSha256?: string; leadSessionRef?: string; leadExecutionId?: string; evidenceManifestArtifactId?: string; evidenceManifestSha256?: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Authorized Lead delivery evidence is unavailable");
    const taskConfiguration = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
    const projectRevision = ProjectRevisionSchema.safeParse(taskConfiguration);
    if (!projectRevision.success) throw new AgentFailure("scoped-input-missing", "Pinned project execution configuration is unavailable");
    this.prompts = this.pinnedPrompts(taskConfiguration, input.companyId);
    const repositoryPath = await scopedRepository(this.config.repositoryRoot, projectRevision.data.repositoryPath);
    const [brief, planText, leadEvidence] = await Promise.all([
      this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.briefStoragePath, sha256: context.briefSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.evidenceStoragePath, sha256: context.evidenceSha256 }).then((bytes) => bytes.toString("utf8")),
    ]);
    const plan = jsonRequired(planText) as { kind?: unknown; steps?: Array<{ number: number; instruction: string; verification: string }> };
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
    const prompt = this.prompt(context.title, brief, planText, leadEvidence, worktree, input.runProjectTests, input.visualEvidence, input.operatorNote);
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
        let gitState = await this.worktrees.inspectDelivery(worktree.worktreePath);
        if (gitState.dirtyState === "dirty") {
          await execFileAsync("git", ["add", "-A"], { cwd: worktree.worktreePath, timeout: 30_000, maxBuffer: 256 * 1024 });
          await execFileAsync("git", ["-c", "user.name=Forge Builder", "-c", "user.email=builder@forge.invalid", "commit", "-m", "wip: builder"], { cwd: worktree.worktreePath, timeout: 30_000, maxBuffer: 256 * 1024 });
          gitState = await this.worktrees.inspectDelivery(worktree.worktreePath);
        }
        const parsedReport = (() => {
          try { return parseDeliveryReport(evidenceLines, this.provider); }
          catch {
            if (gitState.headSha === worktree.targetBaseSha) throw new AgentFailure("developer-failed", outputLines.slice(-20).join("\n") || "Builder left no report");
            return { summary: "Builder left no report", blocker: null };
          }
        })();
        const delivery = { ...parsedReport, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState, branchName: worktree.branchName, worktreePath: worktree.worktreePath, targetBaseSha: worktree.targetBaseSha };
        const deliveryArtifact = await this.artifacts.putArtifact(input.companyId, "developer-delivery", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(delivery, null, 2), "utf8") });
        const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
        const blocked = parsedReport.blocker !== null;
        const terminalStatus = this.database.authTransaction((db) => {
          const updated = db.prepare("UPDATE forge_developer_executions SET status = ?, session_ref = ?, finished_at = ?, heartbeat_at = ?, current_step = NULL, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(blocked ? "blocked" : "completed", sessionRef, this.now().toISOString(), this.now().toISOString(), gitState.headSha, gitState.treeSha, gitState.dirtyState, deliveryArtifact.id, evidence.id, executionId);
          return updated.changes === 1 ? blocked ? "blocked" : "completed" : (db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId) as { status: string } | undefined)?.status;
        });
        if (terminalStatus === "cancelled" || terminalStatus === "interrupted") throw new AgentFailure("developer-cancelled", "Developer execution was cancelled before completion");
        if (terminalStatus !== (blocked ? "blocked" : "completed")) throw new AgentFailure("developer-superseded", "Developer execution was superseded before completion");
        return { developerExecutionId: executionId, developerSessionRef: sessionRef ?? executionId, worktreePath: worktree.worktreePath, branchName: worktree.branchName, targetBaseSha: worktree.targetBaseSha, currentStep: null, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState, deliveryArtifactId: deliveryArtifact.id, evidenceArtifactId: evidence.id, deliverySummary: parsedReport.summary, outcome: blocked ? "blocked" : "completed" };
      } finally { clearInterval(heartbeat); }
    } catch (error) {
      if (isSupervisorTerminalError(error)) throw error;
      // Keep the real cause: a swallowed message made launch-path bugs look like Builder failures.
      const failure = error instanceof AgentFailure ? error : new AgentFailure("developer-failed", `Builder could not start: ${error instanceof Error ? error.message : String(error)}`);
      if (!(error instanceof AgentFailure)) console.error("Builder launch failed", executionId, error);
      const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
      this.database.authTransaction((db) => {
        const finishedAt = this.now().toISOString();
        db.prepare("UPDATE forge_developer_executions SET status = CASE WHEN status IN ('starting', 'running') THEN 'failed' ELSE status END, session_ref = COALESCE(session_ref, ?), finished_at = COALESCE(finished_at, ?), heartbeat_at = ?, failure_code = CASE WHEN status IN ('starting', 'running') THEN ? ELSE failure_code END, failure_summary = CASE WHEN status IN ('starting', 'running') THEN ? ELSE failure_summary END, evidence_artifact_id = COALESCE(evidence_artifact_id, ?) WHERE id = ?").run(sessionRef ?? null, finishedAt, finishedAt, failure.code, failure.message, evidence.id, executionId);
      });
      throw failure;
    } finally { await guard?.cleanup(); }
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
    if (!conflictRow) throw new AgentFailure("merge-resolution-evidence-missing", "Forward-merge conflict evidence is unavailable");
    try {
      conflict = ForwardMergeConflictArtifactSchema.parse(jsonRequired((await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: conflictRow.storage_path, sha256: conflictRow.sha256 })).toString("utf8")));
    } catch {
      throw new AgentFailure("merge-resolution-evidence-corrupt", "Forward-merge conflict evidence failed integrity validation");
    }
    if (conflict.priorHead.toLowerCase() !== input.priorHead.toLowerCase() || conflict.observedBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase() || conflict.conflictFiles.length !== input.conflictFileCount) throw new AgentFailure("merge-resolution-identity-mismatch", "Forward-merge conflict evidence does not match the owned merge");
    const mergeState = await this.mergeState(input.worktreePath);
    if (mergeState.head !== input.priorHead || mergeState.mergeHead !== input.targetBaseSha || JSON.stringify(mergeState.conflicts) !== JSON.stringify([...conflict.conflictFiles].sort())) {
      throw new AgentFailure("merge_state_ownership_mismatch", "The in-progress merge no longer matches the recorded forward-merge operation");
    }
    const plan = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: planRow.storage_path, sha256: planRow.sha256 })).toString("utf8");
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
      const revision = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
      let parsed;
      try { parsed = revision; } catch { throw new AgentFailure("artifact_unavailable", "The task project configuration does not contain valid pinned verification commands"); }
      const verification = await runPinnedVerification({ taskId: input.taskId, stepId: executionId, worktreePath: input.worktreePath, setupCommand: parsed.setupCommand, verificationCommand: parsed.verificationCommand }, { guard });
      const verificationArtifactRecord = await this.artifacts.putArtifact(input.companyId, "forward-merge-verification", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(verification), "utf8") });
      verificationArtifact = verificationArtifactRecord;
      const afterVerification = await this.worktrees.inspectDelivery(input.worktreePath);
      const afterParents = (await execFileAsync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: input.worktreePath, timeout: 8_000, maxBuffer: 4 * 1024 })).stdout.trim().split(/\s+/);
      if (afterVerification.branchName !== input.branchName || afterVerification.headSha.toLowerCase() !== gitState.headSha.toLowerCase() || afterVerification.treeSha.toLowerCase() !== gitState.treeSha.toLowerCase() || afterVerification.dirtyState !== "clean" || afterParents.length !== 3 || afterParents[1]?.toLowerCase() !== input.priorHead.toLowerCase() || afterParents[2]?.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new AgentFailure("merge_state_ownership_mismatch", "Pinned verification changed the forward-merge delivery");
      if (verification.outcome !== "passed") throw new AgentFailure(verification.code ?? "verification_failed", verification.summary);
      await this.artifacts.putArtifact(input.companyId, "merge-conflict-resolution", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(report, null, 2), "utf8") });
      const deliveryArtifact = await this.artifacts.putArtifact(input.companyId, "forward-merge-delivery", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, checkId: input.forwardMergeId, priorHead: input.priorHead, priorTree: conflict.priorTree, targetBaseSha: input.targetBaseSha, resultCommit: gitState.headSha, resultTree: gitState.treeSha, developerExecutionId: executionId, supersedesDeveloperExecutionId: input.developerExecutionId, supersededDeliveryArtifactId: prior.delivery_artifact_id, supersededEvidenceArtifactId: prior.evidence_artifact_id, verificationArtifactId: verificationArtifactRecord.id, verification }, null, 2), "utf8") });
      const evidence = await this.artifacts.putArtifact(input.companyId, "agent-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, gitState.headSha, gitState.treeSha, deliveryArtifact.id, evidence.id, executionId);
        db.prepare("UPDATE forge_forward_merges SET status = 'merged', merge_commit = ?, tree = ?, result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, delivery_artifact_id = ?, updated_at = ? WHERE task_id = ? AND company_id = ? AND conflict_artifact_id = ?").run(gitState.headSha, gitState.treeSha, gitState.headSha, gitState.treeSha, executionId, verificationArtifactRecord.id, deliveryArtifact.id, now, input.taskId, input.companyId, input.conflictArtifact.id);
        db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, result_commit = ?, result_tree = ?, status = 'completed', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, gitState.headSha, gitState.treeSha, now, input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
      });
      return { developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, resultCommit: gitState.headSha, resultTree: gitState.treeSha, deliveryArtifactId: deliveryArtifact.id, evidenceArtifactId: evidence.id, verificationArtifactId: verificationArtifactRecord.id, summary: report.summary };
    } catch (error) {
      if (isSupervisorTerminalError(error)) throw error;
      const failure = error instanceof AgentFailure ? error : new AgentFailure("merge-resolution-failed", "Codex Developer merge-conflict resolution failed");
      const evidence = await this.artifacts.putArtifact(input.companyId, "agent-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      if (verificationArtifact && completedMerge && ["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(failure.code)) {
        const blockedVerificationArtifact = verificationArtifact;
        const blockedMerge = completedMerge;
        const now = this.now().toISOString();
        this.database.authTransaction((db) => {
          db.prepare("UPDATE forge_developer_executions SET status = 'blocked', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, blockedMerge.headSha, blockedMerge.treeSha, failure.code, failure.message, evidence.id, executionId);
          db.prepare("UPDATE forge_forward_merges SET status = 'merged', merge_commit = ?, tree = ?, result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, failure_code = ?, failure_summary = ?, updated_at = ? WHERE task_id = ? AND company_id = ? AND conflict_artifact_id = ?").run(blockedMerge.headSha, blockedMerge.treeSha, blockedMerge.headSha, blockedMerge.treeSha, executionId, blockedVerificationArtifact.id, failure.code, failure.message, now, input.taskId, input.companyId, input.conflictArtifact.id);
          db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, result_commit = ?, result_tree = ?, status = 'blocked', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, blockedMerge.headSha, blockedMerge.treeSha, now, input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
        });
        return { outcome: "verification_blocked", developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, resultCommit: blockedMerge.headSha, resultTree: blockedMerge.treeSha, evidenceArtifactId: evidence.id, verificationArtifact: { id: blockedVerificationArtifact.id, kind: "forward-merge-verification" as const }, code: failure.code as "verification_failed" | "verification_timed_out" | "verification_evidence_too_large", summary: failure.message };
      }
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId);
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
      worktreePath = await scopedRepository(this.config.worktreeRoot, input.worktreePath);
      this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET worktree_path = ? WHERE id = ?").run(worktreePath, executionId));
      this.database.authQuery((db) => db.prepare("UPDATE forge_delivery_repairs SET worktree_path = ? WHERE id = ?").run(worktreePath, repairAttemptId));
      rawSessionId = await this.sessionStore.read(input.developerSessionRef) ?? "";
      if (!rawSessionId) throw new AgentFailure("session-conflict", "Developer session reference is invalid");
      const repairPrompt = this.repairPrompt(input.blockingFindings, { branchName: input.branchName, worktreePath, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree });
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
        const gitState = await this.worktrees.inspectDelivery(worktreePath);
        const repairArtifact = await this.artifacts.putArtifact(input.companyId, "developer-repair", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ ...report, cycle: input.cycle, reviewId: input.reviewId, supersedesExecutionId: input.developerExecutionId }, null, 2), "utf8") });
        const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
        const blocked = report.blocker !== null;
        this.database.authTransaction((db) => {
          const row = db.prepare("SELECT id FROM forge_delivery_repairs WHERE developer_execution_id = ? AND cycle = ?").get(executionId, input.cycle) as { id: string } | undefined;
          const failureCode = blocked ? "process-failed" : null;
          const failureSummary = blocked ? report.blocker : null;
          db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(blocked ? "blocked" : "completed", this.now().toISOString(), this.now().toISOString(), gitState.headSha, gitState.treeSha, gitState.dirtyState, repairArtifact.id, evidence.id, executionId);
          db.prepare("UPDATE forge_delivery_repairs SET status = ?, result_commit = ?, result_tree = ?, delivery_artifact_id = ?, evidence_artifact_id = ?, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ?").run(blocked ? "blocked" : "completed", gitState.headSha, gitState.treeSha, repairArtifact.id, evidence.id, failureCode, failureSummary, this.now().toISOString(), row?.id);
          return row?.id;
        });
        if (blocked) return DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, code: "process-failed", summary: report.blocker!, evidenceArtifactId: evidence.id, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState });
        return DeveloperRepairActivityResultSchema.parse({ outcome: "completed", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: "clean", deliveryArtifactId: repairArtifact.id, evidenceArtifactId: evidence.id, summary: report.summary });
      } finally { clearInterval(heartbeat); }
    } catch (error) {
      if (isSupervisorTerminalError(error)) throw error;
      const expectedFailure = error instanceof AgentFailure;
      const failure = error instanceof AgentFailure ? error : new AgentFailure("developer-repair-failed", "Codex Developer repair failed");
      const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
      const code = repairBlockCode(failure);
      const expected = expectedFailure && ["invalid-output", "session-conflict", "authentication-required", "rate-limited", "process-failed", "evidence-too-large"].includes(code);
      let observed: { headSha: string; treeSha: string; dirtyState: "clean" | "dirty" } | undefined;
      try {
        const observedPath = await scopedRepository(this.config.worktreeRoot, worktreePath);
        const gitState = await this.worktrees.inspectDelivery(observedPath);
        observed = { headSha: gitState.headSha, treeSha: gitState.treeSha, dirtyState: gitState.dirtyState };
      } catch { /* Preserve the typed blocker even when the worktree can no longer be inspected. */ }
      const effectiveCode = code;
      const effectiveSummary = failure.message;
      const effectiveExpected = expected;
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, result_commit = ?, result_tree = ?, dirty_state = ?, evidence_artifact_id = ? WHERE id = ?").run(effectiveExpected ? "blocked" : "failed", this.now().toISOString(), this.now().toISOString(), effectiveCode, effectiveSummary, observed?.headSha ?? null, observed?.treeSha ?? null, observed?.dirtyState ?? null, evidence.id, executionId);
        if (repairRowCreated) db.prepare("UPDATE forge_delivery_repairs SET status = ?, result_commit = ?, result_tree = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ?, finished_at = ? WHERE developer_execution_id = ? AND cycle = ?").run(effectiveExpected ? "blocked" : "failed", observed?.headSha ?? null, observed?.treeSha ?? null, effectiveCode, effectiveSummary, evidence.id, this.now().toISOString(), executionId, input.cycle);
      });
      if (!effectiveExpected) throw error;
      return DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, code: effectiveCode, summary: effectiveSummary, evidenceArtifactId: evidence.id, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: observed?.headSha ?? null, resultTree: observed?.treeSha ?? null, dirtyState: observed?.dirtyState ?? null });
    } finally { await guard?.cleanup(); }
  }

  /* Historic repair-authority validation is retained in replay data only.
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
  */

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
    const planText = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: plan.planStoragePath, sha256: plan.planSha256 })).toString("utf8");
    const evidenceText = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: plan.ciEvidenceStoragePath, sha256: plan.ciEvidenceSha256 })).toString("utf8");
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
      if (gitState.branchName !== input.branchName || gitState.dirtyState !== "clean" || report.blocker !== null) throw new AgentFailure("ci-repair-revision-invalid", "CI repair did not leave a clean task branch");
      const delivery = await this.artifacts.putArtifact(input.companyId, "developer-repair", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ ...report, ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, priorCommit: input.priorCommit, priorTree: input.priorTree }, null, 2), "utf8") });
      const evidence = await this.artifacts.putArtifact(input.companyId, "ci-repair-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      const now = this.now().toISOString();
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(delivery.id, delivery.companyId, delivery.kind, delivery.filename, delivery.mimeType, delivery.byteSize, delivery.sha256, delivery.storagePath, delivery.createdAt, evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?").run(now, now, gitState.headSha, gitState.treeSha, delivery.id, evidence.id, executionId);
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
      this.database.authTransaction((db) => { db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt); db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId); ; db.prepare("UPDATE forge_ci_repairs SET status = 'failed', failure_code = ?, summary = ?, evidence_artifact_id = ?, completed_at = ? WHERE id = ?").run(failure.code, failure.message, evidence.id, this.now().toISOString(), repairId); });
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
    return `You are Forge's Integrator, continuing the same authenticated session in the same worktree and branch: your job is to get the Builder's branch merged, so fix what CI reported. Apply only the intended CI repair scope below. The plan describes intent and scope, not an exact file manifest; if the repository has changed, implement that intent against the current tree and note the deviation in the summary. Only report incomplete when the repair intent itself cannot be achieved. Do not create a PR, use provider commands, rerun CI, merge, rebase, amend, reset, clean, force-push, or rewrite history. Run the complete pinned local verification. Create one or more ordinary local commits as required; do not amend or rewrite commits that already exist on the branch. Leave the worktree clean, and return exactly one JSON object with no markdown fences or commentary matching: {"summary":"...","blocker":null}. Use no other keys.\n\nCoordinates: ${JSON.stringify(input)}\nCI repair plan:\n${plan}`;
  }

  private repairPrompt(findings: DeliveryFinding[], worktree: { branchName: string; worktreePath: string; targetBaseSha: string; subjectCommit: string; subjectTree: string }): string {
    return [
      'You are Forge\'s authenticated Developer continuing the same Developer session. Address the Lead\'s blocking findings below in the existing issue worktree. Do not redesign the authorized plan, modify another checkout, use GitHub or any provider, push, create a pull request, merge, rebase, amend, reset, clean, or rewrite history. Run relevant local verification and commit any changes you make. Return exactly one JSON object with no markdown fences or commentary matching: {"summary":"...","blocker":null}. Use blocker only when the repair cannot be completed.',
      `Lead findings:\n${JSON.stringify(findings)}`,
      `Worktree coordinates:\n${JSON.stringify(worktree)}`,
    ].join("\n\n");
  }

  private prompt(title: string, brief: string, plan: string, evidence: string, worktree: { branchName: string; worktreePath: string; targetBaseSha: string }, runProjectTests?: boolean, visualEvidence?: "off" | "capture" | "required", operatorNote?: string): string {
    const controls = [runProjectTests === false ? "Do not run the project's configured verification suite; it was intentionally skipped for this task. You may run focused checks when useful." : "Run appropriate local verification, including the configured project suite when it applies.", visualEvidence === "required" ? "Visual evidence is required: capture relevant visual evidence and report its paths in visualEvidence. Missing evidence will block delivery review." : visualEvidence === "capture" ? "Capture visual evidence when it helps demonstrate the change, and report any paths in visualEvidence." : "Do not spend time capturing visual evidence unless the work itself needs it."].join(" ");
    return renderPrompt(this.prompts.get("developer/execution.md")!, { title, brief, plan, lead_evidence: evidence, branch_name: worktree.branchName, worktree_path: worktree.worktreePath, target_base_sha: worktree.targetBaseSha, controls, operator_note_section: operatorNote ? `\n\nOperator note (verbatim):\n${operatorNote}` : "" });
  }
  private pinnedPrompts(configuration: { prompts?: { artifactId: string; sha256: string } | undefined }, companyId: string): ReadonlyMap<string, string> {
    if (!configuration.prompts) return loadDefaultPrompts();
    const artifact = this.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-prompt-set'").get(configuration.prompts!.artifactId, companyId) as { storage_path: string } | undefined);
    if (!artifact) throw new AgentFailure("scoped-input-missing", "Pinned task prompts are unavailable");
    return new Map(Object.entries(jsonRequired(this.artifacts.getArtifactSync({ companyId, storagePath: artifact.storage_path, sha256: configuration.prompts.sha256 }).toString("utf8")) as Record<string, string>));
  }


  private async heartbeat(executionId: string): Promise<void> {
    this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(this.now().toISOString(), executionId));
  }

  private async persistEvidence(companyId: string, lines: string[], stableKey?: string): Promise<StoredArtifact> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const artifactInput = { filename: stableKey ? `${stableKey.split(":")[0]}.jsonl` : `developer_${randomBytes(12).toString("hex")}.jsonl`, mimeType: "application/x-ndjson", bytes: content.length ? content : Buffer.from("{\"type\":\"empty\"}\n") };
    void stableKey;
    return this.artifacts.putArtifact(companyId, "agent-evidence", artifactInput);
  }
}
