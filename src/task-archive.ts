import type { ForgeDatabase } from "./database.js";
import type { ForgeTask, TaskService } from "./tasks.js";

export type ArchiveTaskResult =
  | { status: "archived"; task: ForgeTask }
  | { status: "confirmation_required"; dirtyFileCount: number; task: ForgeTask };

export class TaskArchiveService {
  constructor(private readonly tasks: TaskService, private readonly database: ForgeDatabase, private readonly now: () => Date = () => new Date()) {}

  async archiveTask(actorUserId: string, taskId: string, options: { confirmDiscardDirty?: boolean } = {}): Promise<ArchiveTaskResult> {
    let task = this.tasks.getTask(actorUserId, taskId);
    if (task.archivedAt) return { status: "archived", task };
    if (task.phase !== "done" && task.phase !== "cancelled") {
      task = await this.tasks.executeCommand(actorUserId, taskId, "cancel_issue", { expectedRevision: task.revision });
      task = await this.waitForCancelled(actorUserId, taskId, task);
    }
    if (task.worktreeState !== "cleaned" && task.allowedCommands.includes("delete_worktree")) {
      task = await this.tasks.executeCommand(actorUserId, taskId, "delete_worktree", { expectedRevision: task.revision, ...(options.confirmDiscardDirty !== undefined ? { confirmDiscardDirty: options.confirmDiscardDirty } : {}) });
      const dirtyFileCount = dirtyCount(task.pendingAction);
      if (dirtyFileCount !== null) return { status: "confirmation_required", dirtyFileCount, task };
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

  private async waitForCancelled(actorUserId: string, taskId: string, initial: ForgeTask): Promise<ForgeTask> {
    let task = initial;
    for (let attempt = 0; attempt < 40 && task.phase !== "cancelled"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      task = this.tasks.getTask(actorUserId, taskId);
    }
    return task;
  }
}

function dirtyCount(pendingAction: string | null): number | null {
  const match = pendingAction?.match(/Worktree has (\d+) uncommitted changes/);
  return match ? Number(match[1]) : null;
}
