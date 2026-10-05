import { listTasks } from "./task-api.js";
import type { TaskListTask } from "../../../contracts/task-responses.js";

export async function readTaskList(companyId: string, archived = false, signal?: AbortSignal): Promise<TaskListTask[]> {
  return listTasks(companyId, { archived, ...(signal ? { signal } : {}) });
}

export function showRecentTasks(path: string): boolean {
  return !/^\/(?:admin(?:\/|$)|profile(?:\/|$)|companies\/[^/]+\/settings(?:\/|$))/.test(path);
}

type QueuedTask = Pick<TaskListTask, "id" | "createdAt" | "dependsOn">;

/** Orders queued tasks by run order: each root, then its dependent chain depth-first, after all queued blockers. */
export function queueOrder<T extends QueuedTask>(tasks: readonly T[]): T[] {
  const sorted = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(sorted.map(task => [task.id, task]));
  const pending = new Map<string, number>();
  const children = new Map<string, T[]>();
  for (const task of sorted) {
    const blockers = [...new Set(task.dependsOn)].filter(id => byId.has(id));
    pending.set(task.id, blockers.length);
    for (const id of blockers) children.set(id, [...children.get(id) ?? [], task]);
  }
  const out: T[] = [];
  const emitted = new Set<string>();
  const visit = (task: T): void => {
    if (emitted.has(task.id)) return;
    emitted.add(task.id);
    out.push(task);
    for (const child of children.get(task.id) ?? []) {
      const left = (pending.get(child.id) ?? 0) - 1;
      pending.set(child.id, left);
      if (left === 0) visit(child);
    }
  };
  for (const task of sorted) if (pending.get(task.id) === 0) visit(task);
  // Cycles leave tasks with pending blockers; emit them in created order.
  for (const task of sorted) visit(task);
  return out;
}
