import { useCallback, useEffect, useState } from "react";

import { ApiError, readJson } from "../../lib/api.js";
import type { ApiAgent } from "../../lib/view-shared.js";

export function shouldMonitorAgentStatus({ authenticated, loading, authBlocked }: { authenticated: boolean; loading: boolean; authBlocked: boolean }): boolean {
  return authenticated && !loading && !authBlocked;
}

export function reduceAgentAuthBlock(authBlocked: boolean, event: "unauthorized" | "authenticated"): boolean {
  return event === "authenticated" ? false : authBlocked || event === "unauthorized";
}

export function useAgentStatus({ companyId, authenticated, loading, onAuthenticationRequired }: { companyId?: string; authenticated: boolean; loading: boolean; onAuthenticationRequired: () => void }): ApiAgent[] {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [authBlocked, setAuthBlocked] = useState(false);
  const enabled = shouldMonitorAgentStatus({ authenticated, loading, authBlocked });

  useEffect(() => {
    if (authenticated) setAuthBlocked((blocked) => reduceAgentAuthBlock(blocked, "authenticated"));
  }, [authenticated]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setAgents((await readJson<{ agents: ApiAgent[] }>(companyId ? `/api/agents?companyId=${encodeURIComponent(companyId)}` : "/api/agents")).agents);
    } catch (error) {
      setAgents([]);
      if (error instanceof ApiError && error.statusCode === 401) {
        setAuthBlocked((blocked) => reduceAgentAuthBlock(blocked, "unauthorized"));
        onAuthenticationRequired();
      }
    }
  }, [companyId, onAuthenticationRequired]);

  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      return;
    }
    let closed = false;
    const refresh = (): void => { if (!closed) void reload(); };
    refresh();
    // Task invalidations include changes to the active executions that feed the
    // sidebar count, so this avoids an independent timer for agent status.
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

  return agents;
}
