import type { ForgeDatabase } from "./database.js";
import { createGithubReleasePort, type GithubReleasePort } from "./github-release.js";
import { githubPullRequestObservationFields } from "./github-pull-request-observation.js";
import { json } from "./task-utils.js";
import { IssueWorkflowStateSchema, type IssueWorkflowState } from "./engine/issue-contracts.js";

type Candidate = { taskId: string; repository: string; branch: string; pullRequestNumber: number; state: IssueWorkflowState };
export type DonePullRequestSyncResult = { inspected: number; changed: Array<{ taskId: string; pullRequestNumber: number; state: string | null }> };

export function selectDonePullRequestSyncCandidates(database: ForgeDatabase): Candidate[] {
  const rows = database.authQuery((db) => db.prepare(`SELECT * FROM (SELECT p.task_id AS taskId, COALESCE(r.repository, json_extract(s.state_json, '$.releaseRepository')) AS repository, COALESCE(r.head_branch, json_extract(s.state_json, '$.branchName')) AS branch, COALESCE(r.pr_number, json_extract(s.state_json, '$.pullRequestNumber')) AS pullRequestNumber, s.state_json AS stateJson FROM forge_issue_projections p JOIN forge_workflow_snapshots s ON s.task_id = p.task_id AND s.revision = p.revision LEFT JOIN forge_releases r ON r.task_id = p.task_id AND r.pr_number IS NOT NULL AND r.superseded_at IS NULL WHERE p.phase = 'done') WHERE repository IS NOT NULL AND branch IS NOT NULL AND pullRequestNumber IS NOT NULL ORDER BY taskId`).all() as Array<{ taskId: string; repository: string; branch: string; pullRequestNumber: number; stateJson: string }>);
  return rows.flatMap((row) => {
    const raw = json(row.stateJson, undefined);
    const parsed = IssueWorkflowStateSchema.safeParse(raw);
    if (!parsed.success || ["merged", "closed"].includes(parsed.data.githubPullRequestState ?? "")) return [];
    return [{ taskId: row.taskId, repository: row.repository, branch: row.branch, pullRequestNumber: row.pullRequestNumber, state: parsed.data }];
  });
}

export async function reconcileDonePullRequests(database: ForgeDatabase, github: Pick<GithubReleasePort, "observePullRequest"> = createGithubReleasePort(), now = () => new Date().toISOString()): Promise<DonePullRequestSyncResult> {
  const candidates = selectDonePullRequestSyncCandidates(database), changed: DonePullRequestSyncResult["changed"] = [];
  if (!github.observePullRequest) return { inspected: candidates.length, changed };
  for (const candidate of candidates) {
    const observed = await github.observePullRequest({ repository: candidate.repository, branch: candidate.branch, pullRequestNumber: candidate.pullRequestNumber });
    const observedAt = now(), revision = candidate.state.revision + 1, lastEventId = `${candidate.state.workflowId}:${revision}`;
    const next = IssueWorkflowStateSchema.parse({ ...candidate.state, ...githubPullRequestObservationFields(observed, observedAt), revision, lastEventId, stateChangedAt: observedAt, ...(observed.state === "merged" ? { pendingAction: "Merged", mergeOutcome: "merged" } : {}) });
    database.projectIssueEvent({ schemaVersion: 1, runId: `${candidate.state.workflowId}:done-pr-reconciliation`, eventId: lastEventId, state: next });
    changed.push({ taskId: candidate.taskId, pullRequestNumber: observed.number ?? candidate.pullRequestNumber, state: observed.state });
  }
  return { inspected: candidates.length, changed };
}
