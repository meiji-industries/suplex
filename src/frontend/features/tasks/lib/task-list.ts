import { readJson } from "../../../lib/api.js";
import type { Task } from "../../../../tasks/contracts.js";

export async function readTaskList(companyId: string, archived = false, signal?: AbortSignal): Promise<Task[]> {
  return (await readJson<{ tasks: Task[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks?archived=${archived}`, signal ? { signal } : undefined)).tasks;
}

export function showRecentTasks(path: string): boolean {
  return !/^\/(?:admin(?:\/|$)|profile(?:\/|$)|companies\/[^/]+\/settings(?:\/|$))/.test(path);
}
