import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";

import { z } from "zod";
import type { AgentProviderKind } from "./agent-providers/provider.js";
import type Database from "better-sqlite3";

import type { ForgeConfig } from "./config.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { AgentFailure } from "./agent-failure.js";
import type { AgentProvider } from "./agent-providers/provider.js";
import { CliHerdrClient } from "./herdr-client.js";
import { HerdrTurnRunner, type HerdrTurnInput, type HerdrTurnOutput } from "./herdr-turn-runner.js";
import { HerdrSessionStore } from "./herdr-session-store.js";
import { IssueTimelineEvents } from "./issue-timeline-events.js";
import type { ForgeDatabase } from "./database.js";
import { redact } from "./logging.js";
import type { GithubReleasePort } from "./github-release.js";
import { createGitCommandGuard, WorktreeFailure, WorktreeManager } from "./worktrees.js";
import { readEnvironmentSettings } from "./environment-settings.js";
import { ForwardMergeConflictArtifactSchema, type ForwardMergeConflictArtifact } from "./forward-merge.js";
import { runPinnedVerification } from "./verification.js";
import { loadTaskConfiguration } from "./task-project-configuration.js";
import { loadDefaultPrompts, loadPromptCatalog, renderPrompt, type PromptPath } from "./prompts.js";
import { isVersionedPromptSet, resolvePromptSet, type PromptOverrideRow } from "./prompt-resolution.js";
import { DeliveryReviewSubjectSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, type CiRepairActivityInput, type CiRepairActivityResult, type DeliveryFinding, type DeliveryOperationBlockCode, type DeveloperExecutionActivityInput, type DeveloperExecutionResult, type DeveloperRepairActivityInput, type DeveloperRepairActivityResult, type DeveloperSupervisorActivityIdentity, type MergeConflictResolutionActivityInput, type MergeConflictResolutionActivityResult } from "./engine/issue-contracts.js";
import { buildGitBranchName } from "./git-branch-name.js";
import { fallbackGitPresentation } from "./git-presentation.js";
import { jsonRequired } from "./task-utils.js";
import { ensureResultSchema } from "./result-schema-files.js";
import { runCommand } from "./command-runner.js";
import { BrowserProofFailure, BrowserProofService, normalizeBrowserProofPath, normalizeBrowserProofPaths, type DurableBrowserProof } from "./browser-proof.js";
export { DeveloperDeliveryReportSchema, DeveloperMergeConflictResolutionReportSchema, DeveloperObjectionSchema, DeveloperRepairReportSchema } from "./turn-result-schemas.js";
import { DeveloperDeliveryReportSchema, DeveloperMergeConflictResolutionReportSchema, DeveloperRepairReportSchema } from "./turn-result-schemas.js";

type OperationExecution = { signal?: AbortSignal | undefined };
type OperationAware = OperationExecution;

const IDENTITY_FAILURE_CODES = new Set(["developer-scope-mismatch", "developer-execution-identity-conflict", "stale-reviewed-revision"]);

function developerFailure(error: unknown, fallbackCode: string, fallbackMessage: string, messagePrefix = ""): AgentFailure {
  const code = error instanceof AgentFailure ? error.code : fallbackCode;
  const message = error instanceof AgentFailure ? error.message : `${messagePrefix}${error instanceof Error ? error.message : fallbackMessage}`;
  const nonRetryable = error instanceof AgentFailure && error.nonRetryable
    || IDENTITY_FAILURE_CODES.has(code)
    || /scope mismatch|does not match/i.test(message);
  return new AgentFailure(code, message, { nonRetryable });
}

async function git(args: string[], cwd: string, timeout = 8_000): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd, timeout });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || `git ${args[0] ?? "command"} failed`);
  return result.stdout.trim();
}

export async function verifyCiRepairDelivery(worktreePath: string, branchName: string, priorCommit: string, priorTree: string): Promise<{ commit: string; tree: string; branch: string }> {
  try {
    const [commit, tree, branch] = await Promise.all([
      git(["rev-parse", "--verify", `${priorCommit}^{commit}`], worktreePath),
      git(["rev-parse", "--verify", `${priorCommit}^{tree}`], worktreePath),
      git(["symbolic-ref", "--short", "HEAD"], worktreePath),
    ]);
    if (commit.toLowerCase() !== priorCommit.toLowerCase() || tree.toLowerCase() !== priorTree.toLowerCase() || branch !== branchName) throw new Error("delivery does not match");
    return { commit, tree, branch };
  } catch {
    throw new AgentFailure("ci-repair-identity-mismatch", "CI repair does not match the original Developer delivery");
  }
}

export type RepairCoverage = { findingId: string; path: string; touched: boolean };

export function repairCoverage(findings: DeliveryFinding[], touchedFiles: Iterable<string>): RepairCoverage[] {
  const touched = new Set(touchedFiles);
  const paths = /(?:^|[\s`"'(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/g;
  return findings.flatMap((finding) => {
    const named = new Set<string>();
    for (const text of [finding.evidenceRef, finding.repairInstruction ?? ""]) {
      for (const match of text.matchAll(paths)) named.add(match[1]!.replace(/[.,;:]+$/, ""));
    }
    return [...named].map((path) => ({ findingId: finding.findingId, path, touched: touched.has(path) }));
  });
}

export async function finalizeDeveloperSourceCommit(worktreePath: string, targetBaseSha: string, reportedPaths: string[]): Promise<{ headSha: string; treeSha: string }> {
  reportedPaths = [...new Set(reportedPaths.map(normalizeBrowserProofPath))];
  for (const path of reportedPaths) {
    const indexed = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "git", args: ["ls-files", "--error-unmatch", "--", path], cwd: worktreePath, timeout: 8_000 });
    if (indexed.exitCode !== 0) continue;
    const existedAtBase = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "git", args: ["cat-file", "-e", `${targetBaseSha}:${path}`], cwd: worktreePath, timeout: 8_000 });
    if (existedAtBase.exitCode !== 0) await git(["rm", "--cached", "--ignore-unmatch", "--", path], worktreePath, 30_000);
  }
  await git(["add", "-A", "--", ".", ":(exclude).forge-proof", ":(exclude).forge-proof/**"], worktreePath, 30_000);
  const sourcePathspec = [".", ":(exclude).forge-proof", ":(exclude).forge-proof/**"];
  const staged = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "git", args: ["diff", "--cached", "--quiet", "--", ...sourcePathspec], cwd: worktreePath, timeout: 30_000 });
  if (staged.exitCode === 1) await git(["-c", "user.name=Forge Builder", "-c", "user.email=builder@forge.invalid", "commit", "-m", "wip: builder", "--", ...sourcePathspec], worktreePath, 30_000);
  else if (staged.exitCode !== 0) throw new AgentFailure("developer-git-state-invalid", "Developer staged state could not be inspected");
  return { headSha: await git(["rev-parse", "HEAD"], worktreePath), treeSha: await git(["rev-parse", "HEAD^{tree}"], worktreePath) };
}

export function buildDeveloperExecutionPrompt(input: { executionId: string; reuseWorktree: boolean; startingSha: string; verificationSteps: string; operatorNote?: string; continuation?: { completedSteps: number[]; remainingSteps: number[]; previousCommit: string; previousDeliverySummary: string } }): string {
  const worktreeInstruction = input.reuseWorktree
    ? ` This is a linked retry: preserved work on this branch is yours to continue. If \`git merge-base --is-ancestor ${input.startingSha} HEAD\` fails, bring the branch up to date first: \`git rebase ${input.startingSha}\` (preferred; resolve conflicts) or, if the rebase is messy, \`git merge ${input.startingSha}\`. Never discard preserved commits; never reset to the base.`
    : " This is a fresh turn: the worktree is at the accepted starting SHA with no prior work; you must make the change.";
  const gitRestriction = input.reuseWorktree
    ? "Do not push, create PRs, reset, clean, force, or use provider mutation. Do not amend or rewrite commits that already exist on the branch unless rebasing onto the target base requires it."
    : "Do not push, create PRs, merge, rebase, amend, reset, clean, force, or use provider mutation.";
  if (input.continuation) input.operatorNote = [input.operatorNote, `You already completed steps ${input.continuation.completedSteps.join(", ")} in commit ${input.continuation.previousCommit} (summary: ${input.continuation.previousDeliverySummary}). Continue with steps ${input.continuation.remainingSteps.join(", ")} in the same worktree. Do not redo completed steps. Commit after each completed step.`].filter(Boolean).join(" ");
  return `You are Forge's Developer. Execute only the authorized final plan in this isolated worktree. The final plan is staged at .forge-context/${input.executionId}/final-plan.json. Read only the other files under that execution directory. Current target base SHA: ${input.startingSha}. The plan describes intent and scope, not an exact file manifest. If the repository has changed (files moved/renamed/deleted, migrations regenerated), implement the intent against the current tree and note the deviation in the step notes. Only report incomplete when the intent itself cannot be achieved. If a step requires deployment, physical devices, production access, external services, an unrelated pre-existing test failure, or a local server that cannot start, mark it \`not_applicable_locally\` with a one-line reason and continue with the remaining steps.${worktreeInstruction}${input.operatorNote ? ` Operator note (verbatim): ${input.operatorNote}` : ""} During execution, post concise public progress updates before each substantive action and after notable results: say what you are inspecting, changing, or verifying and why, without exposing private chain-of-thought. Create one or more ordinary local commits for the authorized work when new commits are required; do not amend or rewrite commits that already exist on the branch unless rebasing onto the target base requires it. Leave the worktree clean, and return exactly one JSON object with no markdown fences or commentary matching: {"kind":"delivery","summary":"...","steps":[{"number":1,"status":"completed|incomplete|not_completed|blocked|not_applicable_locally","filesChanged":[],"notes":"..."}],"authorizedStepsNotCompleted":[],"resultCommit":"40+ hex","resultTree":"40+ hex","dirtyState":"clean","blocker":null}. Include every approved step number once and keep filesChanged to changed paths. For any incomplete, not_completed, or blocked step, list its number in authorizedStepsNotCompleted and provide a non-null blocker. Forge will run the accepted pinned setup and final verification independently after the Developer process exits. Expected plan verification commands for context:\n${input.verificationSteps}\n${gitRestriction}`;
}



type RepairBlockCode = DeliveryOperationBlockCode;
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
export type DeveloperDeliveryReport = z.infer<typeof DeveloperDeliveryReportSchema>;

interface DeveloperContext {
  title: string;
  normalizedJson: string;
  description: string | null;
  legacyBriefStoragePath: string | null;
  legacyBriefSha256: string | null;
  planStoragePath: string;
  planSha256: string;
  evidenceStoragePath: string;
  evidenceSha256: string;
}

interface DeveloperProfile {
  id: string;
  model: string;
  provider: AgentProviderKind;
  reasoningLevel: "low" | "medium" | "high" | "xhigh";
  servicePriority: "standard" | "priority" | "fast";
}

interface PriorDeveloperExecution {
  id: string;
  status: string;
  branch_name: string;
  worktree_path: string;
  target_base_sha: string;
}

interface DeveloperExecutionIdentity {
  taskId: string | null;
  companyId: string | null;
  workflowId: string | null;
  planRevision: number | null;
  attempt: number | null;
  status: string;
  failureCode: string | null;
  branchName: string | null;
  worktreePath: string | null;
  targetBaseSha: string | null;
  supersedesExecutionId: string | null;
  sessionRef: string | null;
}

type DeveloperExecutionCoordinates = Omit<DeveloperExecutionIdentity, "status" | "failureCode">;

export interface DeveloperServiceOptions {
  command?: string;
  provider?: AgentProvider;
  turnRunner?: { run<T>(input: HerdrTurnInput<T>): Promise<HerdrTurnOutput<T>> };
  worktrees?: WorktreeManager;
  now?: () => Date;
  github?: Pick<GithubReleasePort, "getPullRequest">;
  githubObservation?: unknown;
  prompts?: ReadonlyMap<string, string>;
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
  const runGit = async (args: string[]): Promise<string> => git(args, worktreePath);
  try {
    if (await runGit(["rev-parse", "--abbrev-ref", "HEAD"]) !== branchName) return false;
    if ((await runGit(["rev-parse", "HEAD"])).toLowerCase() === priorCommit.toLowerCase()) return true;
    await runGit(["merge-base", "--is-ancestor", priorCommit, "HEAD"]);
    await runGit(["merge-base", "--is-ancestor", await runGit(["rev-parse", `refs/remotes/origin/${branchName}`]), priorCommit]);
    await runGit(["reset", "--hard", priorCommit]);
    return true;
  } catch { return false; }
}

export class DeveloperService {
  private readonly artifacts: ArtifactStore;
  private readonly browserProof: BrowserProofService;
  private readonly turnRunner: { run<T>(input: HerdrTurnInput<T>): Promise<HerdrTurnOutput<T>> };
  private readonly roleSessions: HerdrSessionStore;
  private readonly worktrees: WorktreeManager;
  private readonly now: () => Date;
  private readonly github: Pick<GithubReleasePort, "getPullRequest"> | undefined;
  private prompts: ReadonlyMap<string, string>;


  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig, options: DeveloperServiceOptions = {}) {
    this.artifacts = new ArtifactStore(config.artifactRoot, database);
    this.browserProof = new BrowserProofService(database, this.artifacts);
    const herdr = new CliHerdrClient();
    this.roleSessions = new HerdrSessionStore(database, herdr);
    this.turnRunner = options.turnRunner ?? new HerdrTurnRunner(database, herdr, this.roleSessions, new IssueTimelineEvents(database));
    this.worktrees = options.worktrees ?? new WorktreeManager(undefined, () => readEnvironmentSettings(database).minFreeDiskGb);
    this.now = options.now ?? (() => new Date());
    this.github = options.github;
    this.prompts = options.prompts ?? loadDefaultPrompts();
  }

  private bindCapacityInTransaction(_db: Database.Database, _input: { capacityRequestId?: string | undefined }, _executionId: string, _sessionRef?: string, _worktreePath?: string): void {}

  private taskContext(input: { taskId: string; projectId?: string; companyId: string; workflowId: string }): { taskId: string; projectId: string; projectSlug: string; issueKey?: string } {
    const task = this.database.authQuery((db) => db.prepare(`SELECT t.project_id AS projectId, p.name AS projectSlug,
      CASE WHEN c.issue_code IS NOT NULL AND t.issue_number IS NOT NULL THEN c.issue_code || '-' || t.issue_number ELSE NULL END AS issueKey
      FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_companies c ON c.id = t.company_id
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND (? IS NULL OR t.project_id = ?)`).get(input.taskId, input.companyId, input.workflowId, input.projectId ?? null, input.projectId ?? null) as { projectId: string; projectSlug: string; issueKey: string | null } | undefined);
    if (!task) throw new AgentFailure("scoped-input-missing", "Developer task context is unavailable");
    return { taskId: input.taskId, projectId: task.projectId, projectSlug: task.projectSlug, ...(task.issueKey ? { issueKey: task.issueKey } : {}) };
  }

  private requireDeveloperSession(sessionRef: string): void {
    if (!this.roleSessions.readRoleSession(sessionRef)) throw new AgentFailure("invalid-session-reference", "Developer session reference is invalid");
  }

  private executionProfile(_input: { capacityRequestId?: string | undefined }, profileId?: string): DeveloperProfile | undefined {
    if (!profileId) return undefined;
    const profile = this.database.authQuery((db) => db.prepare("SELECT id, model, provider, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE id = ?").get(profileId) as DeveloperProfile | undefined);
    if (!profile) throw new AgentFailure("developer-profile-unavailable", `Developer profile ${profileId} is unavailable`);
    return profile;
  }

  private developerProfile(): DeveloperProfile {
    const profile = this.database.authQuery((db) => db.prepare("SELECT id, model, provider, reasoning_level AS reasoningLevel, service_priority AS servicePriority FROM forge_profiles WHERE provider = 'codex' ORDER BY id LIMIT 1").get() as DeveloperProfile | undefined);
    if (!profile) throw new AgentFailure("developer-profile-unavailable", "The build requires an allowed Codex profile");
    return profile;
  }

  private reAdoptOrphanExecution(executionId: string, existing: DeveloperExecutionIdentity, coordinates: Partial<DeveloperExecutionCoordinates>, startedAt: string): boolean {
    const matches = (Object.keys(coordinates) as Array<keyof DeveloperExecutionCoordinates>).every((key) => existing[key] === null || existing[key] === coordinates[key]);
    if (!matches || existing.status !== "failed") return false;
    return this.database.authTransaction((db) => db.prepare(`UPDATE forge_developer_executions
      SET status = 'starting', failure_code = NULL, failure_summary = NULL, finished_at = NULL, started_at = ?, heartbeat_at = ?, current_step = NULL
      WHERE id = ? AND status = 'failed'
        `).run(startedAt, startedAt, executionId).changes === 1);
  }

  async run(rawInput: DeveloperExecutionActivityInput & Partial<DeveloperSupervisorActivityIdentity>): Promise<DeveloperExecutionResult> {
    const input = rawInput;
    const context = this.database.authQuery((db) => db.prepare(`SELECT t.title, t.description, b.storage_path AS legacyBriefStoragePath, b.sha256 AS legacyBriefSha256, pa.storage_path AS planStoragePath, pa.sha256 AS planSha256, ea.storage_path AS evidenceStoragePath, ea.sha256 AS evidenceSha256, e.id AS outputId, e.original_plan_revision AS originalPlanRevision, e.output_revision AS outputRevision, e.final_version AS finalVersion, e.output_artifact_id AS artifactId, pa.sha256 AS artifactSha256, e.session_ref AS leadSessionRef, e.id AS leadExecutionId, e.evidence_manifest_artifact_id AS evidenceManifestArtifactId, em.sha256 AS evidenceManifestSha256
      FROM forge_tasks t
      LEFT JOIN forge_artifacts b ON b.id = t.brief_artifact_id AND b.kind = 'task-brief' JOIN forge_agent_executions e ON e.output_artifact_id = ? AND e.task_id = t.id AND e.workflow_id = t.workflow_id
      JOIN forge_artifacts pa ON pa.id = e.output_artifact_id JOIN forge_artifacts ea ON ea.id = e.evidence_artifact_id
      LEFT JOIN forge_artifacts em ON em.id = e.evidence_manifest_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.project_id = ?`).get(input.leadOutputArtifactId, input.taskId, input.companyId, input.projectId) as DeveloperContext & { outputId?: string; originalPlanRevision?: number; outputRevision?: number; finalVersion?: number; artifactId?: string; artifactSha256?: string; leadSessionRef?: string; leadExecutionId?: string; evidenceManifestArtifactId?: string; evidenceManifestSha256?: string } | undefined);
    if (!context) throw new AgentFailure("scoped-input-missing", "Authorized Lead delivery evidence is unavailable");
    const taskConfiguration = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
    const projectRevision = ProjectRevisionSchema.safeParse(taskConfiguration);
    if (!projectRevision.success) throw new AgentFailure("scoped-input-missing", "Pinned project execution configuration is unavailable");
    const promptsRepinned = (input.developerAttempt ?? 1) > 1;
    this.prompts = promptsRepinned
      ? this.currentPrompts(taskConfiguration.projectId)
      : this.pinnedPrompts(taskConfiguration, input.companyId);
    const repositoryPath = await scopedRepository(this.config.repositoryRoot, projectRevision.data.repositoryPath);
    const brief = context.description ?? (() => {
      if (!context.legacyBriefStoragePath || !context.legacyBriefSha256) throw new AgentFailure("scoped-input-missing", "Task description is unavailable");
      const migrated = this.artifacts.getArtifactSync({ companyId: input.companyId, storagePath: context.legacyBriefStoragePath, sha256: context.legacyBriefSha256 }).toString("utf8");
      this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET description = ? WHERE id = ? AND company_id = ? AND description IS NULL").run(migrated, input.taskId, input.companyId));
      return migrated;
    })();
    const [planText, leadEvidence] = await Promise.all([
      this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.planStoragePath, sha256: context.planSha256 }).then((bytes) => bytes.toString("utf8")),
      this.artifacts.getArtifact({ companyId: input.companyId, storagePath: context.evidenceStoragePath, sha256: context.evidenceSha256 }).then((bytes) => bytes.toString("utf8")),
    ]);
    const plan = jsonRequired(planText) as { kind?: unknown; steps?: Array<{ number: number; instruction: string; verification: string }> };
    if (plan.kind !== "plan" || !Array.isArray(plan.steps) || !plan.steps.length) throw new AgentFailure("plan-unavailable", "A final Lead plan is required before development");
    const profile = this.executionProfile(input, input.roleProfiles.builder);
    const prior = input.supersedesExecutionId
      ? this.database.authQuery((db) => db.prepare("SELECT id, status, branch_name, worktree_path, target_base_sha FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.supersedesExecutionId, input.taskId, input.companyId, input.workflowId) as PriorDeveloperExecution | undefined)
      : this.database.authQuery((db) => db.prepare("SELECT id, status, branch_name, worktree_path, target_base_sha FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND plan_revision = ? AND status IN ('interrupted', 'cancelled', 'failed', 'blocked') ORDER BY attempt DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.planRevision) as PriorDeveloperExecution | undefined);
    // A re-plan legitimately continues on top of a completed attempt (same branch and worktree), and a prior id the
    // workflow minted but never persisted means a fresh start; only a still-running attempt must not be superseded.
    if (prior && ["starting", "running", "reconnecting", "cancelling", "result_pending_claim"].includes(prior.status)) throw new AgentFailure("retry-not-available", "The previous Developer attempt is still running");
    const revisionAuthorization = input.revisionRequestId ? this.database.authQuery((db) => db.prepare(`SELECT id, disposition, status, authorized_plan_revision AS authorizedPlanRevision, worktree_path AS worktreePath, branch_name AS branchName, base_sha AS baseSha, head_sha AS headSha, tree_sha AS treeSha, exact_base_sha AS exactBaseSha
      FROM forge_plan_revision_requests WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.revisionRequestId, input.taskId, input.companyId, input.workflowId) as { id: string; disposition: "reuse" | "new"; status: "accepted" | "authorized"; authorizedPlanRevision: number | null; worktreePath: string | null; branchName: string | null; baseSha: string | null; headSha: string | null; treeSha: string | null; exactBaseSha: string | null } | undefined) : undefined;
    if (input.revisionRequestId && (!revisionAuthorization || revisionAuthorization.status !== "authorized" || revisionAuthorization.authorizedPlanRevision !== input.planRevision)) throw new AgentFailure("revision-not-authorized", "The build is not authorized for this plan revision");
    const executionId = input.developerTurnExecutionId ?? input.executionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const existing = this.database.authQuery((db) => db.prepare("SELECT task_id AS taskId, company_id AS companyId, workflow_id AS workflowId, plan_revision AS planRevision, attempt, status, failure_code AS failureCode, branch_name AS branchName, worktree_path AS worktreePath, target_base_sha AS targetBaseSha, supersedes_execution_id AS supersedesExecutionId, session_ref AS sessionRef FROM forge_developer_executions WHERE id = ?").get(executionId) as DeveloperExecutionIdentity | undefined);
    const sourceBranch = taskConfiguration.source?.kind === "pull_request" ? taskConfiguration.source.headBranch : taskConfiguration.source?.kind === "branch" ? taskConfiguration.source.branch : undefined;
    const pinnedBase = existing?.targetBaseSha ?? prior?.target_base_sha ?? (revisionAuthorization?.disposition === "new" ? revisionAuthorization.exactBaseSha : revisionAuthorization?.baseSha);
    // Build on the base branch as it is right now: the project-revision snapshot goes stale
    // the moment another task merges. A recorded execution base stays authoritative on retry.
    const targetBaseSha = pinnedBase ?? await this.worktrees.currentBaseSha(repositoryPath, projectRevision.data.baseBranch).catch(() => projectRevision.data.targetSha);
    if (!/^[a-f0-9]{40,64}$/i.test(targetBaseSha)) throw new AgentFailure("pinned-revision-missing", "The accepted project revision does not contain an exact target SHA");
    let branchName = sourceBranch ?? prior?.branch_name ?? buildGitBranchName({ branchSlug: fallbackGitPresentation(context.title).branchSlug, taskId: input.taskId });
    const worktreeRoot = await scopedRepository(this.config.worktreeRoot, projectRevision.data.worktreeRoot);
    const attempt = input.developerAttempt ?? Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    const supersedesExecutionId = prior?.id === executionId ? null : prior?.id ?? null;
    const startedAt = this.now().toISOString();
    const reopened = existing ? this.reAdoptOrphanExecution(executionId, existing, { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, attempt, branchName, targetBaseSha, supersedesExecutionId }, startedAt) : false;
    if (existing && !reopened && (existing.taskId !== input.taskId || existing.companyId !== input.companyId || existing.workflowId !== input.workflowId || existing.planRevision !== input.planRevision || existing.attempt !== attempt || existing.branchName !== branchName || existing.targetBaseSha !== targetBaseSha || existing.supersedesExecutionId !== supersedesExecutionId || !["starting", "running"].includes(existing.status))) throw new AgentFailure("developer-execution-identity-conflict", "The deterministic build ID is already bound to different coordinates", { nonRetryable: true });
    let worktree;
    try {
      if (existing && !reopened) {
        worktree = { branchName: existing.branchName!, worktreePath: await scopedRepository(this.config.worktreeRoot, existing.worktreePath!), targetBaseSha: existing.targetBaseSha! };
      } else if (sourceBranch) {
        worktree = await this.worktrees.adopt({ repositoryPath, worktreeRoot, taskId: input.taskId, branchName: sourceBranch, baseBranch: projectRevision.data.baseBranch, ...(taskConfiguration.source?.headSha ? { sourceHeadSha: taskConfiguration.source.headSha } : {}), preserveLocal: Boolean(prior || input.reuseWorktree) });
      } else if (revisionAuthorization?.disposition === "reuse") {
        if (!revisionAuthorization.worktreePath || !revisionAuthorization.branchName || !revisionAuthorization.baseSha || !revisionAuthorization.headSha || !revisionAuthorization.treeSha) throw new AgentFailure("revision-coordinates-missing", "Authorized preserved worktree coordinates are incomplete");
        const inspected = await this.worktrees.inspectForPlanRevision({ repositoryPath, worktreeRoot, worktreePath: revisionAuthorization.worktreePath, branchName: revisionAuthorization.branchName, baseSha: revisionAuthorization.baseSha, resultCommit: revisionAuthorization.headSha, resultTree: revisionAuthorization.treeSha });
        branchName = inspected.branchName;
        worktree = { branchName: inspected.branchName, worktreePath: revisionAuthorization.worktreePath, targetBaseSha: inspected.baseSha };
      } else if (revisionAuthorization?.disposition === "new") {
        branchName = `${buildGitBranchName({ branchSlug: fallbackGitPresentation(context.title).branchSlug, taskId: input.taskId })}-r${input.planRevision}`;
        worktree = await this.worktrees.create({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName, pathSegment: `${input.taskId}-revision-${input.planRevision}` });
      } else {
        worktree = await this.worktrees.reuse({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha, branchName });
      }
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      if (error instanceof Error && "code" in error) throw new AgentFailure(String((error as { code: string }).code), error.message);
      throw error;
    }
    this.database.authTransaction((db) => {
      if (reopened) db.prepare("UPDATE forge_developer_executions SET task_id = ?, company_id = ?, workflow_id = ?, plan_revision = ?, attempt = ?, branch_name = ?, worktree_path = ?, target_base_sha = ?, supersedes_execution_id = ? WHERE id = ?").run(input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, worktree.branchName, worktree.worktreePath, worktree.targetBaseSha, supersedesExecutionId, executionId);
      db.prepare(`INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, started_at, heartbeat_at, current_step) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`).run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, worktree.branchName, worktree.worktreePath, worktree.targetBaseSha, supersedesExecutionId, startedAt, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, existing && !reopened ? existing.sessionRef ?? undefined : undefined, worktree.worktreePath);
    });
    const prompt = this.prompt(context.title, brief, planText, leadEvidence, worktree, input.runProjectTests, input.visualEvidence, input.operatorNote, input.continuation, Boolean(prior || input.reuseWorktree));
    const evidenceLines = [
      JSON.stringify({ type: "forge.prompt", text: redact(prompt) }),
      ...(promptsRepinned ? [JSON.stringify({ type: "forge.prompts", promptsRepinned: true })] : []),
    ];
    let sessionRef: string | undefined = existing && !reopened ? existing.sessionRef ?? undefined : undefined;
    try {
        const task = this.taskContext(input);
        const priorTerminalExecutions = this.database.authQuery((db) => db.prepare("SELECT status, result_commit AS resultCommit FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND status IN ('blocked', 'completed') AND id <> ? ORDER BY started_at DESC LIMIT 2").all(input.taskId, input.companyId, input.workflowId, executionId) as Array<{ status: string; resultCommit: string | null }>);
        const noProgress = priorTerminalExecutions.length === 2
          && priorTerminalExecutions[0]!.status === "blocked"
          && priorTerminalExecutions[0]!.resultCommit !== null
          && priorTerminalExecutions[0]!.resultCommit === priorTerminalExecutions[1]!.resultCommit;
        if (noProgress) {
          await this.roleSessions.retireRoleSession(task.taskId, "builder");
          evidenceLines.push(JSON.stringify({ type: "forge.session", retired: "developer", reason: "no-progress-retry" }));
        }
        const turn = await this.turnRunner.run({ task: { ...task, worktreePath: worktree.worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "builder", ledger: "developer", executionId, promptKind: "implementation", prompt, profile: profile ?? this.developerProfile(), resultSchema: DeveloperDeliveryReportSchema, schemaPath: await ensureResultSchema(this.config.runtimeRoot, "developer-delivery", DeveloperDeliveryReportSchema), companyId: input.companyId, workflowId: input.workflowId, revision: input.planRevision });
        sessionRef = turn.roleSessionId;
        const execution = this.database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId) as { status: string } | undefined);
        if (!execution || !["starting", "running"].includes(execution.status)) throw new AgentFailure(execution?.status === "cancelled" ? "developer-cancelled" : "developer-superseded", "The build was cancelled before completion");
        const parsedReport = turn.result;
        let durableProof: DurableBrowserProof | undefined, proofBlocker: string | null = null;
        let reportedPaths: string[] = [];
        try { reportedPaths = normalizeBrowserProofPaths(parsedReport.visualEvidence); await this.browserProof.assertReportedProofUntracked(worktree.worktreePath, reportedPaths); }
        catch (error) { if (!(error instanceof Error)) throw error; proofBlocker = `${error.message}.`; reportedPaths = []; }
        const source = await finalizeDeveloperSourceCommit(worktree.worktreePath, worktree.targetBaseSha, reportedPaths);
        try { if (source) durableProof = await this.browserProof.ingest({ taskId: input.taskId, companyId: input.companyId, developerExecutionId: executionId, resultCommit: source.headSha, resultTree: source.treeSha, worktreePath: worktree.worktreePath, control: input.visualEvidence ?? "off", ...(parsedReport.visualEvidence ? { evidence: parsedReport.visualEvidence } : {}), onAdvisory: (note) => { proofBlocker = [proofBlocker, note].filter(Boolean).join(" "); } }); }
        catch (error) { if (!(error instanceof BrowserProofFailure)) throw error; proofBlocker = `${error.message}. Capture proof under .forge-proof/ and retry.`; }
        if (durableProof && parsedReport.visualEvidence) await this.browserProof.cleanupPersisted(worktree.worktreePath, parsedReport.visualEvidence, durableProof);
        const gitState = await this.worktrees.inspectDelivery(worktree.worktreePath, worktree.branchName);
        const delivery = { ...parsedReport, summary: proofBlocker ? `${parsedReport.summary}\n\nScreenshots: ${proofBlocker}` : parsedReport.summary, visualEvidence: durableProof, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState, branchName: worktree.branchName, worktreePath: worktree.worktreePath, targetBaseSha: worktree.targetBaseSha };
        const deliveryArtifact = await this.artifacts.putArtifact(input.companyId, "developer-delivery", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(delivery, null, 2), "utf8"), taskId: input.taskId });
        const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
        const blocked = delivery.blocker !== null;
        const activityResult = { developerExecutionId: executionId, developerSessionRef: sessionRef ?? executionId, worktreePath: worktree.worktreePath, branchName: worktree.branchName, targetBaseSha: worktree.targetBaseSha, currentStep: null, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState, deliveryArtifactId: deliveryArtifact.id, evidenceArtifactId: evidence.id, deliverySummary: parsedReport.summary, outcome: blocked ? "blocked" as const : "completed" as const, steps: parsedReport.steps.map(({ number, status }) => ({ number, status })), authorizedStepsNotCompleted: parsedReport.authorizedStepsNotCompleted, blocker: delivery.blocker };
        const terminalStatus = this.database.authTransaction((db) => {
          const updated = db.prepare("UPDATE forge_developer_executions SET status = ?, session_ref = ?, finished_at = ?, heartbeat_at = ?, current_step = NULL, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(blocked ? "blocked" : "completed", sessionRef, this.now().toISOString(), this.now().toISOString(), gitState.headSha, gitState.treeSha, gitState.dirtyState, deliveryArtifact.id, evidence.id, executionId);
          return updated.changes === 1 ? blocked ? "blocked" : "completed" : (db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId) as { status: string } | undefined)?.status;
        });
        if (terminalStatus === "cancelled" || terminalStatus === "interrupted") throw new AgentFailure("developer-cancelled", "The build was cancelled before completion");
        if (terminalStatus !== (blocked ? "blocked" : "completed")) throw new AgentFailure("developer-superseded", "The build was superseded before completion");
        return activityResult;
    } catch (error) {
      // Keep the real cause: a swallowed message made launch-path bugs look like Builder failures.
      const failure = developerFailure(error, "developer-failed", String(error), "Builder could not start: ");
      if (!(error instanceof AgentFailure)) console.error("Builder launch failed", executionId, error);
      const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
      this.database.authTransaction((db) => {
        const finishedAt = this.now().toISOString();
        db.prepare("UPDATE forge_developer_executions SET status = CASE WHEN status IN ('starting', 'running') THEN 'failed' ELSE status END, session_ref = COALESCE(session_ref, ?), finished_at = COALESCE(finished_at, ?), heartbeat_at = ?, failure_code = CASE WHEN status IN ('starting', 'running') THEN ? ELSE failure_code END, failure_summary = CASE WHEN status IN ('starting', 'running') THEN ? ELSE failure_summary END, evidence_artifact_id = COALESCE(evidence_artifact_id, ?) WHERE id = ?").run(sessionRef ?? null, finishedAt, finishedAt, failure.code, failure.message, evidence.id, executionId);
      });
      throw failure;
    } finally {}
  }



  async runMergeConflictResolution(rawInput: MergeConflictResolutionActivityInput & Partial<DeveloperSupervisorActivityIdentity> & OperationAware): Promise<MergeConflictResolutionActivityResult> {
    const input = { ...rawInput };
    // Workflow state may contain a deterministic turn ID from an interrupted
    // attempt. It is not proof that a matching execution was ever persisted.
    // The ledger is the source of truth for the worktree owner.
    const candidates = this.database.authQuery((db) => db.prepare(`SELECT id, branch_name AS branchName, worktree_path AS worktreePath, result_commit AS resultCommit, result_tree AS resultTree, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId
      FROM forge_developer_executions
      WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND branch_name = ?
      ORDER BY COALESCE(finished_at, started_at) DESC, rowid DESC`).all(input.taskId, input.companyId, input.workflowId, input.branchName) as Array<{ id: string; branchName: string; worktreePath: string; resultCommit: string | null; resultTree: string | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null }>);
    const planRow = this.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'merge-conflict-plan'").get(input.planArtifactId, input.companyId) as { storage_path: string; sha256: string } | undefined);
    if (!planRow) throw new AgentFailure("merge-resolution-identity-mismatch", "Merge-conflict resolution coordinates do not match the owned Developer worktree");
    let prior: { id: string; worktreePath: string; deliveryArtifactId: string | null; evidenceArtifactId: string | null } | undefined;
    for (const candidate of candidates) {
      if (!candidate.resultCommit || (input.worktreePath && candidate.worktreePath !== input.worktreePath)) continue;
      try {
        const worktreePath = await scopedRepository(this.config.worktreeRoot, candidate.worktreePath);
        const [commit, branch, commitTree, tree] = await Promise.all([
          git(["rev-parse", "--verify", `${candidate.resultCommit}^{commit}`], worktreePath),
          git(["symbolic-ref", "--short", "HEAD"], worktreePath),
          git(["rev-parse", "--verify", `${candidate.resultCommit}^{tree}`], worktreePath),
          candidate.resultTree ? git(["rev-parse", "--verify", `${candidate.resultTree}^{tree}`], worktreePath) : Promise.resolve(null),
        ]);
        if (commit.toLowerCase() !== candidate.resultCommit.toLowerCase() || branch !== input.branchName || (candidate.resultTree && (tree?.toLowerCase() !== candidate.resultTree.toLowerCase() || commitTree.toLowerCase() !== candidate.resultTree.toLowerCase()))) continue;
        prior = { id: candidate.id, worktreePath, deliveryArtifactId: candidate.deliveryArtifactId, evidenceArtifactId: candidate.evidenceArtifactId };
        break;
      } catch {
        // A ledger row is not delivery identity until its git objects resolve.
      }
    }
    if (prior) {
      input.developerExecutionId = prior.id;
      input.worktreePath = prior.worktreePath;
    }
    if (!input.worktreePath) {
      const configuration = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
      const [repositoryPath, worktreeRoot] = await Promise.all([scopedRepository(this.config.repositoryRoot, configuration.repositoryPath), scopedRepository(this.config.worktreeRoot, configuration.worktreeRoot)]);
      input.worktreePath = (await this.worktrees.reuse({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha: input.targetBaseSha, branchName: input.branchName })).worktreePath;
    }
    try {
      const inspected = await this.worktrees.inspectDelivery(input.worktreePath, input.branchName);
      if (inspected.branchName !== input.branchName) throw new AgentFailure("merge-resolution-identity-mismatch", "The owned Developer worktree branch does not match the recorded branch");
    } catch (error) {
      if (!(error instanceof WorktreeFailure) || error.code !== "worktree-unavailable") throw error;
      const configuration = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
      const [repositoryPath, worktreeRoot] = await Promise.all([scopedRepository(this.config.repositoryRoot, configuration.repositoryPath), scopedRepository(this.config.worktreeRoot, configuration.worktreeRoot)]);
      input.worktreePath = (await this.worktrees.reuse({ repositoryPath, worktreeRoot, taskId: input.taskId, targetBaseSha: input.targetBaseSha, branchName: input.branchName })).worktreePath;
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
    const inspectedWorktree = await this.worktrees.inspectDelivery(input.worktreePath, input.branchName);
    const baseIncluded = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "git", args: ["merge-base", "--is-ancestor", input.targetBaseSha, "HEAD"], cwd: input.worktreePath, timeout: 8_000 });
    const cleanMerge = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "git", args: ["merge-tree", "--write-tree", input.targetBaseSha, "HEAD"], cwd: input.worktreePath, timeout: 8_000 });
    const adoptingResolvedWorktree = inspectedWorktree.branchName === input.branchName && inspectedWorktree.dirtyState === "clean" && baseIncluded.exitCode === 0 && cleanMerge.exitCode === 0;
    if (!adoptingResolvedWorktree) {
      const mergeState = await this.mergeState(input.worktreePath);
      if (mergeState.head !== input.priorHead || mergeState.mergeHead !== input.targetBaseSha || JSON.stringify(mergeState.conflicts) !== JSON.stringify([...conflict.conflictFiles].sort())) {
        throw new AgentFailure("merge_state_ownership_mismatch", "The in-progress merge no longer matches the recorded forward-merge operation");
      }
    }
    const plan = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: planRow.storage_path, sha256: planRow.sha256 })).toString("utf8");
    const profile = this.executionProfile(input);
    this.requireDeveloperSession(input.developerSessionRef);
    const executionId = input.developerTurnExecutionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const attempt = input.developerAttempt ?? Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    const existing = this.database.authQuery((db) => db.prepare("SELECT task_id AS taskId, company_id AS companyId, workflow_id AS workflowId, plan_revision AS planRevision, attempt, status, failure_code AS failureCode, branch_name AS branchName, worktree_path AS worktreePath, target_base_sha AS targetBaseSha, supersedes_execution_id AS supersedesExecutionId, session_ref AS sessionRef FROM forge_developer_executions WHERE id = ?").get(executionId) as DeveloperExecutionIdentity | undefined);
    const startedAt = this.now().toISOString();
    const reopened = existing ? this.reAdoptOrphanExecution(executionId, existing, { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, attempt, branchName: input.branchName, worktreePath: input.worktreePath, targetBaseSha: input.targetBaseSha, supersedesExecutionId: input.developerExecutionId, sessionRef: input.developerSessionRef }, startedAt) : false;
    if (existing && !reopened && (existing.taskId !== input.taskId || existing.companyId !== input.companyId || existing.workflowId !== input.workflowId || existing.planRevision !== input.planRevision || existing.attempt !== attempt || existing.branchName !== input.branchName || existing.worktreePath !== input.worktreePath || existing.targetBaseSha !== input.targetBaseSha || existing.supersedesExecutionId !== input.developerExecutionId || existing.sessionRef !== input.developerSessionRef || !["starting", "running"].includes(existing.status))) throw new AgentFailure("developer-execution-identity-conflict", "The deterministic merge-resolution ID is already bound to different coordinates", { nonRetryable: true });
    const guard = await createGitCommandGuard(this.config.runtimeRoot);
    this.database.authTransaction((db) => {
      if (reopened) db.prepare("UPDATE forge_developer_executions SET task_id = ?, company_id = ?, workflow_id = ?, plan_revision = ?, attempt = ?, branch_name = ?, worktree_path = ?, target_base_sha = ?, supersedes_execution_id = ?, session_ref = ? WHERE id = ?").run(input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, input.branchName, input.worktreePath, input.targetBaseSha, input.developerExecutionId, input.developerSessionRef, executionId);
      db.prepare("INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, session_ref, started_at, heartbeat_at, execution_kind) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'forward_merge')").run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, input.branchName, input.worktreePath, input.targetBaseSha, input.developerExecutionId, input.developerSessionRef, startedAt, startedAt);
      this.bindCapacityInTransaction(db, input, executionId, input.developerSessionRef, input.worktreePath);
    });
    const evidenceLines: string[] = [];
    const mergePrompt = this.mergeConflictResolutionPrompt(plan, input, conflict, this.projectTestControl(input.taskId, input.companyId));
    let verificationArtifact: StoredArtifact | undefined;
    let completedMerge: { headSha: string; treeSha: string } | undefined;
    try {
      const task = this.taskContext(input);
      const report = adoptingResolvedWorktree
        ? { summary: "Adopted an already-resolved forward merge from the owned worktree", resolvedFiles: conflict.conflictFiles, resultCommit: inspectedWorktree.headSha, resultTree: inspectedWorktree.treeSha, blocker: null }
        : (await this.turnRunner.run({ task: { ...task, worktreePath: input.worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "integrator", ledger: "developer", executionId, promptKind: "merge-conflict-resolution", prompt: mergePrompt, profile: profile ?? this.developerProfile(), resultSchema: DeveloperMergeConflictResolutionReportSchema, schemaPath: await ensureResultSchema(this.config.runtimeRoot, "merge-conflict-resolution", DeveloperMergeConflictResolutionReportSchema), companyId: input.companyId, workflowId: input.workflowId, revision: input.planRevision, signal: input.signal })).result;
      const missingFiles = conflict.conflictFiles.filter((file) => !report.resolvedFiles.includes(file));
      if (missingFiles.length || report.blocker !== null) throw new AgentFailure("merge-resolution-incomplete", missingFiles.length ? `The Developer did not resolve: ${missingFiles.join(", ")}` : report.blocker ?? "Merge-conflict resolution is blocked");
      const gitState = await this.worktrees.inspectDelivery(input.worktreePath, input.branchName);
      completedMerge = { headSha: gitState.headSha, treeSha: gitState.treeSha };
      const parents = (await git(["rev-list", "--parents", "-n", "1", "HEAD"], input.worktreePath)).split(/\s+/);
      if (gitState.branchName !== input.branchName || gitState.dirtyState !== "clean" || gitState.headSha.toLowerCase() !== report.resultCommit.toLowerCase() || gitState.treeSha.toLowerCase() !== report.resultTree.toLowerCase() || parents.length !== 3 || (parents[1] ?? "").toLowerCase() !== input.priorHead.toLowerCase() || (parents[2] ?? "").toLowerCase() !== input.targetBaseSha.toLowerCase()) {
        throw new AgentFailure("merge-resolution-revision-invalid", "Developer resolution did not produce the required clean two-parent merge commit");
      }
      const revision = this.database.authQuery((db) => loadTaskConfiguration(db, this.artifacts, input));
      let parsed;
      try { parsed = revision; } catch { throw new AgentFailure("artifact_unavailable", "The task project configuration does not contain valid pinned verification commands"); }
      const verification = await runPinnedVerification({ taskId: input.taskId, stepId: executionId, worktreePath: input.worktreePath, setupCommand: parsed.setupCommand, verificationCommand: parsed.verificationCommand }, { guard });
      const verificationArtifactRecord = await this.artifacts.putArtifact(input.companyId, "forward-merge-verification", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(verification), "utf8") });
      verificationArtifact = verificationArtifactRecord;
      const afterVerification = await this.worktrees.inspectDelivery(input.worktreePath, input.branchName);
      const afterParents = (await git(["rev-list", "--parents", "-n", "1", "HEAD"], input.worktreePath)).split(/\s+/);
      if (afterVerification.branchName !== input.branchName || afterVerification.headSha.toLowerCase() !== gitState.headSha.toLowerCase() || afterVerification.treeSha.toLowerCase() !== gitState.treeSha.toLowerCase() || afterVerification.dirtyState !== "clean" || afterParents.length !== 3 || afterParents[1]?.toLowerCase() !== input.priorHead.toLowerCase() || afterParents[2]?.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new AgentFailure("merge_state_ownership_mismatch", "Pinned verification changed the forward-merge delivery");
      if (verification.outcome !== "passed") throw new AgentFailure(verification.code ?? "verification_failed", verification.summary);
      await this.artifacts.putArtifact(input.companyId, "merge-conflict-resolution", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(report, null, 2), "utf8") });
      const deliveryArtifact = await this.artifacts.putArtifact(input.companyId, "forward-merge-delivery", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, checkId: input.forwardMergeId, priorHead: input.priorHead, priorTree: conflict.priorTree, targetBaseSha: input.targetBaseSha, resultCommit: gitState.headSha, resultTree: gitState.treeSha, developerExecutionId: executionId, supersedesDeveloperExecutionId: input.developerExecutionId, supersededDeliveryArtifactId: prior?.deliveryArtifactId ?? null, supersededEvidenceArtifactId: prior?.evidenceArtifactId ?? null, verificationArtifactId: verificationArtifactRecord.id, verification }, null, 2), "utf8") });
      const evidence = await this.artifacts.putArtifact(input.companyId, "agent-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      const now = this.now().toISOString();
      const activityResult = { developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, resultCommit: gitState.headSha, resultTree: gitState.treeSha, deliveryArtifactId: deliveryArtifact.id, evidenceArtifactId: evidence.id, verificationArtifactId: verificationArtifactRecord.id, summary: report.summary };
      const terminalStatus = this.database.authTransaction((db) => {
        const updated = db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(now, now, gitState.headSha, gitState.treeSha, deliveryArtifact.id, evidence.id, executionId);
        if (updated.changes === 1) {
          db.prepare("UPDATE forge_forward_merges SET status = 'merged', merge_commit = ?, tree = ?, result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, delivery_artifact_id = ?, updated_at = ? WHERE task_id = ? AND company_id = ? AND conflict_artifact_id = ?").run(gitState.headSha, gitState.treeSha, gitState.headSha, gitState.treeSha, executionId, verificationArtifactRecord.id, deliveryArtifact.id, now, input.taskId, input.companyId, input.conflictArtifact.id);
          db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, result_commit = ?, result_tree = ?, status = 'completed', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, gitState.headSha, gitState.treeSha, now, input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
        }
        return updated.changes === 1 ? "completed" : (db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId) as { status: string } | undefined)?.status;
      });
      if (terminalStatus === "cancelled" || terminalStatus === "interrupted") throw new AgentFailure("developer-cancelled", "The build was cancelled before completion");
      if (terminalStatus !== "completed") throw new AgentFailure("developer-superseded", "The build was superseded before completion");
      return activityResult;
    } catch (error) {
      const failure = developerFailure(error, "merge-resolution-failed", `Codex Developer merge-conflict resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      const evidence = await this.artifacts.putArtifact(input.companyId, "agent-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      if (verificationArtifact && completedMerge && ["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(failure.code)) {
        const blockedVerificationArtifact = verificationArtifact;
        const blockedMerge = completedMerge;
        const now = this.now().toISOString();
        this.database.authTransaction((db) => {
          db.prepare("UPDATE forge_developer_executions SET status = 'blocked', finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(now, now, blockedMerge.headSha, blockedMerge.treeSha, failure.code, failure.message, evidence.id, executionId);
          db.prepare("UPDATE forge_forward_merges SET status = 'merged', merge_commit = ?, tree = ?, result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, failure_code = ?, failure_summary = ?, updated_at = ? WHERE task_id = ? AND company_id = ? AND conflict_artifact_id = ?").run(blockedMerge.headSha, blockedMerge.treeSha, blockedMerge.headSha, blockedMerge.treeSha, executionId, blockedVerificationArtifact.id, failure.code, failure.message, now, input.taskId, input.companyId, input.conflictArtifact.id);
          db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, result_commit = ?, result_tree = ?, status = 'blocked', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, blockedMerge.headSha, blockedMerge.treeSha, now, input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
        });
        return { outcome: "verification_blocked", developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, resultCommit: blockedMerge.headSha, resultTree: blockedMerge.treeSha, evidenceArtifactId: evidence.id, verificationArtifact: { id: blockedVerificationArtifact.id, kind: "forward-merge-verification" as const }, code: failure.code as "verification_failed" | "verification_timed_out" | "verification_evidence_too_large", summary: failure.message };
      }
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId);
        db.prepare("UPDATE forge_merge_conflict_resolutions SET developer_execution_id = ?, developer_session_ref = ?, status = 'blocked', updated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ?").run(executionId, input.developerSessionRef, this.now().toISOString(), input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha);
      });
      throw failure;
    } finally { await guard.cleanup(); }
  }

  private async mergeState(worktreePath: string): Promise<{ head: string; mergeHead: string; conflicts: string[] }> {
    const run = async (args: string[]): Promise<string> => git(args, worktreePath);
    const [head, mergeHead, files] = await Promise.all([
      run(["rev-parse", "HEAD"]),
      run(["rev-parse", "MERGE_HEAD"]),
      run(["diff", "--name-only", "--diff-filter=U"]),
    ]);
    return { head, mergeHead, conflicts: files.split("\n").filter(Boolean).sort() };
  }

  async runRepair(rawInput: DeveloperRepairActivityInput & Partial<DeveloperSupervisorActivityIdentity> & OperationAware): Promise<DeveloperRepairActivityResult> {
    const input = { ...DeveloperRepairActivityInputSchema.parse(rawInput), ...(rawInput.developerTurnExecutionId ? { developerTurnExecutionId: rawInput.developerTurnExecutionId } : {}), ...(rawInput.developerAttempt ? { developerAttempt: rawInput.developerAttempt } : {}), ...(rawInput.turnKind ? { turnKind: rawInput.turnKind } : {}), ...(rawInput.signal ? { signal: rawInput.signal } : {}) };
    if (input.blockingFindings.length === 0 && !input.repairPlan) throw new AgentFailure("repair-findings-missing", "Developer repair requires blocking findings or a repair plan");
    const prior = this.database.authQuery((db) => db.prepare(`SELECT id, status, session_ref, branch_name, worktree_path, target_base_sha, result_commit, result_tree, delivery_artifact_id, evidence_artifact_id
      FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; status: string; session_ref: string | null; branch_name: string; worktree_path: string; target_base_sha: string; result_commit: string | null; result_tree: string | null; delivery_artifact_id: string | null; evidence_artifact_id: string | null } | undefined);
    const review = this.database.authQuery((db) => db.prepare(`SELECT id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, session_ref, outcome
      FROM forge_delivery_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.reviewId, input.taskId, input.companyId, input.workflowId) as { id: string; task_id: string; company_id: string; workflow_id: string; plan_revision: number; base_sha: string; subject_commit: string; subject_tree: string; session_ref: string; outcome: string } | undefined);
    if (!prior || !review) throw new AgentFailure("repair-identity-mismatch", "Developer repair coordinates do not match the immutable review subject");
    const priorSubject = DeliveryReviewSubjectSchema.parse({ planRevision: review.plan_revision, targetBaseSha: review.base_sha, subjectCommit: review.subject_commit, subjectTree: review.subject_tree, developerExecutionId: prior.id, deliveryArtifactId: prior.delivery_artifact_id, developerEvidenceArtifactId: prior.evidence_artifact_id, leadSessionRef: review.session_ref, developerSessionRef: prior.session_ref });
    const profile = this.executionProfile(input);
    const executionId = input.developerTurnExecutionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const existing = this.database.authQuery((db) => db.prepare("SELECT task_id AS taskId, company_id AS companyId, workflow_id AS workflowId, plan_revision AS planRevision, attempt, status, failure_code AS failureCode, branch_name AS branchName, worktree_path AS worktreePath, target_base_sha AS targetBaseSha, supersedes_execution_id AS supersedesExecutionId, session_ref AS sessionRef FROM forge_developer_executions WHERE id = ?").get(executionId) as DeveloperExecutionIdentity | undefined);
    const attempt = input.developerAttempt ?? Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, input.planRevision) as { attempt: number })).attempt) + 1;
    const startedAt = this.now().toISOString();
    const reopened = existing ? this.reAdoptOrphanExecution(executionId, existing, { taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, planRevision: input.planRevision, attempt, branchName: input.branchName, targetBaseSha: input.targetBaseSha, supersedesExecutionId: input.developerExecutionId, sessionRef: input.developerSessionRef }, startedAt) : false;
    if (existing && !reopened && (existing.taskId !== input.taskId || existing.companyId !== input.companyId || existing.workflowId !== input.workflowId || existing.planRevision !== input.planRevision || existing.attempt !== attempt || existing.branchName !== input.branchName || existing.targetBaseSha !== input.targetBaseSha || existing.supersedesExecutionId !== input.developerExecutionId || existing.sessionRef !== input.developerSessionRef || !["starting", "running"].includes(existing.status))) throw new AgentFailure("developer-execution-identity-conflict", "The deterministic Developer repair ID is already bound to different coordinates", { nonRetryable: true });
    const repairAttemptId = `delivery_repair_${executionId.slice("developer_".length)}`;
    let repairRowCreated = false;
    let worktreePath = input.worktreePath;
    const evidenceLines: string[] = [];
    try {
    this.database.authTransaction((db) => {
        if (reopened) db.prepare("UPDATE forge_developer_executions SET task_id = ?, company_id = ?, workflow_id = ?, plan_revision = ?, attempt = ?, branch_name = ?, worktree_path = ?, target_base_sha = ?, supersedes_execution_id = ?, session_ref = ? WHERE id = ?").run(input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, input.branchName, worktreePath, input.targetBaseSha, input.developerExecutionId, input.developerSessionRef, executionId);
        db.prepare("INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, session_ref, started_at, heartbeat_at, current_step) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)").run(executionId, input.taskId, input.companyId, input.workflowId, input.planRevision, attempt, input.branchName, worktreePath, input.targetBaseSha, input.developerExecutionId, input.developerSessionRef, startedAt, startedAt);
        db.prepare("INSERT OR IGNORE INTO forge_delivery_repairs (id, task_id, company_id, workflow_id, review_id, developer_execution_id, cycle, status, subject_commit, subject_tree, developer_session_ref, branch_name, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)").run(repairAttemptId, input.taskId, input.companyId, input.workflowId, input.reviewId, executionId, input.cycle, input.subjectCommit, input.subjectTree, input.developerSessionRef, input.branchName, worktreePath, startedAt);
        this.bindCapacityInTransaction(db, input, executionId, input.developerSessionRef, worktreePath);
        repairRowCreated = true;
      });
      worktreePath = await scopedRepository(this.config.worktreeRoot, input.worktreePath);
      this.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET worktree_path = ? WHERE id = ?").run(worktreePath, executionId));
      this.database.authQuery((db) => db.prepare("UPDATE forge_delivery_repairs SET worktree_path = ? WHERE id = ?").run(worktreePath, repairAttemptId));
      this.requireDeveloperSession(input.developerSessionRef);
      const visualEvidence = this.visualEvidenceControl(input.taskId, input.companyId);
      const repairPrompt = this.repairPrompt(input.blockingFindings, { branchName: input.branchName, worktreePath, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree }, `${this.projectTestControl(input.taskId, input.companyId)} ${this.visualEvidenceInstruction(visualEvidence)}`);
      evidenceLines.push(JSON.stringify({ type: "forge.prompt", text: redact(repairPrompt) }));
      const task = this.taskContext(input);
      const turn = await this.turnRunner.run({ task: { ...task, worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "builder", ledger: "developer", executionId, promptKind: "delivery-repair", prompt: repairPrompt, profile: profile ?? this.developerProfile(), resultSchema: DeveloperRepairReportSchema, schemaPath: await ensureResultSchema(this.config.runtimeRoot, "developer-repair", DeveloperRepairReportSchema), companyId: input.companyId, workflowId: input.workflowId, revision: input.planRevision, signal: input.signal });
      const report = turn.result;
      let durableProof: DurableBrowserProof | undefined, proofBlocker: string | null = null;
      let reportedPaths: string[] = [];
        try { reportedPaths = normalizeBrowserProofPaths(report.visualEvidence); await this.browserProof.assertReportedProofUntracked(worktreePath, reportedPaths); }
        catch (error) { if (!(error instanceof Error)) throw error; proofBlocker = `${error.message}.`; reportedPaths = []; }
        const source = await finalizeDeveloperSourceCommit(worktreePath, input.targetBaseSha, reportedPaths);
        try { if (source) durableProof = await this.browserProof.ingest({ taskId: input.taskId, companyId: input.companyId, developerExecutionId: executionId, resultCommit: source.headSha, resultTree: source.treeSha, worktreePath, control: visualEvidence, ...(report.visualEvidence ? { evidence: report.visualEvidence } : {}), onAdvisory: (note) => { proofBlocker = [proofBlocker, note].filter(Boolean).join(" "); } }); }
      catch (error) { if (!(error instanceof BrowserProofFailure)) throw error; proofBlocker = `${error.message}. Capture proof under .forge-proof/ and retry.`; }
      if (durableProof && report.visualEvidence) await this.browserProof.cleanupPersisted(worktreePath, report.visualEvidence, durableProof);
      const gitState = await this.worktrees.inspectDelivery(worktreePath, input.branchName);
      const touchedFiles = (await git(["diff", "--name-only", input.subjectCommit, gitState.headSha], worktreePath)).split("\n").filter(Boolean);
      const coverage = repairCoverage(input.blockingFindings, touchedFiles);
      const persistedReport = { ...report, summary: proofBlocker ? `${report.summary}\n\nScreenshots: ${proofBlocker}` : report.summary, visualEvidence: durableProof, cycle: input.cycle, reviewId: input.reviewId, supersedesExecutionId: input.developerExecutionId };
      const repairArtifact = await this.artifacts.putArtifact(input.companyId, "developer-repair", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(persistedReport, null, 2), "utf8"), taskId: input.taskId });
      const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
      const blocked = persistedReport.blocker !== null;
      const activityResult = blocked
        ? DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, code: "process-failed", summary: persistedReport.blocker!, evidenceArtifactId: evidence.id, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: gitState.dirtyState })
        : DeveloperRepairActivityResultSchema.parse({ outcome: "completed", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: gitState.headSha, resultTree: gitState.treeSha, dirtyState: "clean", deliveryArtifactId: repairArtifact.id, evidenceArtifactId: evidence.id, summary: report.summary, objections: report.objections });
      const terminalStatus = this.database.authTransaction((db) => {
        const row = db.prepare("SELECT id FROM forge_delivery_repairs WHERE developer_execution_id = ? AND cycle = ?").get(executionId, input.cycle) as { id: string } | undefined;
        const failureCode = blocked ? "process-failed" : null;
        const failureSummary = blocked ? persistedReport.blocker : null;
        const updated = db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(blocked ? "blocked" : "completed", this.now().toISOString(), this.now().toISOString(), gitState.headSha, gitState.treeSha, gitState.dirtyState, repairArtifact.id, evidence.id, executionId);
        if (updated.changes === 1) db.prepare("UPDATE forge_delivery_repairs SET status = ?, result_commit = ?, result_tree = ?, delivery_artifact_id = ?, evidence_artifact_id = ?, coverage_json = ?, failure_code = ?, failure_summary = ?, finished_at = ? WHERE id = ?").run(blocked ? "blocked" : "completed", gitState.headSha, gitState.treeSha, repairArtifact.id, evidence.id, JSON.stringify({ coverage, objections: report.objections }), failureCode, failureSummary, this.now().toISOString(), row?.id);
        return updated.changes === 1 ? blocked ? "blocked" : "completed" : (db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId) as { status: string } | undefined)?.status;
      });
      if (terminalStatus === "cancelled" || terminalStatus === "interrupted") throw new AgentFailure("developer-cancelled", "The build was cancelled before completion");
      if (terminalStatus !== (blocked ? "blocked" : "completed")) throw new AgentFailure("developer-superseded", "The build was superseded before completion");
      return activityResult;
    } catch (error) {
      const expectedFailure = error instanceof AgentFailure;
      const failure = developerFailure(error, "developer-repair-failed", `Codex Developer repair failed: ${error instanceof Error ? error.message : String(error)}`);
      const evidence = await this.persistEvidence(input.companyId, evidenceLines, `${executionId}:evidence`);
      const code = repairBlockCode(failure);
      const expected = expectedFailure && ["invalid-output", "session-conflict", "authentication-required", "rate-limited", "process-failed", "evidence-too-large"].includes(code);
      let observed: { headSha: string; treeSha: string; dirtyState: "clean" | "dirty" } | undefined;
      try {
        const observedPath = await scopedRepository(this.config.worktreeRoot, worktreePath);
        const gitState = await this.worktrees.inspectDelivery(observedPath, input.branchName);
        observed = { headSha: gitState.headSha, treeSha: gitState.treeSha, dirtyState: gitState.dirtyState };
      } catch { /* Preserve the typed blocker even when the worktree can no longer be inspected. */ }
      const effectiveCode = code;
      const effectiveSummary = failure.message;
      const effectiveExpected = expected;
      const blockedResult = effectiveExpected ? DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId, cycle: input.cycle, reviewId: input.reviewId, subject: priorSubject, code: effectiveCode, summary: effectiveSummary, evidenceArtifactId: evidence.id, developerExecutionId: executionId, developerSessionRef: input.developerSessionRef, worktreePath, branchName: input.branchName, resultCommit: observed?.headSha ?? null, resultTree: observed?.treeSha ?? null, dirtyState: observed?.dirtyState ?? null }) : undefined;
      this.database.authTransaction((db) => {
        db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, result_commit = ?, result_tree = ?, dirty_state = ?, evidence_artifact_id = ? WHERE id = ?").run(effectiveExpected ? "blocked" : "failed", this.now().toISOString(), this.now().toISOString(), effectiveCode, effectiveSummary, observed?.headSha ?? null, observed?.treeSha ?? null, observed?.dirtyState ?? null, evidence.id, executionId);
        if (repairRowCreated) db.prepare("UPDATE forge_delivery_repairs SET status = ?, result_commit = ?, result_tree = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ?, finished_at = ? WHERE developer_execution_id = ? AND cycle = ?").run(effectiveExpected ? "blocked" : "failed", observed?.headSha ?? null, observed?.treeSha ?? null, effectiveCode, effectiveSummary, evidence.id, this.now().toISOString(), executionId, input.cycle);
      });
      if (!effectiveExpected) throw error;
      return blockedResult!;
    }
  }

  async runCiRepair(rawInput: CiRepairActivityInput & Partial<DeveloperSupervisorActivityIdentity> & OperationAware): Promise<CiRepairActivityResult> {
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
    const worktreePath = await scopedRepository(this.config.worktreeRoot, input.worktreePath);
    const prior = this.database.authQuery((db) => db.prepare(`SELECT id, session_ref AS sessionRef
      FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?`).get(input.priorDeveloperExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; sessionRef: string | null } | undefined)
      ?? this.database.authQuery((db) => db.prepare(`SELECT id, session_ref AS sessionRef
      FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND lower(result_commit) = lower(?) AND lower(result_tree) = lower(?) ORDER BY started_at DESC LIMIT 1`).get(input.taskId, input.companyId, input.workflowId, input.priorCommit, input.priorTree) as { id: string; sessionRef: string | null } | undefined);
    const priorDelivery = await verifyCiRepairDelivery(worktreePath, input.branchName, input.priorCommit, input.priorTree);
    if (input.priorCommit.toLowerCase() !== input.failedHeadSha.toLowerCase()) throw new AgentFailure("ci-repair-identity-mismatch", "CI repair does not match the original Developer delivery");
    const priorSessionRef = prior?.sessionRef ?? null;
    if (!this.github?.getPullRequest) throw new AgentFailure("ci-repair-provider-unavailable", "The current pull request cannot be verified before repair");
    const pullRequest = await this.github.getPullRequest({ repository: plan.repository, number: plan.pullRequestNumber });
    // Draft is not part of the pull request identity: acceptance marks a delivery ready for review while CI is still observed, so CI repair must still run on the exact head.
    if (pullRequest.state !== "open" || pullRequest.repository.toLowerCase() !== plan.repository.toLowerCase() || pullRequest.number !== plan.pullRequestNumber || pullRequest.url.replace(/\/$/, "").toLowerCase() !== plan.pullRequestUrl.replace(/\/$/, "").toLowerCase() || pullRequest.headBranch !== plan.headBranch || pullRequest.baseBranch !== plan.baseBranch || pullRequest.baseSha.toLowerCase() !== plan.baseSha.toLowerCase() || pullRequest.headSha.toLowerCase() !== input.failedHeadSha.toLowerCase()) throw new AgentFailure("ci-repair-pull-request-changed", "The pull request changed before CI repair");
    const executionId = input.developerTurnExecutionId ?? `developer_${randomBytes(12).toString("hex")}`;
    const repairId = `ci_repair_${createHash("sha256").update(executionId).digest("hex").slice(0, 24)}`;
    let evidenceLines: string[] = [];
    try {
    let current = await this.worktrees.inspectDelivery(worktreePath, input.branchName);
    // A previously failed repair attempt can leave its own unpushed commit on HEAD.
    // Discard it and retry the same exact repair instead of refusing forever.
    if (current.headSha.toLowerCase() !== input.priorCommit.toLowerCase() && await rollbackUnpushedRepairCommits(worktreePath, input.branchName, input.priorCommit)) current = await this.worktrees.inspectDelivery(worktreePath, input.branchName);
    if (current.branchName !== input.branchName || current.dirtyState !== "clean") throw new AgentFailure("ci-repair-subject-changed", "The CI repair worktree is not a clean task branch");
    if (priorSessionRef) this.requireDeveloperSession(priorSessionRef);
    const planText = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: plan.planStoragePath, sha256: plan.planSha256 })).toString("utf8");
    const evidenceText = (await this.artifacts.getArtifact({ companyId: input.companyId, storagePath: plan.ciEvidenceStoragePath, sha256: plan.ciEvidenceSha256 })).toString("utf8");
    const existingExecution = this.database.authQuery((db) => db.prepare("SELECT task_id AS taskId, company_id AS companyId, workflow_id AS workflowId, status, branch_name AS branchName, worktree_path AS worktreePath, supersedes_execution_id AS supersedesExecutionId, session_ref AS sessionRef FROM forge_developer_executions WHERE id = ?").get(executionId) as { taskId: string; companyId: string; workflowId: string; status: string; branchName: string | null; worktreePath: string | null; supersedesExecutionId: string | null; sessionRef: string | null } | undefined);
    const existingCoordinatesMatch = existingExecution
      && existingExecution.taskId === input.taskId
      && existingExecution.companyId === input.companyId
      && existingExecution.workflowId === input.workflowId
      && existingExecution.branchName === input.branchName
      && existingExecution.worktreePath === worktreePath
      && existingExecution.supersedesExecutionId === input.priorDeveloperExecutionId
      && existingExecution.sessionRef === priorSessionRef;
    if (existingExecution && (!existingCoordinatesMatch || !["starting", "running", "failed", "cancelled"].includes(existingExecution.status))) {
      throw new AgentFailure("developer-execution-identity-conflict", "The deterministic CI repair execution is bound to different coordinates", { nonRetryable: true });
    }
    const startedAt = this.now().toISOString();
    this.database.authTransaction((db) => {
        if (existingExecution?.status === "failed" || existingExecution?.status === "cancelled") db.prepare("UPDATE forge_developer_executions SET status = 'starting', failure_code = NULL, failure_summary = NULL, finished_at = NULL, started_at = ?, heartbeat_at = ? WHERE id = ? AND status IN ('failed', 'cancelled')").run(startedAt, startedAt, executionId);
        // Attempt must climb: (workflow_id, plan_revision, attempt) is unique, so a
        // hardcoded attempt 1 made every CI repair after the first fail on insert.
        db.prepare("INSERT OR IGNORE INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, wrapper_id, wrapper_path, supersedes_execution_id, session_ref, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 0, (SELECT COALESCE(MAX(attempt), 0) + 1 FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = 0), 'starting', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)").run(executionId, input.taskId, input.companyId, input.workflowId, input.workflowId, input.branchName, worktreePath, plan.baseSha, prior?.id ?? null, priorSessionRef, startedAt, startedAt);
        if (prior) db.prepare("INSERT OR IGNORE INTO forge_ci_repairs (id, repair_plan_id, prior_developer_execution_id, prior_developer_session_ref, worktree_path, branch_name, prior_commit, prior_tree, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?)").run(repairId, input.repairPlanId, prior.id, priorSessionRef, worktreePath, input.branchName, input.priorCommit, input.priorTree, startedAt);
    });
    evidenceLines = [JSON.stringify({ type: "forge.ci-repair-context", ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, failedHeadSha: input.failedHeadSha, priorDelivery, session: priorSessionRef ? "continued" : "started-fresh", plan: redact(planText), evidence: redact(evidenceText) })];
    const ciRepairPrompt = this.ciRepairPrompt(planText, { branchName: input.branchName, worktreePath, priorCommit: input.priorCommit, priorTree: input.priorTree }, this.projectTestControl(input.taskId, input.companyId));
    const profile = this.executionProfile(input);
      const task = this.taskContext(input);
      const turn = await this.turnRunner.run({ task: { ...task, worktreePath, runtimeRoot: this.config.runtimeRoot }, executionRole: "integrator", ledger: "developer", executionId, promptKind: "ci-repair", prompt: ciRepairPrompt, profile: profile ?? this.developerProfile(), resultSchema: DeveloperRepairReportSchema, schemaPath: await ensureResultSchema(this.config.runtimeRoot, "developer-repair", DeveloperRepairReportSchema), companyId: input.companyId, workflowId: input.workflowId, revision: 0, signal: input.signal });
      const report = turn.result;
      const gitState = await this.worktrees.inspectDelivery(worktreePath, input.branchName);
      if (gitState.branchName !== input.branchName || gitState.dirtyState !== "clean" || report.blocker !== null) throw new AgentFailure("ci-repair-revision-invalid", "CI repair did not leave a clean task branch");
      const delivery = await this.artifacts.putArtifact(input.companyId, "developer-repair", { filename: `${executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ ...report, ciRunId: input.ciRunId, ciAttemptId: input.ciAttemptId, priorCommit: input.priorCommit, priorTree: input.priorTree }, null, 2), "utf8") });
      const evidence = await this.artifacts.putArtifact(input.companyId, "ci-repair-evidence", { filename: `${executionId}.jsonl`, mimeType: "application/x-ndjson", bytes: Buffer.from(`${evidenceLines.join("\n")}\n`, "utf8") });
      const now = this.now().toISOString();
      const repairSessionRef = turn.roleSessionId;
      const activityResult = { repairId, developerExecutionId: executionId, developerSessionRef: repairSessionRef, worktreePath, branchName: input.branchName, priorCommit: input.priorCommit, priorTree: input.priorTree, resultCommit: gitState.headSha, resultTree: gitState.treeSha, deliveryArtifactId: delivery.id, evidenceArtifactId: evidence.id, summary: report.summary, outcome: "completed" as const };
      const terminalStatus = this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(delivery.id, delivery.companyId, delivery.kind, delivery.filename, delivery.mimeType, delivery.byteSize, delivery.sha256, delivery.storagePath, delivery.createdAt, evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        const updated = db.prepare("UPDATE forge_developer_executions SET status = 'completed', session_ref = ?, finished_at = ?, heartbeat_at = ?, result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(repairSessionRef, now, now, gitState.headSha, gitState.treeSha, delivery.id, evidence.id, executionId);
        if (updated.changes === 1) {
          if (prior) db.prepare("UPDATE forge_ci_repairs SET result_developer_execution_id = ?, result_developer_session_ref = ?, new_commit = ?, new_tree = ?, delivery_artifact_id = ?, evidence_artifact_id = ?, status = 'completed', summary = ?, completed_at = ? WHERE id = ?").run(executionId, repairSessionRef, gitState.headSha, gitState.treeSha, delivery.id, evidence.id, report.summary, now, repairId);
          db.prepare("UPDATE forge_ci_repair_plans SET status = 'consumed', consumed_at = ?, updated_at = ? WHERE id = ?").run(now, now, input.repairPlanId);
          if (input.releaseId) {
            db.prepare("UPDATE forge_releases SET superseded_at = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND superseded_at IS NULL").run(now, now, input.releaseId, input.taskId, input.companyId);
            db.prepare("UPDATE forge_ci_runs SET superseded_at = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND superseded_at IS NULL").run(now, now, input.ciRunId, input.taskId, input.companyId);
          }
        }
        return updated.changes === 1 ? "completed" : (db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(executionId) as { status: string } | undefined)?.status;
      });
      if (terminalStatus === "cancelled" || terminalStatus === "interrupted") throw new AgentFailure("developer-cancelled", "The build was cancelled before completion");
      if (terminalStatus !== "completed") throw new AgentFailure("developer-superseded", "The build was superseded before completion");
      return activityResult;
    } catch (error) {
      const failure = developerFailure(error, error instanceof Error && error.message.includes("scope mismatch") ? "developer-scope-mismatch" : "ci-repair-failed", `CI repair failed: ${error instanceof Error ? error.message : String(error)}`);
      // Leave the worktree on the recorded failed head so the retry starts clean.
      await rollbackUnpushedRepairCommits(worktreePath, input.branchName, input.priorCommit);
      const evidence = await this.persistEvidence(input.companyId, evidenceLines);
      this.database.authTransaction((db) => {
        db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
        db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ?, evidence_artifact_id = ? WHERE id = ? AND status IN ('starting', 'running')").run(this.now().toISOString(), this.now().toISOString(), failure.code, failure.message, evidence.id, executionId);
        if (prior) db.prepare("UPDATE forge_ci_repairs SET status = 'failed', failure_code = ?, summary = ?, evidence_artifact_id = ?, completed_at = ? WHERE id = ?").run(failure.code, failure.message, evidence.id, this.now().toISOString(), repairId);
        db.prepare("UPDATE forge_ci_repair_plans SET status = 'planned', updated_at = ? WHERE id = ?").run(this.now().toISOString(), input.repairPlanId);
      });
      throw failure;
    }
  }

  private mergeConflictResolutionPrompt(plan: string, input: MergeConflictResolutionInput, conflict: ForwardMergeConflictArtifact, controls: string): string {
    return renderPrompt(this.prompts.get("developer/merge-resolution.md")!, { branch_name: input.branchName, target_base_sha: input.targetBaseSha, conflict_file: conflict.conflictFiles.join('","'), plan, controls });
  }

  private ciRepairPrompt(plan: string, input: { branchName: string; worktreePath: string; priorCommit: string; priorTree: string }, controls: string): string {
    return renderPrompt(this.prompts.get("developer/ci-repair.md")!, { branch_name: input.branchName, worktree_path: input.worktreePath, prior_commit: input.priorCommit, prior_tree: input.priorTree, plan, controls });
  }

  private repairPrompt(findings: DeliveryFinding[], worktree: { branchName: string; worktreePath: string; targetBaseSha: string; subjectCommit: string; subjectTree: string }, controls: string): string {
    return renderPrompt(this.prompts.get("developer/repair.md")!, { findings: JSON.stringify(findings), branch_name: worktree.branchName, worktree_path: worktree.worktreePath, target_base_sha: worktree.targetBaseSha, subject_commit: worktree.subjectCommit, subject_tree: worktree.subjectTree, controls });
  }

  private prompt(title: string, brief: string, plan: string, evidence: string, worktree: { branchName: string; worktreePath: string; targetBaseSha: string }, runProjectTests?: boolean, visualEvidence?: "off" | "capture" | "required", operatorNote?: string, continuation?: DeveloperExecutionActivityInput["continuation"], reuseWorktree = false): string {
    const controls = [this.testControl(runProjectTests), this.visualEvidenceInstruction(visualEvidence ?? "off")].join(" ");
    const continuationContext = continuation ? `You already completed steps ${continuation.completedSteps.join(", ")} in commit ${continuation.previousCommit} (summary: ${continuation.previousDeliverySummary}). Continue with steps ${continuation.remainingSteps.join(", ")} in the same worktree. Do not redo completed steps. Commit after each completed step.` : "";
    const reuseContext = reuseWorktree ? "This is a linked retry. The worktree contains preserved work from an earlier Builder turn. Keep its files and commits, then complete the remaining authorized work." : "";
    return renderPrompt(this.prompts.get("developer/execution.md")!, { title, brief, plan, lead_evidence: evidence, branch_name: worktree.branchName, worktree_path: worktree.worktreePath, target_base_sha: worktree.targetBaseSha, controls, reuse_context: reuseContext, continuation_context: continuationContext, operator_note_section: operatorNote ? `\n\nOperator note (verbatim):\n${operatorNote}` : "" });
  }

  private projectTestControl(taskId: string, companyId: string): string {
    const task = this.database.authQuery((db) => db.prepare("SELECT run_project_tests AS runProjectTests FROM forge_tasks WHERE id = ? AND company_id = ?").get(taskId, companyId) as { runProjectTests: number | null } | undefined);
    return this.testControl(task?.runProjectTests === 0 ? false : undefined);
  }

  private visualEvidenceControl(taskId: string, companyId: string): "off" | "capture" | "required" {
    const task = this.database.authQuery((db) => db.prepare("SELECT visual_evidence AS visualEvidence FROM forge_tasks WHERE id = ? AND company_id = ?").get(taskId, companyId) as { visualEvidence: "off" | "capture" | "required" | null } | undefined);
    return task?.visualEvidence ?? "off";
  }

  private visualEvidenceInstruction(value: "off" | "capture" | "required"): string {
    if (value === "off") return "Do not spend time capturing browser proof and omit visualEvidence.";
    const contract = "Write screenshots only under .forge-proof/ in this task worktree. Never stage or commit .forge-proof/ or any proof file. Report visualEvidence.captures entries with the relative path and, when known, caption, viewport {width,height,deviceScaleFactor}, and capturedAt. Forge ingests and removes these transient files; paths alone are not durable proof.";
    return value === "required" ? `Browser proof is required. ${contract} Missing valid durable proof blocks delivery.` : `Capture browser proof when it helps demonstrate the change. ${contract} Delivery may continue with no proof.`;
  }


  private testControl(runProjectTests?: boolean): string {
    return runProjectTests === false
      ? "Do not run any test suite, by any command, focused or full. You may still run non-test verification such as type checking, linting, builds, and git status."
      : "Run appropriate local verification, including the configured project suite when it applies.";
  }
  private pinnedPrompts(configuration: { prompts?: { artifactId: string; sha256: string } | undefined }, companyId: string): ReadonlyMap<string, string> {
    if (!configuration.prompts) return loadDefaultPrompts();
    const artifact = this.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-prompt-set'").get(configuration.prompts!.artifactId, companyId) as { storage_path: string } | undefined);
    if (!artifact) throw new AgentFailure("scoped-input-missing", "Pinned task prompts are unavailable");
    const parsed = jsonRequired(this.artifacts.getArtifactSync({ companyId, storagePath: artifact.storage_path, sha256: configuration.prompts.sha256 }).toString("utf8")) as unknown;
    return new Map(Object.entries(isVersionedPromptSet(parsed) ? parsed.prompts : parsed as Record<string, string>));
  }
  private currentPrompts(projectId: string): ReadonlyMap<string, string> {
    const catalog = loadPromptCatalog();
    const rows = this.database.authQuery((db) => db.prepare("SELECT id, template_id AS templateId, mode, content, base_template_sha256 AS baseTemplateSha256, current_revision AS currentRevision, scope FROM forge_prompt_overrides WHERE scope_key IN ('global', ?)").all(projectId) as Array<PromptOverrideRow & { scope: "global" | "project" }>);
    const active = (scope: "global" | "project") => new Map(rows.filter((row) => row.scope === scope).flatMap((row) => catalog.has(row.templateId) ? [[row.templateId, row] as const] : []));
    const resolved = resolvePromptSet(catalog, { global: active("global"), project: active("project") });
    return new Map([...resolved.values()].map((prompt) => [catalog.get(prompt.templateId)!.path as PromptPath, prompt.text]));
  }
  private async persistEvidence(companyId: string, lines: string[], stableKey?: string): Promise<StoredArtifact> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const artifactInput = { filename: stableKey ? `${stableKey.split(":")[0]}.jsonl` : `developer_${randomBytes(12).toString("hex")}.jsonl`, mimeType: "application/x-ndjson", bytes: content.length ? content : Buffer.from("{\"type\":\"empty\"}\n") };
    void stableKey;
    return this.artifacts.putArtifact(companyId, "agent-evidence", artifactInput);
  }
}
