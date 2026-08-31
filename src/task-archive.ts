import { IssueWorkflowStateSchema } from "./engine/issue-contracts.js";
import { jsonRequired } from "./task-utils.js";
import type { ForgeDatabase } from "./database.js";
import { TaskFailure, type ForgeTask, type TaskService } from "./tasks.js";

export type ArchiveTaskResult =
  | { status: "archived"; task: ForgeTask }
  | { status: "confirmation_required"; dirtyFileCount: number; task: ForgeTask };

export type WorktreeCleanupPort = (input: { taskId: string; companyId: string; workflowId: string; confirmDiscardDirty?: boolean }) => Promise<{ outcome: "cleaned" | "already_absent" | "dirty_confirmation_required" | "not_owned"; dirtyFileCount: number; evidenceArtifactId?: string }>;

export class TaskArchiveService {
  constructor(private readonly tasks: TaskService, private readonly database: ForgeDatabase, private readonly now: () => Date = () => new Date(), private readonly cleanupOptions: { cleanupWorktree?: WorktreeCleanupPort } = {}) {}

  async archiveTask(actorUserId: string, taskId: string, expectedRevision: number, options: { confirmDiscardDirty?: boolean } = {}): Promise<ArchiveTaskResult> {
    let task = this.tasks.getTask(actorUserId, taskId);
    if (task.archivedAt) return { status: "archived", task };
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [{ code: "stale-revision", field: "expectedRevision", message: "Refresh the issue before this action" }], 409, task);
    if (!["done", "cancelled", "failed"].includes(task.phase)) throw new TaskFailure("Task action is not available", [{ code: "illegal-command", field: "phase", message: "Only a terminal task can be archived" }], 409, task);
    if (task.worktreeState !== "cleaned") {
      let cleanedLocally = false;
      try {
        task = await this.tasks.executeCommand(actorUserId, taskId, "delete_worktree", { expectedRevision: task.revision, ...(options.confirmDiscardDirty !== undefined ? { confirmDiscardDirty: options.confirmDiscardDirty } : {}) });
      } catch (error) {
        if (!(error instanceof TaskFailure)) throw error;
        const cleanup = this.cleanupOptions.cleanupWorktree;
        if (cleanup && error.findings.some((finding) => finding.code === "workflow-update-rejected")) {
          const result = await cleanup({ taskId: task.id, companyId: task.companyId, workflowId: task.workflowId, ...(options.confirmDiscardDirty !== undefined ? { confirmDiscardDirty: options.confirmDiscardDirty } : {}) });
          if (result.outcome === "dirty_confirmation_required") return { status: "confirmation_required", dirtyFileCount: result.dirtyFileCount, task };
          if (result.outcome === "not_owned") throw new TaskFailure("Worktree could not be removed", [{ code: "worktree-cleanup-failed", field: "worktree", message: "Forge does not own the requested worktree" }], 409, task);
          this.recordCleanedWorktree(task);
          cleanedLocally = true;
        } else {
          throw new TaskFailure("Worktree could not be removed", [{ code: "worktree-cleanup-failed", field: "worktree", message: error.message }], 409, task);
        }
      }
      if (!cleanedLocally) {
        const dirtyFileCount = dirtyCount(task.pendingAction);
        if (dirtyFileCount !== null) return { status: "confirmation_required", dirtyFileCount, task };
      }
    }
    const archivedAt = this.now().toISOString();
    this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET archived_at = COALESCE(archived_at, ?) WHERE id = ? AND company_id = ?").run(archivedAt, task.id, task.companyId));
    return { status: "archived", task: this.tasks.getTask(actorUserId, taskId) };
  }

  unarchiveTask(actorUserId: string, taskId: string): ForgeTask {
    const task = this.tasks.getTask(actorUserId, taskId);
    if (!task.archivedAt) return task;
    this.database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET archived_at = NULL WHERE id = ? AND company_id = ?").run(task.id, task.companyId));
    return this.tasks.getTask(actorUserId, taskId);
  }


  /**
   * Records a locally cleaned worktree in the issue projection after the
   * durable workflow has ended. Never throws: the worktree is already gone
   * and the member must be able to archive.
   */
  private recordCleanedWorktree(task: ForgeTask): void {
    const snapshot = this.database.authQuery((db) => db.prepare(`SELECT state_json, run_id AS runId
      FROM forge_workflow_snapshots
      WHERE task_id = ? AND workflow_id = ?
      ORDER BY revision DESC LIMIT 1`).get(task.id, task.workflowId) as { state_json: string; runId: string | null } | undefined);
    if (!snapshot) return;
    let stored: unknown;
    try { stored = jsonRequired(snapshot.state_json); } catch { return; }
    const state = IssueWorkflowStateSchema.parse(stored);
    if (state.revision !== task.revision) return;
    const next = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, worktreeState: "cleaned", allowedCommands: state.allowedCommands.filter((entry) => entry !== "delete_worktree"), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    this.database.projectIssueEvent({ schemaVersion: 1, runId: snapshot.runId ?? state.workflowId, eventId: next.lastEventId, state: next });
  }
}

function dirtyCount(pendingAction: string | null): number | null {
  const match = pendingAction?.match(/Worktree has (\d+) uncommitted changes/);
  return match ? Number(match[1]) : null;
}
