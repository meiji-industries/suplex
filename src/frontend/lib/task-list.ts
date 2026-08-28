import { readJson } from "./api.js";
import type { ApiTaskSummary } from "./view-shared.js";

const reads = new Map<string, Promise<ApiTaskSummary[]>>();

export function readTaskList(companyId: string, archived = false, refresh = false): Promise<ApiTaskSummary[]> {
  const key = `${companyId}:${archived}`;
  if (refresh) reads.delete(key);
  const current = reads.get(key);
  if (current) return current;
  const read = readJson<{ tasks: ApiTaskSummary[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks${archived ? "?archived=true" : ""}`).then((result) => result.tasks).catch((error: unknown) => { reads.delete(key); throw error; });
  reads.set(key, read);
  return read;
}

export function invalidateTaskList(companyId: string): void { for (const key of reads.keys()) if (key.startsWith(`${companyId}:`)) reads.delete(key); }
