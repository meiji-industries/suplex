import type Database from "better-sqlite3";
import { z } from "zod";
import { assertTaskPullRequestsAvailable } from "../delivery/pull-request-ownership.js";
import { AuthFailure } from "../identity/auth.js";
import { DeliveryTargetSchema, type TaskQueue, type TaskQueueWait } from "./contracts.js";
import { TaskControlStatusSchema, type TaskControlStatus } from "./control.js";
import { pullRequestDependenciesInTransaction } from "./pull-request-dependencies.js";

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
  return ({ backlog: "prerequisite_not_started", queued: "prerequisite_not_started", active: "prerequisite_running", waiting_human: "prerequisite_needs_human", cancelled: "prerequisite_cancelled" } as const)[prerequisite.status];
}

function waitSummary(prerequisite: Prerequisite, reason: TaskQueueWait["reason"]): string {
  const condition = prerequisite.deliveryTarget === "merged" ? "its pull request merges" : "it is delivered";
  switch (reason) {
    case "prerequisite_not_started": return prerequisite.status === "queued"
      ? `${prerequisite.title} is queued. This task starts when ${condition}.`
      : `${prerequisite.title} did not start. Start it. This task starts when ${condition}.`;
    case "prerequisite_running": return `${prerequisite.title} is running. This task starts when ${condition}.`;
    case "prerequisite_needs_human": return `${prerequisite.title} needs an answer. Answer it. This task starts when ${condition}.`;
    case "prerequisite_cancelled": return `${prerequisite.title} is cancelled. Remove it from Blocked by, or send this task to the backlog.`;
    case "prerequisite_archived": return `${prerequisite.title} is archived and not delivered. Remove it from Blocked by, or open and deliver it.`;
    case "prerequisite_merge_unobserved": return `${prerequisite.title} is delivered, but Forge did not observe its merged pull request. Forge checks GitHub again.`;
    case "prerequisite_pull_request_open":
    case "prerequisite_pull_request_closed": throw new Error("Pull request prerequisite has no task summary");
    default: throw new Error("Invalid task prerequisite wait reason");
  }
}

/** Every prerequisite that is not complete, with the exact reason, ordered by task id like Blocked by. */
export function prerequisiteWaits(db: Database.Database, taskId: string): TaskQueueWait[] {
  const rows = z.array(PrerequisiteSchema).parse(db.prepare("SELECT t.id, t.title, c.status, c.delivery_target AS deliveryTarget, t.archived_at IS NOT NULL AS archived, json_extract(c.pull_request_json, '$.state') AS pullRequestState FROM forge_task_dependencies d JOIN forge_tasks t ON t.id = d.depends_on_task_id JOIN forge_task_controls c ON c.task_id = t.id WHERE d.task_id = ? ORDER BY t.id").all(taskId));
  const pullRequests = pullRequestDependenciesInTransaction(db, taskId).flatMap(prerequisite => {
    if (prerequisite.state === "merged") return [];
    const reason: "prerequisite_pull_request_closed" | "prerequisite_pull_request_open" = prerequisite.state === "closed" ? "prerequisite_pull_request_closed" : "prerequisite_pull_request_open";
    const summary = prerequisite.state === "closed" ? `Pull request #${prerequisite.number} is closed without merging. Reopen and merge it, or remove it from Blocked by.` : `Pull request #${prerequisite.number} is open. This task starts when it merges.`;
    return [{ kind: "pull_request" as const, id: `pull_request:${prerequisite.number}`, status: "backlog" as const, deliveryTarget: "pull_request_draft" as const, number: prerequisite.number, title: prerequisite.title, url: prerequisite.url, state: prerequisite.state, reason, summary }];
  });
  return [...rows.flatMap(prerequisite => {
    const reason = waitReason(prerequisite);
    return reason ? [{ kind: "task" as const, id: prerequisite.id, title: prerequisite.title, status: prerequisite.status, deliveryTarget: prerequisite.deliveryTarget, reason, summary: waitSummary(prerequisite, reason) }] : [];
  }), ...pullRequests];
}

export function taskQueue(db: Database.Database, taskId: string, status: TaskControlStatus): TaskQueue {
  return { waitingOn: status === "backlog" || status === "queued" ? prerequisiteWaits(db, taskId) : [] };
}

/**
 * The only admission path for a queued task. The caller's transaction rechecks status, archive, ownership, and prerequisites.
 */
export function admitQueuedTask(db: Database.Database, taskId: string): boolean {
  const row = db.prepare("SELECT t.archived_at, c.status FROM forge_tasks t JOIN forge_task_controls c ON c.task_id = t.id WHERE t.id = ?").get(taskId) as { archived_at: string | null; status: string } | undefined;
  if (!row || row.archived_at !== null || row.status !== "queued") return false;
  if (prerequisiteWaits(db, taskId).length) return false;
  assertTaskPullRequestsAvailable(db, taskId);
  const time = new Date().toISOString();
  if (db.prepare("UPDATE forge_task_controls SET status = 'active', wake_at = ?, updated_at = ? WHERE task_id = ? AND status = 'queued'").run(time, time, taskId).changes !== 1) return false;
  return true;
}

/** Queued tasks whose prerequisites look complete now, or only the queued dependents of one prerequisite. Admission rechecks each one. */
export function readyQueuedTaskIds(db: Database.Database, dependencyOf?: string): string[] {
  const rows = (dependencyOf === undefined
    ? db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_task_controls c ON c.task_id = t.id WHERE c.status = 'queued' AND t.archived_at IS NULL ORDER BY t.created_at, t.id").all()
    : db.prepare("SELECT t.id FROM forge_task_dependencies d JOIN forge_tasks t ON t.id = d.task_id JOIN forge_task_controls c ON c.task_id = t.id WHERE d.depends_on_task_id = ? AND c.status = 'queued' AND t.archived_at IS NULL ORDER BY t.created_at, t.id").all(dependencyOf)) as Array<{ id: string }>;
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
