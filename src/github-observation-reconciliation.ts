import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { createGithubReleasePort, type GithubPullRequestObservation } from "./github-release.js";
import { json } from "./task-utils.js";
import { durableCommand, executeIssueCommand } from "./temporal/service.js";
import { IssueWorkflowStateSchema, type IssueWorkflowState } from "./temporal/issue-contracts.js";
import type { IssueCommand } from "./commands/registry.js";

export type GithubObservation = "merged" | "closed" | "checks_passed" | "checks_failed" | "checks_pending" | "head_changed" | "unchanged";
type Outcome = { taskId: string; workflowId: string; observation: GithubObservation; commandKind: string | null; commandId: string | null; deduplicated: boolean };
export interface GithubReconciliationResult { inspected: number; signalled: number; skipped: number; errors: number; outcomes: Outcome[] }
type Candidate = { taskId: string; companyId: string; workflowId: string; revision: number; phase: string; repository: string; branch: string; pullRequestNumber: number | null; state: IssueWorkflowState };
type ReconciliationOptions = {
  taskId?: string;
  observe?: (input: { repository: string; branch: string; pullRequestNumber?: number | null }) => Promise<GithubPullRequestObservation>;
  execute?: typeof executeIssueCommand;
};

const IGNORED_PHASES = new Set(["backlog", "planning", "development", "reviewing_delivery", "repair_required", "done", "cancelled"]);

function candidates(database: ForgeDatabase, taskId?: string): Candidate[] {
  const rows = database.authQuery((db) => db.prepare(`SELECT p.task_id AS taskId, p.company_id AS companyId, p.workflow_id AS workflowId, p.revision, p.phase, r.repository, r.head_branch AS branch, r.pr_number AS pullRequestNumber, s.state_json AS stateJson
    FROM forge_issue_projections p JOIN forge_workflow_snapshots s ON s.task_id = p.task_id AND s.revision = p.revision
    JOIN forge_releases r ON r.task_id = p.task_id AND r.superseded_at IS NULL
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
  const outcomes: Outcome[] = [];
  let signalled = 0, skipped = 0, errors = 0;
  if (!observe) return { inspected: rows.length, signalled, skipped: rows.length, errors, outcomes };
  for (const candidate of rows) {
    try {
      const observed = await observe({ repository: candidate.repository, branch: candidate.branch, pullRequestNumber: candidate.pullRequestNumber });
      const observation = classify(candidate, observed);
      const command = commandFor(candidate, observation);
      if (!command) { skipped += 1; outcomes.push({ taskId: candidate.taskId, workflowId: candidate.workflowId, observation, commandKind: null, commandId: null, deduplicated: false }); continue; }
      const input = durableCommand(candidate.workflowId, command, { expectedRevision: candidate.revision, actorUserId: "github-reconciler", headSha: observed.headSha, observation });
      const deduplicated = candidate.state.processedCommandIds?.includes(input.commandId) ?? false;
      if (!deduplicated) { await execute(config, candidate.workflowId, command, input); signalled += 1; }
      else skipped += 1;
      outcomes.push({ taskId: candidate.taskId, workflowId: candidate.workflowId, observation, commandKind: command, commandId: input.commandId, deduplicated });
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
