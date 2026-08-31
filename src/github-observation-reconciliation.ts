import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { createGithubReleasePort, type GithubPullRequestObservation } from "./github-release.js";
import { json } from "./task-utils.js";
import { connectEngine, durableCommand, executeIssueCommand } from "./engine/service.js";
import { IssueWorkflowStateSchema, type IssueWorkflowState } from "./engine/issue-contracts.js";
import { issueUpdates } from "./engine/issue-updates.js";
import type { IssueCommand } from "./commands/registry.js";
import { integrateRemoteBranch, type RemoteIntegration } from "./remote-branch-integration.js";

export type GithubObservation = "merged" | "closed" | "checks_passed" | "checks_failed" | "checks_pending" | "head_changed" | "unchanged";
type Outcome = { taskId: string; workflowId: string; observation: GithubObservation; commandKind: string | null; commandId: string | null; deduplicated: boolean; integration?: RemoteIntegration["kind"] };
export interface GithubReconciliationResult { inspected: number; signalled: number; skipped: number; errors: number; outcomes: Outcome[] }
type Candidate = { taskId: string; companyId: string; workflowId: string; revision: number; phase: string; repository: string; branch: string; pullRequestNumber: number | null; worktreePath: string | null; targetBaseSha: string | null; state: IssueWorkflowState };
type ReconciliationOptions = {
  taskId?: string;
  observe?: (input: { repository: string; branch: string; pullRequestNumber?: number | null }) => Promise<GithubPullRequestObservation>;
  execute?: typeof executeIssueCommand;
  integrate?: typeof integrateRemoteBranch;
};
type RemoteConflict = Extract<RemoteIntegration, { kind: "conflict" }> & { priorHead: string; priorTree: string };

async function executeRemoteConflict(config: ForgeConfig, workflowId: string, input: { expectedRevision: number; actorUserId: string; commandId: string; forwardMergeId: string; priorHead: string; priorTree: string; remoteHead: string; conflictArtifact: { id: string; kind: "forward-merge-conflict" }; conflictFileCount: number }): Promise<void> {
  const engine = await connectEngine(config);
  try {
    const handle = engine.client.workflow.getHandle(workflowId);
    await handle.executeUpdate(issueUpdates.integrate_remote_conflict, { args: [input], updateId: input.commandId });
  } finally {
    await engine.connection.close();
  }
}

function remoteConflict(database: ForgeDatabase, result: Extract<RemoteIntegration, { kind: "conflict" }>): RemoteConflict {
  const row = database.authQuery((db) => db.prepare("SELECT prior_head AS priorHead, prior_tree AS priorTree FROM forge_forward_merges WHERE id = ?").get(result.forwardMergeId) as { priorHead: string; priorTree: string } | undefined);
  if (!row?.priorHead || !row.priorTree) throw new Error("Remote conflict evidence is incomplete");
  return { ...result, ...row };
}

/** Projects a task as done because its pull request merged on GitHub and the workflow cannot process the observation. */
function adoptMergedPullRequest(database: ForgeDatabase, candidate: Candidate): void {
  const revision = candidate.revision + 1;
  const state = { ...candidate.state, revision, phase: "done" as const, owner: "human" as const, allowedCommands: [], pendingAction: "Merged", blocker: null, mergeOutcome: "merged" as const, githubPullRequestState: "merged" as const, lastEventId: `${candidate.workflowId}:${revision}`, stateChangedAt: new Date().toISOString() };
  database.projectIssueState({ taskId: candidate.taskId, companyId: candidate.companyId, projectId: candidate.state.projectId, workflowId: candidate.workflowId, revision, phase: "done", owner: "human", allowedCommands: [], pendingAction: "Merged", lastEventId: state.lastEventId, state });
}

const IGNORED_PHASES = new Set(["backlog", "planning", "development", "reviewing_delivery", "repair_required", "done", "cancelled", "failed"]);

function candidates(database: ForgeDatabase, taskId?: string): Candidate[] {
  const rows = database.authQuery((db) => db.prepare(`SELECT p.task_id AS taskId, p.company_id AS companyId, p.workflow_id AS workflowId, p.revision, p.phase, r.repository, r.head_branch AS branch, r.pr_number AS pullRequestNumber, w.worktree_path AS worktreePath, w.starting_sha AS targetBaseSha, s.state_json AS stateJson
    FROM forge_issue_projections p JOIN forge_workflow_snapshots s ON s.task_id = p.task_id AND s.revision = p.revision
    JOIN forge_tasks t ON t.id = p.task_id AND t.company_id = p.company_id AND t.archived_at IS NULL
    JOIN forge_releases r ON r.task_id = p.task_id AND r.superseded_at IS NULL
    LEFT JOIN forge_issue_worktrees w ON w.task_id = p.task_id AND w.company_id = p.company_id AND w.workflow_id = p.workflow_id AND w.status <> 'released'
    WHERE (? IS NULL OR p.task_id = ?) AND r.repository IS NOT NULL AND r.head_branch IS NOT NULL ORDER BY p.task_id`).all(taskId ?? null, taskId ?? null) as Array<Omit<Candidate, "state"> & { stateJson: string }>);
  return rows.flatMap((row) => {
    if (IGNORED_PHASES.has(row.phase)) return [];
    const state = IssueWorkflowStateSchema.safeParse(json(row.stateJson, undefined));
    return state.success ? [{ ...row, state: state.data }] : [];
  });
}

function classify(candidate: Candidate, observed: GithubPullRequestObservation): GithubObservation {
  if (observed.state === "merged") return "merged";
  if (observed.state === "closed") return "closed";
  if (observed.headSha && candidate.state.expectedHeadSha && observed.headSha.toLowerCase() !== candidate.state.expectedHeadSha.toLowerCase()) return "head_changed";
  if (observed.checks.failing) return "checks_failed";
  if (observed.checks.pending || !observed.checks.total) return "checks_pending";
  if (observed.checks.successful) return "checks_passed";
  return "unchanged";
}

function commandFor(candidate: Candidate, observation: GithubObservation): IssueCommand | null {
  if (["merged", "closed"].includes(observation) || observation === "head_changed") {
    if (candidate.state.allowedCommands.includes("reconcile_merge")) return "reconcile_merge";
  }
  if (["checks_passed", "checks_failed", "checks_pending", "head_changed"].includes(observation)) {
    if (candidate.state.allowedCommands.includes("reconcile_ci")) return "reconcile_ci";
  }
  return null;
}

/** One idempotent entry point for poll, startup, webhook, and manual refresh. */
export async function reconcileGithubObservations(database: ForgeDatabase, config: ForgeConfig, options: ReconciliationOptions = {}): Promise<GithubReconciliationResult> {
  const rows = candidates(database, options.taskId);
  const observe = options.observe ?? createGithubReleasePort().observePullRequest;
  const execute = options.execute ?? executeIssueCommand;
  const integrate = options.integrate ?? integrateRemoteBranch;
  const outcomes: Outcome[] = [];
  let signalled = 0, skipped = 0, errors = 0;
  if (!observe) return { inspected: rows.length, signalled, skipped: rows.length, errors, outcomes };
  for (const candidate of rows) {
    try {
      const observed = await observe({ repository: candidate.repository, branch: candidate.branch, pullRequestNumber: candidate.pullRequestNumber });
      const observation = classify(candidate, observed);
      let integration: RemoteIntegration["kind"] | undefined;
      let conflict: RemoteConflict | undefined;
      if (observation === "head_changed" && observed.headSha && candidate.worktreePath) {
        const result = await integrate(database, config, { taskId: candidate.taskId, companyId: candidate.companyId, workflowId: candidate.workflowId, repository: candidate.repository, branchName: candidate.branch, remoteHead: observed.headSha, worktreePath: candidate.worktreePath, targetBaseSha: candidate.targetBaseSha });
        integration = result.kind;
        if (result.kind === "conflict") conflict = remoteConflict(database, result);
        if (result.kind === "skipped_active_turn") { skipped += 1; outcomes.push({ taskId: candidate.taskId, workflowId: candidate.workflowId, observation, commandKind: null, commandId: null, deduplicated: false, integration }); continue; }
      }
      const command = integration === "conflict" ? "integrate_remote_conflict" : commandFor(candidate, observation);
      // A merge on GitHub is terminal truth. When the workflow cannot take the command (wrong phase, or the
      // Engine run is closed), adopt the merge into the projection directly instead of leaving the task stale.
      if (observation === "merged" && !command) { adoptMergedPullRequest(database, candidate); signalled += 1; outcomes.push({ taskId: candidate.taskId, workflowId: candidate.workflowId, observation, commandKind: "adopt_merged", commandId: null, deduplicated: false }); continue; }
      if (!command) { skipped += 1; outcomes.push({ taskId: candidate.taskId, workflowId: candidate.workflowId, observation, commandKind: null, commandId: null, deduplicated: false, ...(integration ? { integration } : {}) }); continue; }
      const input = conflict
        ? durableCommand(candidate.workflowId, "integrate-remote-conflict", { expectedRevision: candidate.revision, actorUserId: "github-reconciler", forwardMergeId: conflict.forwardMergeId, priorHead: conflict.priorHead, priorTree: conflict.priorTree, remoteHead: conflict.remoteHead, conflictArtifact: { id: conflict.conflictArtifactId, kind: "forward-merge-conflict" as const }, conflictFileCount: conflict.conflictFileCount })
        : durableCommand(candidate.workflowId, command, { expectedRevision: candidate.revision, actorUserId: "github-reconciler", headSha: observed.headSha, observation });
      const deduplicated = candidate.state.processedCommandIds?.includes(input.commandId) ?? false;
      if (!deduplicated) {
        try {
          if (command === "integrate_remote_conflict" && !options.execute) await executeRemoteConflict(config, candidate.workflowId, input as Parameters<typeof executeRemoteConflict>[2]);
          else await execute(config, candidate.workflowId, command, input);
        } catch (error) {
          if (observation !== "merged") throw error;
          adoptMergedPullRequest(database, candidate);
        }
        signalled += 1;
      }
      else skipped += 1;
      outcomes.push({ taskId: candidate.taskId, workflowId: candidate.workflowId, observation, commandKind: command, commandId: input.commandId, deduplicated, ...(integration ? { integration } : {}) });
    } catch (error) {
      errors += 1;
      console.warn("GitHub observation reconciliation failed", { taskId: candidate.taskId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { inspected: rows.length, signalled, skipped, errors, outcomes };
}

export function refreshTaskFromGithub(database: ForgeDatabase, config: ForgeConfig, taskId: string): Promise<GithubReconciliationResult> {
  return reconcileGithubObservations(database, config, { taskId });
}
