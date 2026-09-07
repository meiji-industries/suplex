import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { RestartUpdateBodySchema, UPDATE_OPERATION_TIMEOUT_MS, UpdateRestartResponseSchema, UpdateResponseSchema, type UpdateOperationStatus, type UpdateResponse } from "../../../http/contracts/update.js";
import { ApiError, readJson } from "../../lib/api.js";
import { Button } from "../ui/button.js";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { useOptionalCompanyContext } from "./company-context.js";

const UPDATE_POLL_INTERVAL_MS = 60_000;
const RESTART_POLL_INTERVAL_MS = 1_000;
const RESTART_TIMEOUT_MS = UPDATE_OPERATION_TIMEOUT_MS;

type RestartAttempt = {
  operationId: string;
  targetRevision: string;
  previousInstanceId?: string;
};

function operationIsPending(status: UpdateOperationStatus["status"]): boolean {
  return status === "pending" || status === "preparing" || status === "restarting";
}

function operationMessage(operation: UpdateOperationStatus | undefined): string | undefined {
  if (!operation) return undefined;
  if (operation.status === "preparing") return "Forge prepares the update.";
  if (operation.status === "restarting") return "Forge restarts.";
  if (operation.status === "pending") return "Forge starts the update.";
  return operation.message;
}

export function UpdateNotice(): ReactElement | null {
  const context = useOptionalCompanyContext();
  const [update, setUpdate] = useState<UpdateResponse | undefined>();
  const [closedRevision, setClosedRevision] = useState<string | undefined>();
  const [restartAttempt, setRestartAttempt] = useState<RestartAttempt | undefined>();
  const [requesting, setRequesting] = useState(false);
  const [restartError, setRestartError] = useState<string | undefined>();
  const attemptRef = useRef<RestartAttempt | undefined>(undefined);
  const terminalAttemptRef = useRef<string | undefined>(undefined);
  const reloadStarted = useRef(false);

  useEffect(() => {
    let closed = false;
    const readUpdate = async (): Promise<void> => {
      try {
        const next = UpdateResponseSchema.parse(await readJson<UpdateResponse>("/api/update"));
        if (!closed) setUpdate(next);
      } catch {
        // Keep the last observation visible while a replacement server is starting.
      }
    };
    void readUpdate();
    const timer = setInterval(() => void readUpdate(), UPDATE_POLL_INTERVAL_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const operation = update?.operation;
    if (!operation || !operationIsPending(operation.status) || attemptRef.current || terminalAttemptRef.current === operation.operationId) return;
    const attempt: RestartAttempt = {
      operationId: operation.operationId,
      targetRevision: operation.targetRevision,
      ...(update.instanceId ? { previousInstanceId: update.instanceId } : {}),
    };
    attemptRef.current = attempt;
    setRestartAttempt(attempt);
  }, [update]);

  useEffect(() => {
    const attempt = restartAttempt;
    if (!attempt || !attempt.operationId) return;
    let cancelled = false;
    const fail = (message: string): void => {
      if (cancelled) return;
      terminalAttemptRef.current = attempt.operationId;
      attemptRef.current = undefined;
      setRestartAttempt(undefined);
      setRequesting(false);
      setRestartError(message);
    };
    const poll = async (): Promise<void> => {
      const deadline = Date.now() + RESTART_TIMEOUT_MS;
      while (!cancelled && Date.now() < deadline) {
        try {
          const next = UpdateResponseSchema.parse(await readJson<UpdateResponse>("/api/update", { signal: AbortSignal.timeout(2_000) }));
          if (cancelled) return;
          setUpdate(next);
          const operation = next.operation;
          if (operation?.operationId === attempt.operationId && operation.status === "failed") {
            fail(operation.error ?? operation.message ?? "Forge could not restart.");
            return;
          }
          const replacementProven = Boolean(
            attempt.previousInstanceId
            && next.instanceId
            && next.instanceId !== attempt.previousInstanceId
            && next.currentRevision === attempt.targetRevision,
          );
          if (replacementProven) {
            if (!reloadStarted.current) {
              reloadStarted.current = true;
              window.location.reload();
            }
            return;
          }
        } catch {
          // The old server can be down while the replacement starts.
        }
        if (!cancelled) await new Promise<void>((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
      }
      fail("Forge did not prove the replacement server within the time limit. Retry the restart.");
    };
    void poll();
    return () => { cancelled = true; };
  }, [restartAttempt]);

  if (!update) return null;
  const revision = update.revision ?? update.operation?.targetRevision ?? "available";
  const operationPending = requesting || Boolean(restartAttempt);
  const operationFailed = update.operation?.status === "failed";
  if (!update.available && !operationPending && !operationFailed && !restartError) return null;
  if (closedRevision === revision && !operationPending && !restartError) return null;
  const canRestart = update.canRestart ?? context?.user?.role === "admin";
  const statusMessage = operationMessage(update.operation);
  const visibleError = restartError ?? (operationFailed ? update.operation?.error ?? update.operation?.message : undefined);

  const restart = async (): Promise<void> => {
    if (!canRestart || !update.revision || attemptRef.current || requesting) return;
    const targetRevision = update.revision;
    terminalAttemptRef.current = undefined;
    attemptRef.current = { operationId: "requesting", targetRevision, ...(update.instanceId ? { previousInstanceId: update.instanceId } : {}) };
    setRequesting(true);
    setRestartError(undefined);
    try {
      const body = RestartUpdateBodySchema.parse({ revision: targetRevision });
      const accepted = UpdateRestartResponseSchema.parse(await readJson("/api/update/restart", { method: "POST", body: JSON.stringify(body) }));
      const attempt: RestartAttempt = {
        operationId: accepted.operation.operationId,
        targetRevision: accepted.operation.targetRevision,
        ...(update.instanceId ? { previousInstanceId: update.instanceId } : {}),
      };
      attemptRef.current = attempt;
      setRequesting(false);
      setRestartAttempt(attempt);
      setUpdate((current) => current ? { ...current, available: true, revision: targetRevision, operation: accepted.operation } : current);
    } catch (error: unknown) {
      attemptRef.current = undefined;
      setRequesting(false);
      setRestartError(error instanceof ApiError ? error.message : "Forge could not accept the restart request.");
    }
  };

  return (
    <div data-update-notice data-update-revision={update.revision} role="status" aria-live="polite" className="border-b px-4 py-2 lg:px-6">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Update available</CardTitle>
          <CardDescription>{visibleError ? `Restart failed. ${visibleError}` : statusMessage ?? "Update and restart Forge."}</CardDescription>
          <CardAction>
            <div className="flex items-center gap-2">
              {canRestart ? <Button type="button" size="sm" onClick={() => void restart()} disabled={operationPending || !update.revision}>{"Restart Now"}</Button> : null}
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Close update notice" title="Close update notice" onClick={() => setClosedRevision(revision)} disabled={operationPending}>
                <X aria-hidden="true" />
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        {operationPending ? <CardContent><p data-update-status aria-live="polite">{statusMessage ?? "Forge starts the update."}</p></CardContent> : null}
      </Card>
    </div>
  );
}
