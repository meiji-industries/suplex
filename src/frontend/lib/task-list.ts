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

export type TaskListInvalidationHub = { subscribe(companyId: string, listener: () => void): () => void };

export function createTaskListInvalidationHub(options: { createEventSource?: (url: string) => EventSource; debounceMs?: number } = {}): TaskListInvalidationHub {
  const createEventSource = options.createEventSource ?? ((url: string) => new globalThis.EventSource(url));
  const debounceMs = options.debounceMs ?? 300;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Map<string, Set<() => void>>();
  const pending = new Set<string>();
  const flush = (): void => {
    timer = undefined;
    const companies = [...pending];
    pending.clear();
    for (const companyId of companies) {
      invalidateTaskList(companyId);
      for (const listener of listeners.get(companyId) ?? []) listener();
    }
  };
  const handle = (event: MessageEvent): void => {
    try {
      const data = JSON.parse(String(event.data)) as { companyId?: string };
      if (typeof data.companyId !== "string") return;
      pending.add(data.companyId);
      timer ??= setTimeout(flush, debounceMs);
    } catch { /* Ignore malformed events. */ }
  };
  const refreshSubscribed = (): void => {
    for (const companyId of listeners.keys()) pending.add(companyId);
    timer ??= setTimeout(flush, debounceMs);
  };
  return {
    subscribe(companyId: string, listener: () => void): () => void {
      let set = listeners.get(companyId);
      if (!set) { set = new Set(); listeners.set(companyId, set); }
      set.add(listener);
      if (!source) {
        source = createEventSource("/api/tasks/events");
        source.addEventListener("invalidate", handle as EventListener);
        source.addEventListener("ready", refreshSubscribed);
      }
      return () => {
        const current = listeners.get(companyId);
        if (!current || !current.delete(listener)) return;
        if (current.size === 0) listeners.delete(companyId);
        if (listeners.size > 0) return;
        source?.close();
        source = undefined;
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        pending.clear();
      };
    },
  };
}

export const subscribeTaskListInvalidations = createTaskListInvalidationHub().subscribe;
