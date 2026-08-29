import type { ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { IssueWorkflowStateSchema } from "./engine/issue-contracts.js";

export class ProjectionRebuildFailure extends Error {
  readonly code = "projection_snapshot_unavailable" as const;
  constructor(message: string) { super(message); this.name = "ProjectionRebuildFailure"; }
}
export interface ProjectionRebuildResult { rebuilt: number; findings: Array<{ taskId: string; code: string; summary: string }> }
export class ProjectionRebuildService {
  constructor(private readonly database: ForgeDatabase, _config: ForgeConfig) { void _config; }
  async rebuild(scope: { companyId?: string; taskId?: string } = {}): Promise<ProjectionRebuildResult> {
    const rows = this.database.authQuery((db) => db.prepare(`SELECT s.task_id taskId, s.state_json stateJson, s.run_id runId FROM forge_workflow_snapshots s JOIN (SELECT task_id, max(revision) revision FROM forge_workflow_snapshots GROUP BY task_id) latest ON latest.task_id=s.task_id AND latest.revision=s.revision JOIN forge_tasks t ON t.id=s.task_id WHERE (? IS NULL OR t.company_id=?) AND (? IS NULL OR t.id=?) ORDER BY s.task_id`).all(scope.companyId ?? null, scope.companyId ?? null, scope.taskId ?? null, scope.taskId ?? null) as Array<{ taskId: string; stateJson: string; runId: string }>);
    const findings: ProjectionRebuildResult["findings"] = []; let rebuilt = 0;
    for (const row of rows) {
      const parsed = IssueWorkflowStateSchema.safeParse(JSON.parse(row.stateJson));
      if (!parsed.success) { findings.push({ taskId: row.taskId, code: "snapshot_invalid", summary: "Latest engine snapshot failed schema validation" }); continue; }
      const state = parsed.data;
      this.database.projectIssueState({ taskId: state.issueId, companyId: state.companyId, projectId: state.projectId, workflowId: state.workflowId, runId: row.runId, revision: state.revision, phase: state.phase, owner: state.owner, allowedCommands: state.allowedCommands, pendingAction: state.pendingAction, lastEventId: state.lastEventId, state });
      rebuilt += 1;
    }
    return { rebuilt, findings };
  }
}
