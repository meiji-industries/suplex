import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import { UpdateRestartResponseSchema, UpdateResponseSchema, type UpdateResponse } from "../../../http/contracts/update.js";
import { readJson } from "../../lib/api.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { observeRestart, selectUpdateNotice, type RestartAttempt, type UpdateNoticeState } from "./update-notice-state.js";

const UPDATE_POLL_INTERVAL_MS = 60_000;
const RESTART_POLL_INTERVAL_MS = 1_000;

type UpdateContextValue = {
  update?: UpdateResponse;
  notice?: UpdateNoticeState;
  requesting: boolean;
  refresh: (check?: boolean) => Promise<void>;
  restart: () => Promise<void>;
};

const UpdateContext = createContext<UpdateContextValue | undefined>(undefined);

export function UpdateProvider({ children }: { children: ReactNode }): ReactElement {
  const userId = useOptionalCompanyContext()?.user?.id;
  const [update, setUpdate] = useState<UpdateResponse>();
  const [requesting, setRequesting] = useState(false);
  const activeUserId = useRef(userId);
  const restartAttempt = useRef<RestartAttempt | undefined>(undefined);
  const refreshInFlight = useRef<{ userId: string; promise: Promise<void> } | undefined>(undefined);
  activeUserId.current = userId;

  const refresh = useCallback((check = false): Promise<void> => {
    if (!userId) return Promise.resolve();
    if (refreshInFlight.current?.userId === userId) return refreshInFlight.current.promise;
    const request = readJson<UpdateResponse>(`/api/update${check ? "?check=1" : ""}`, { signal: AbortSignal.timeout(check ? 35_000 : 2_000) })
      .then((body) => {
        const next = UpdateResponseSchema.parse(body);
        if (activeUserId.current !== userId) return;
        const attempt = restartAttempt.current?.userId === userId ? restartAttempt.current : undefined;
        const restartObservation = attempt ? observeRestart(attempt, next) : undefined;
        if (restartObservation === "reload") {
          restartAttempt.current = undefined;
          window.location.reload();
          return;
        }
        if (restartObservation === "settled") restartAttempt.current = undefined;
        setUpdate(next);
      })
      .catch(() => undefined)
      .finally(() => { if (refreshInFlight.current?.promise === request) refreshInFlight.current = undefined; });
    refreshInFlight.current = { userId, promise: request };
    return request;
  }, [userId]);

  useEffect(() => {
    setUpdate(undefined);
    setRequesting(false);
    restartAttempt.current = undefined;
    if (!userId) return;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(true), UPDATE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, userId]);

  useEffect(() => {
    if (!restartAttempt.current && update?.status.kind !== "applying") return;
    const timer = window.setInterval(() => void refresh(false), RESTART_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, update?.status.kind]);

  const restart = useCallback(async (): Promise<void> => {
    if (!update?.canRestart || requesting || update.status.kind === "applying") return;
    if (!userId) return;
    setRequesting(true);
    const attempt = { userId, ...(update.instanceId ? { instanceId: update.instanceId } : {}) };
    restartAttempt.current = attempt;
    try {
      const accepted = UpdateRestartResponseSchema.parse(await readJson("/api/update/restart", { method: "POST", signal: AbortSignal.timeout(5_000) }));
      if (activeUserId.current !== userId || restartAttempt.current !== attempt) return;
      setUpdate((current) => current ? { ...current, status: accepted.status } : current);
    } catch {
      if (activeUserId.current !== userId || restartAttempt.current !== attempt) return;
      setUpdate((current) => current ? { ...current, status: { kind: "applying", step: "start", message: "Forge reconnects to the host." } } : current);
    } finally {
      if (activeUserId.current === userId) setRequesting(false);
    }
  }, [requesting, update, userId]);

  const notice = update ? selectUpdateNotice(update) : undefined;
  const value = useMemo<UpdateContextValue>(() => ({ ...(update ? { update } : {}), ...(notice ? { notice } : {}), requesting, refresh, restart }), [notice, refresh, requesting, restart, update]);
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error("UpdateProvider is missing");
  return value;
}

export function useOptionalUpdate(): UpdateContextValue | undefined {
  return useContext(UpdateContext);
}
