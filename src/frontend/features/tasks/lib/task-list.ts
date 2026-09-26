import { listTasks } from "./task-api.js";
import type { Task } from "../../../contracts/tasks.js";

export async function readTaskList(companyId: string, archived = false, signal?: AbortSignal): Promise<Task[]> {
  return listTasks(companyId, { archived, ...(signal ? { signal } : {}) });
}

export function showRecentTasks(path: string): boolean {
  return !/^\/(?:admin(?:\/|$)|profile(?:\/|$)|companies\/[^/]+\/settings(?:\/|$))/.test(path);
}
