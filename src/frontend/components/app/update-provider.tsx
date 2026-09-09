import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import { RestartUpdateBodySchema, UPDATE_OPERATION_TIMEOUT_MS, UpdateRestartResponseSchema, UpdateResponseSchema, type UpdateResponse } from "../../../http/contracts/update.js";
import { readJson } from "../../lib/api.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import {
  dismissUpdateFailure,
  dismissUpdateRevision,
  readStoredUpdateNoticeMemory,
  reconcileOwnedAttempt,
  replacementIsProven,
  selectUpdateNotice,
  writeStoredUpdateNoticeMemory,
  type LocalUpdateFailure,
  type UpdateNoticeMemory,
  type UpdateNoticeState,
} from "./update-notice-state.js";

const UPDATE_POLL_INTERVAL_MS = 60_000;
const RESTART_POLL_INTERVAL_MS = 1_000;
const UPDATE_READ_TIMEOUT_MS = 35_000;
const RESTART_READ_TIMEOUT_MS = 2_000;

type UpdateContextValue = {
  update?: UpdateResponse;
  notice?: UpdateNoticeState;
  requesting: boolean;
  refresh: () => Promise<void>;
  restart: (revision?: string) => Promise<void>;
  dismissNotice: () => void;
};

const UpdateContext = createContext<UpdateContextValue | undefined>(undefined);

function operationIsPending(update: UpdateResponse | undefined): boolean {
  const status = update?.operation?.status;
  return status === "pending" || status === "preparing" || status === "restarting";
}

export function UpdateProvider({ children }: { children: ReactNode }): ReactElement {
  const userId = useOptionalCompanyContext()?.user?.id;
  const [update, setUpdate] = useState<UpdateResponse>();
  const [requesting, setRequesting] = useState(false);
  const [localFailure, setLocalFailure] = useState<LocalUpdateFailure>();
  const [stored, setStored] = useState<{ userId?: string; memory: UpdateNoticeMemory }>({ memory: {} });
  const activeUserId = useRef(userId);
  const refreshInFlight = useRef<{ userId: string; promise: Promise<void> } | undefined>(undefined);
  activeUserId.current = userId;
  const memory = stored.userId === userId ? stored.memory : {};

  const replaceMemory = useCallback((replace: (current: UpdateNoticeMemory) => UpdateNoticeMemory): void => {
    if (!userId) return;
    setStored((current) => {
      const currentMemory = current.userId === userId ? current.memory : readStoredUpdateNoticeMemory(window, userId);
      const next = replace(currentMemory);
      writeStoredUpdateNoticeMemory(window, userId, next);
      return { userId, memory: next };
    });
  }, [userId]);

  const refresh = useCallback((timeoutMs = UPDATE_READ_TIMEOUT_MS): Promise<void> => {
    if (!userId) return Promise.resolve();
    const existing = refreshInFlight.current;
    if (existing?.userId === userId) return existing.promise;
    const promise = readJson<UpdateResponse>("/api/update", { signal: AbortSignal.timeout(timeoutMs) })
      .then((body) => {
        const next = UpdateResponseSchema.parse(body);
        if (activeUserId.current === userId) setUpdate(next);
      })
      .catch(() => {
        // Keep the last observation while a replacement server starts.
      });
    refreshInFlight.current = { userId, promise };
    void promise.then(() => {
      if (refreshInFlight.current?.promise === promise) refreshInFlight.current = undefined;
    });
    return promise;
  }, [userId]);

  useEffect(() => {
    setUpdate(undefined);
    setRequesting(false);
    setLocalFailure(undefined);
    setStored(userId ? { userId, memory: readStoredUpdateNoticeMemory(window, userId) } : { memory: {} });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), UPDATE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, userId]);

  useEffect(() => {
    if (!operationIsPending(update)) return;
    const timer = window.setInterval(() => void refresh(RESTART_READ_TIMEOUT_MS), RESTART_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, update?.operation?.operationId, update?.operation?.status]);

  useEffect(() => {
    const storedAttempt = memory.ownedAttempt;
    if (!storedAttempt || !update) return;
    const attempt = reconcileOwnedAttempt(update, storedAttempt);
    if (attempt !== storedAttempt) {
      replaceMemory((current) => ({ ...current, ownedAttempt: attempt }));
    }
    if (replacementIsProven(update, attempt)) {
      replaceMemory((current) => ({ ...current, ownedAttempt: undefined }));
      window.location.reload();
      return;
    }

    if (update.currentRevision === attempt.targetRevision) {
      replaceMemory((current) => ({ ...current, ownedAttempt: undefined }));
      setLocalFailure(undefined);
      return;
    }
    const operation = update.operation;
    if (!operation || attempt.operationId !== operation.operationId) return;
    if (operation.status === "succeeded") {
      replaceMemory((current) => ({ ...current, ownedAttempt: undefined }));
      setLocalFailure(undefined);
      return;
    }
    if (operation.status === "failed") {
      setLocalFailure(undefined);
      return;
    }
    const remaining = Date.parse(operation.acceptedAt) + UPDATE_OPERATION_TIMEOUT_MS - Date.now();
    const timer = window.setTimeout(() => {
      setLocalFailure({ failureId: operation.operationId, targetRevision: operation.targetRevision, message: "Forge could not confirm the restart." });
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [memory.ownedAttempt, replaceMemory, update]);

  const restart = useCallback(async (revision?: string): Promise<void> => {
    const targetRevision = revision ?? update?.revision;
    if (!targetRevision || requesting || operationIsPending(update)) return;
    const requestFailureId = `request-${crypto.randomUUID()}`;
    setRequesting(true);
    setLocalFailure(undefined);
    try {
      const body = RestartUpdateBodySchema.parse({ revision: targetRevision });
      const accepted = UpdateRestartResponseSchema.parse(await readJson("/api/update/restart", { method: "POST", body: JSON.stringify(body) }));
      replaceMemory((current) => ({
        ...current,
        dismissedFailureId: undefined,
        ownedAttempt: {
          operationId: accepted.operation.operationId,
          targetRevision: accepted.operation.targetRevision,
          ...(update?.instanceId ? { previousInstanceId: update.instanceId } : {}),
        },
      }));
      setUpdate((current) => current ? {
        ...current,
        available: true,
        revision: accepted.operation.targetRevision,
        operation: accepted.operation,
      } : current);
    } catch {
      setLocalFailure({
        failureId: requestFailureId,
        targetRevision,
        message: "Forge could not accept the restart request.",
      });
    } finally {
      setRequesting(false);
    }
  }, [replaceMemory, requesting, update]);

  const notice = update ? selectUpdateNotice(update, memory, localFailure) : undefined;
  const dismissNotice = useCallback((): void => {
    if (!notice) return;
    if (notice.kind === "available") {
      replaceMemory((current) => dismissUpdateRevision(current, notice.revision));
      return;
    }
    if (notice.kind === "failure") {
      replaceMemory((current) => {
        const dismissed = dismissUpdateFailure(current, notice.failureId);
        const failedOperationDismissed = update?.operation?.status === "failed" && update.operation.operationId === notice.failureId;
        return failedOperationDismissed ? { ...dismissed, ownedAttempt: undefined } : dismissed;
      });
      setLocalFailure(undefined);
    }
  }, [notice, replaceMemory, update?.operation]);

  const value = useMemo<UpdateContextValue>(() => ({
    ...(update ? { update } : {}),
    ...(notice ? { notice } : {}),
    requesting,
    refresh,
    restart,
    dismissNotice,
  }), [dismissNotice, notice, refresh, requesting, restart, update]);

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
