import { readJson } from "./api.js";
import type { ApiTaskSummary } from "./view-shared.js";

const taskListTtlMs = 2000;
const reads = new Map<string, { expiresAt: number; read: Promise<ApiTaskSummary[]> }>();

export function readTaskList(companyId: string, archived = false, refresh = false): Promise<ApiTaskSummary[]> {
  const key = `${companyId}:${archived}`;
  if (refresh) reads.delete(key);
  const current = reads.get(key);
  if (current && current.expiresAt > Date.now()) return current.read;
  const read = readJson<{ tasks: ApiTaskSummary[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks${archived ? "?archived=true" : ""}`).then((result) => result.tasks);
  const entry = { expiresAt: Number.POSITIVE_INFINITY, read };
  reads.set(key, entry);
  void read.then(
    () => { entry.expiresAt = Date.now() + taskListTtlMs; },
    () => { if (reads.get(key) === entry) reads.delete(key); },
  );
  return read;
}

export function invalidateTaskList(companyId: string): void { for (const key of reads.keys()) if (key.startsWith(`${companyId}:`)) reads.delete(key); }

export type TaskListInvalidationEvent = "invalidate" | "ready";
export type TaskListInvalidationHub = { subscribe(companyId: string, listener: (event: TaskListInvalidationEvent) => void): () => void };

export function createTaskListInvalidationHub(options: { createEventSource?: (url: string) => EventSource; debounceMs?: number } = {}): TaskListInvalidationHub {
  const createEventSource = options.createEventSource ?? ((url: string) => new globalThis.EventSource(url));
  const debounceMs = options.debounceMs ?? 3000;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Map<string, Set<(event: TaskListInvalidationEvent) => void>>();
  const pending = new Map<string, TaskListInvalidationEvent>();
  const queue = (companyId: string, event: TaskListInvalidationEvent): void => {
    if (pending.get(companyId) !== "ready") pending.set(companyId, event);
    timer ??= setTimeout(flush, debounceMs);
  };
  const flush = (): void => {
    timer = undefined;
    const companies = [...pending];
    pending.clear();
    for (const [companyId, event] of companies) {
      invalidateTaskList(companyId);
      for (const listener of listeners.get(companyId) ?? []) listener(event);
    }
  };
  const handle = (event: MessageEvent): void => {
    try {
      const data = JSON.parse(String(event.data)) as { companyId?: string };
      if (typeof data.companyId !== "string") return;
      queue(data.companyId, "invalidate");
    } catch { /* Ignore malformed events. */ }
  };
  const refreshSubscribed = (): void => {
    for (const companyId of listeners.keys()) queue(companyId, "ready");
  };
  return {
    subscribe(companyId: string, listener: (event: TaskListInvalidationEvent) => void): () => void {
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
