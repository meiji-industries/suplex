import type { HealthSnapshot } from "../../platform/health.js";

export type HealthFreshness = "checking" | "current" | "stale";
export type HealthContextSelector = { projectId: string } | { profileIds: readonly string[] } | undefined;

export function healthContextQuery(context: HealthContextSelector): string {
  if (!context) return "";
  if ("projectId" in context) return `projectId=${encodeURIComponent(context.projectId)}`;
  const ids = context.profileIds.map((id) => encodeURIComponent(id)).join(",");
  return ids ? `profileIds=${ids}` : "";
}

export function healthContextKey(context: HealthContextSelector): string {
  if (!context) return "";
  if ("projectId" in context) return `project:${context.projectId}`;
  return `profiles:${[...context.profileIds].sort().join(",")}`;
}

export interface HealthRefreshState {
  snapshot: HealthSnapshot | undefined;
  freshness: HealthFreshness;
  lastSuccessfulCheckAt: string | undefined;
  refreshing: boolean;
}

export interface HealthRefresherOptions {
  initialSnapshot?: HealthSnapshot | undefined;
  read: (context: HealthContextSelector) => Promise<HealthSnapshot>;
  onChange?: (state: HealthRefreshState) => void;
}

export interface HealthRefresher {
  readonly state: HealthRefreshState;
  refresh(context?: HealthContextSelector): Promise<void>;
  /** Registers a visible health surface; notifyVisible re-checks while any watcher is registered. */
  watch(): () => void;
  /** Call when the window becomes visible or focused. */
  notifyVisible(): void;
}

/**
 * Owns the refresh lifecycle for the health snapshot. Concurrent calls for the
 * same context share one request; a response for a context that is no longer
 * selected is discarded; a failed refresh keeps the last snapshot and marks it
 * stale.
 */
export function createHealthRefresher(options: HealthRefresherOptions): HealthRefresher {
  let state: HealthRefreshState = {
    snapshot: options.initialSnapshot,
    freshness: options.initialSnapshot ? "current" : "checking",
    lastSuccessfulCheckAt: options.initialSnapshot?.generatedAt,
    refreshing: false,
  };
  let currentKey = "";
  let currentContext: HealthContextSelector;
  let pending: { key: string; promise: Promise<void> } | undefined;
  let watchers = 0;

  const set = (patch: Partial<HealthRefreshState>): void => {
    state = { ...state, ...patch };
    options.onChange?.(state);
  };

  const refresh = (context?: HealthContextSelector): Promise<void> => {
    const key = healthContextKey(context);
    if (key !== currentKey) {
      currentKey = key;
      currentContext = context;
      // Provider results belong to their context; drop them when it changes.
      const snapshot = state.snapshot;
      if (snapshot && snapshot.checks.some((check) => check.provider !== undefined)) {
        set({ snapshot: { ...snapshot, checks: snapshot.checks.filter((check) => check.provider === undefined) } });
      }
    }
    if (pending && pending.key === key) return pending.promise;
    set({ refreshing: true, freshness: "checking" });
    const promise = options.read(context).then((next) => {
      if (currentKey === key) set({ snapshot: next, lastSuccessfulCheckAt: next.generatedAt, freshness: "current" });
    }).catch(() => {
      if (currentKey === key) set({ freshness: "stale" });
    }).finally(() => {
      if (pending?.promise === promise) pending = undefined;
      set({ refreshing: pending !== undefined });
    });
    pending = { key, promise };
    return promise;
  };

  return {
    get state() { return state; },
    refresh,
    watch: () => {
      watchers += 1;
      return () => { watchers = Math.max(0, watchers - 1); };
    },
    notifyVisible: () => { if (watchers > 0) void refresh(currentContext); },
  };
}
