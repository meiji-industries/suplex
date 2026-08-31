import { useCallback, useEffect, useState } from "react";

import { ApiError, readJson } from "../../lib/api.js";
import type { ApiAgent, ApiAgentRuntime } from "../../lib/view-shared.js";

export function shouldMonitorAgentStatus({ authenticated, loading, authBlocked }: { authenticated: boolean; loading: boolean; authBlocked: boolean }): boolean {
  return authenticated && !loading && !authBlocked;
}

export function reduceAgentAuthBlock(authBlocked: boolean, event: "unauthorized" | "authenticated"): boolean {
  return event === "authenticated" ? false : authBlocked || event === "unauthorized";
}

export function useAgentStatus({ companyId, authenticated, loading, onAuthenticationRequired }: { companyId?: string; authenticated: boolean; loading: boolean; onAuthenticationRequired: () => void }): { agents: ApiAgent[]; runtime: ApiAgentRuntime[] } {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [runtime, setRuntime] = useState<ApiAgentRuntime[]>([]);
  const [authBlocked, setAuthBlocked] = useState(false);
  const enabled = shouldMonitorAgentStatus({ authenticated, loading, authBlocked });

  useEffect(() => {
    if (authenticated) setAuthBlocked((blocked) => reduceAgentAuthBlock(blocked, "authenticated"));
  }, [authenticated]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
      const [agentResponse, runtimeResponse] = await Promise.all([readJson<{ agents: ApiAgent[] }>(`/api/agents${query}`), readJson<{ runtime: ApiAgentRuntime[] }>(`/api/agent-runtime${query}`)]);
      setAgents(agentResponse.agents);
      setRuntime(runtimeResponse.runtime);
    } catch (error) {
      setAgents([]);
      setRuntime([]);
      if (error instanceof ApiError && error.statusCode === 401) {
        setAuthBlocked((blocked) => reduceAgentAuthBlock(blocked, "unauthorized"));
        onAuthenticationRequired();
      }
    }
  }, [companyId, onAuthenticationRequired]);

  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setRuntime([]);
    }
    let closed = false;
    const refresh = (): void => { if (!closed) void reload(); };
    refresh();
    // Task invalidations refresh the authoritative runtime snapshot without a
    // separate long-lived Herdr event subscription.
    const events = new EventSource("/api/tasks/events");
    events.addEventListener("ready", refresh);
    events.addEventListener("invalidate", refresh);
    // EventSource otherwise reconnects indefinitely after a lost session.
    events.onerror = () => events.close();
    return () => {
      closed = true;
      events.close();
    };
  }, [enabled, reload]);

  return { agents, runtime };
}
