import { readJson } from "./api.js";
import type { ApiTaskSummary } from "./view-shared.js";

const reads = new Map<string, Promise<ApiTaskSummary[]>>();

export function readTaskList(companyId: string, refresh = false): Promise<ApiTaskSummary[]> {
  if (refresh) reads.delete(companyId);
  const current = reads.get(companyId);
  if (current) return current;
  const read = readJson<{ tasks: ApiTaskSummary[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks`).then((result) => result.tasks).catch((error: unknown) => { reads.delete(companyId); throw error; });
  reads.set(companyId, read);
  return read;
}

export function invalidateTaskList(companyId: string): void { reads.delete(companyId); }
