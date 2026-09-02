import { useCallback, useEffect, useState } from "react";

import { ApiError, readJson } from "../../lib/api.js";
import { subscribeTaskListInvalidations } from "../../lib/task-list.js";
import type { ApiAgent, ApiAgentRuntime } from "../../lib/view-shared.js";

const runtimeRefreshIntervalMs = 5000;

export function shouldMonitorAgentStatus({ authenticated, loading, authBlocked }: { authenticated: boolean; loading: boolean; authBlocked: boolean }): boolean {
  return authenticated && !loading && !authBlocked;
}

export function reduceAgentAuthBlock(authBlocked: boolean, event: "unauthorized" | "authenticated"): boolean {
  return event === "authenticated" ? false : authBlocked || event === "unauthorized";
}

export function runtimeRefreshDelay(lastRequestedAt: number | undefined, now: number): number {
  return lastRequestedAt === undefined ? 0 : Math.max(0, runtimeRefreshIntervalMs - (now - lastRequestedAt));
}

export function useAgentStatus({ companyId, authenticated, loading, onAuthenticationRequired }: { companyId?: string; authenticated: boolean; loading: boolean; onAuthenticationRequired: () => void }): { agents: ApiAgent[]; runtime: ApiAgentRuntime[] } {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [runtime, setRuntime] = useState<ApiAgentRuntime[]>([]);
  const [authBlocked, setAuthBlocked] = useState(false);
  const enabled = shouldMonitorAgentStatus({ authenticated, loading, authBlocked });

  useEffect(() => {
    if (authenticated) setAuthBlocked((blocked) => reduceAgentAuthBlock(blocked, "authenticated"));
  }, [authenticated]);

  const handleError = useCallback((error: unknown): void => {
    if (error instanceof ApiError && error.statusCode === 401) {
      setAuthBlocked((blocked) => reduceAgentAuthBlock(blocked, "unauthorized"));
      onAuthenticationRequired();
    }
  }, [onAuthenticationRequired]);

  const reloadAll = useCallback(async (): Promise<void> => {
    try {
      const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
      const [agentResponse, runtimeResponse] = await Promise.all([readJson<{ agents: ApiAgent[] }>(`/api/agents${query}`), readJson<{ runtime: ApiAgentRuntime[] }>(`/api/agent-runtime${query}`)]);
      setAgents(agentResponse.agents);
      setRuntime(runtimeResponse.runtime);
    } catch (error) {
      setAgents([]);
      setRuntime([]);
      handleError(error);
    }
  }, [companyId, handleError]);

  const reloadRuntime = useCallback(async (): Promise<void> => {
    try {
      const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
      const response = await readJson<{ runtime: ApiAgentRuntime[] }>(`/api/agent-runtime${query}`);
      setRuntime(response.runtime);
    } catch (error) {
      setRuntime([]);
      handleError(error);
    }
  }, [companyId, handleError]);

  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setRuntime([]);
      return;
    }
    let closed = false;
    let lastRuntimeRequestedAt: number | undefined;
    let trailingTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshAll = (): void => {
      if (closed) return;
      if (trailingTimer !== undefined) clearTimeout(trailingTimer);
      trailingTimer = undefined;
      lastRuntimeRequestedAt = Date.now();
      void reloadAll();
    };
    const refreshRuntime = (): void => {
      if (closed) return;
      if (trailingTimer !== undefined) clearTimeout(trailingTimer);
      trailingTimer = undefined;
      lastRuntimeRequestedAt = Date.now();
      void reloadRuntime();
    };
    const scheduleRuntimeRefresh = (): void => {
      const delay = runtimeRefreshDelay(lastRuntimeRequestedAt, Date.now());
      if (delay === 0) refreshRuntime();
      else trailingTimer ??= setTimeout(refreshRuntime, delay);
    };
    refreshAll();
    const unsubscribe = companyId
      ? subscribeTaskListInvalidations(companyId, (event) => { if (event === "ready") refreshAll(); else scheduleRuntimeRefresh(); })
      : undefined;
    return () => {
      closed = true;
      unsubscribe?.();
      if (trailingTimer !== undefined) clearTimeout(trailingTimer);
    };
  }, [companyId, enabled, reloadAll, reloadRuntime]);

  return { agents, runtime };
}
