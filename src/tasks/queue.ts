import type Database from "better-sqlite3";
import { z } from "zod";
import { assertTaskPullRequestsAvailable } from "../delivery/pull-request-ownership.js";
import { AuthFailure } from "../identity/auth.js";
import { DeliveryTargetSchema, type TaskQueue, type TaskQueueWait } from "./contracts.js";
import { TaskControlStatusSchema, type TaskControlStatus } from "./control.js";

/**
 * A queued task is a backlog task with a persisted start intent (forge_tasks.start_queued). It stays in the backlog, so no
 * session or turn can exist for it, until admitQueuedTask moves it to active. Eligibility is read from the task, its
 * dependency edges, and each prerequisite's own control row on every call; nothing mirrors it.
 */

const PrerequisiteSchema = z.object({ id: z.string(), title: z.string(), status: TaskControlStatusSchema, deliveryTarget: DeliveryTargetSchema, archived: z.number(), pullRequestState: z.string().nullable() });
type Prerequisite = z.infer<typeof PrerequisiteSchema>;

/**
 * A prerequisite is complete when it is delivered at its own delivery target. Delivery at merged also needs the merged
 * pull request state Forge observed from GitHub; until Forge observes it, the dependent waits and Forge observes again.
 * Delivery at a pull request, remote branch, or local worktree target is complete without a merge.
 */
function waitReason(prerequisite: Prerequisite): TaskQueueWait["reason"] | null {
  if (prerequisite.status === "delivered") return prerequisite.deliveryTarget !== "merged" || prerequisite.pullRequestState === "merged" ? null : "prerequisite_merge_unobserved";
  if (prerequisite.archived) return "prerequisite_archived";
  return ({ backlog: "prerequisite_not_started", active: "prerequisite_running", waiting_human: "prerequisite_needs_human", cancelled: "prerequisite_cancelled" } as const)[prerequisite.status];
}

function waitSummary(prerequisite: Prerequisite, reason: TaskQueueWait["reason"]): string {
  const condition = prerequisite.deliveryTarget === "merged" ? "its pull request merges" : "it is delivered";
  switch (reason) {
    case "prerequisite_not_started": return `${prerequisite.title} did not start. Start it. This task starts when ${condition}.`;
    case "prerequisite_running": return `${prerequisite.title} is running. This task starts when ${condition}.`;
    case "prerequisite_needs_human": return `${prerequisite.title} needs an answer. Answer it. This task starts when ${condition}.`;
    case "prerequisite_cancelled": return `${prerequisite.title} is cancelled. Remove it from Blocked by, or disarm this task.`;
    case "prerequisite_archived": return `${prerequisite.title} is archived and not delivered. Remove it from Blocked by, or open and deliver it.`;
    case "prerequisite_merge_unobserved": return `${prerequisite.title} is delivered, but Forge did not observe its merged pull request. Forge checks GitHub again.`;
  }
}

/** Every prerequisite that is not complete, with the exact reason, ordered by task id like Blocked by. */
export function prerequisiteWaits(db: Database.Database, taskId: string): TaskQueueWait[] {
  const rows = z.array(PrerequisiteSchema).parse(db.prepare("SELECT t.id, t.title, c.status, c.delivery_target AS deliveryTarget, t.archived_at IS NOT NULL AS archived, json_extract(c.pull_request_json, '$.state') AS pullRequestState FROM forge_task_dependencies d JOIN forge_tasks t ON t.id = d.depends_on_task_id JOIN forge_task_controls c ON c.task_id = t.id WHERE d.task_id = ? ORDER BY t.id").all(taskId));
  return rows.flatMap(prerequisite => {
    const reason = waitReason(prerequisite);
    return reason ? [{ id: prerequisite.id, title: prerequisite.title, status: prerequisite.status, deliveryTarget: prerequisite.deliveryTarget, reason, summary: waitSummary(prerequisite, reason) }] : [];
  });
}

export function taskQueue(db: Database.Database, taskId: string, status: TaskControlStatus): TaskQueue {
  const queued = (db.prepare("SELECT start_queued FROM forge_tasks WHERE id = ?").get(taskId) as { start_queued: number } | undefined)?.start_queued === 1;
  const state = status === "backlog" ? queued ? "queued" : "backlog" : status === "active" ? "running" : status === "waiting_human" ? "needs_attention" : status;
  return { startIntent: queued ? "queued" : "manual", state, waitingOn: status === "backlog" ? prerequisiteWaits(db, taskId) : [] };
}

/**
 * The only admission path for a queued task. Call it inside a transaction: it rechecks the intent, the archive, and every
 * prerequisite, then moves the task out of the backlog with a conditional update. Only one call can win; a repeated or late
 * wake finds the task already active, cancelled, or disarmed and changes nothing. The consumed intent is cleared.
 */
export function admitQueuedTask(db: Database.Database, taskId: string): boolean {
  const row = db.prepare("SELECT t.start_queued, t.archived_at, c.status FROM forge_tasks t JOIN forge_task_controls c ON c.task_id = t.id WHERE t.id = ?").get(taskId) as { start_queued: number; archived_at: string | null; status: string } | undefined;
  if (!row || row.start_queued !== 1 || row.archived_at !== null || row.status !== "backlog") return false;
  if (prerequisiteWaits(db, taskId).length) return false;
  assertTaskPullRequestsAvailable(db, taskId);
  const time = new Date().toISOString();
  if (db.prepare("UPDATE forge_task_controls SET status = 'active', wake_at = ?, updated_at = ? WHERE task_id = ? AND status = 'backlog'").run(time, time, taskId).changes !== 1) return false;
  db.prepare("UPDATE forge_tasks SET start_queued = 0, updated_at = ? WHERE id = ?").run(time, taskId);
  return true;
}

/** Queued tasks whose prerequisites look complete now, or only the queued dependents of one prerequisite. Admission rechecks each one. */
export function readyQueuedTaskIds(db: Database.Database, dependencyOf?: string): string[] {
  const rows = (dependencyOf === undefined
    ? db.prepare("SELECT id FROM forge_tasks WHERE start_queued = 1 AND archived_at IS NULL ORDER BY created_at, id").all()
    : db.prepare("SELECT t.id FROM forge_task_dependencies d JOIN forge_tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ? AND t.start_queued = 1 AND t.archived_at IS NULL ORDER BY t.created_at, t.id").all(dependencyOf)) as Array<{ id: string }>;
  return rows.map(row => row.id).filter(id => !prerequisiteWaits(db, id).length);
}

/** Admits the given queued tasks inside the caller's transaction. A task whose pull request another task owns stays queued. */
export function admitQueuedTasks(db: Database.Database, taskIds: string[]): string[] {
  return taskIds.filter(id => {
    try { return admitQueuedTask(db, id); }
    catch (error) {
      // ponytail: another owner of the pull request is not reported as a wait reason; the task stays queued and the sweep retries.
      if (error instanceof AuthFailure) return false;
      throw error;
    }
  });
}
