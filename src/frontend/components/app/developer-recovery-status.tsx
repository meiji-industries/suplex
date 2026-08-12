import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Badge } from "../ui/badge.js";
import type { ReactElement } from "react";

import { DeveloperRecoveryActions, type DeveloperRecoveryAction } from "./developer-recovery-actions.js";

export type DeveloperRecoveryView = {
  status: "starting" | "active" | "reconnecting" | "result_pending_claim" | "interrupted" | "ownership_ambiguous" | "cancellation_requested" | "cancelling" | "cancelled" | "failed";
  reasonCode: string | null;
  summary: string | null;
  lastHeartbeatAt: string | null;
  currentOwner: "forge" | "operator";
  evidenceArtifactId: string | null;
  nextAction: { command: "retry_development" | "cancel_development" | "verify_developer_ownership" | "cancel_issue"; label: string; requiresConfirmation: boolean } | null;
};

const labels: Record<DeveloperRecoveryView["status"], string> = {
  starting: "Starting",
  active: "Active",
  reconnecting: "Reconnecting",
  result_pending_claim: "Result ready",
  interrupted: "Interrupted",
  ownership_ambiguous: "Ownership ambiguous",
  cancellation_requested: "Cancellation requested",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function DeveloperRecoveryStatus({ taskId, recovery, allowedCommands, busy, isAdmin, onAction }: { taskId: string; recovery: DeveloperRecoveryView | undefined; allowedCommands: string[]; busy: boolean; isAdmin: boolean; onAction: (action: DeveloperRecoveryAction) => Promise<void> }): ReactElement | null {
  if (!recovery) return null;
  const ambiguous = recovery.status === "ownership_ambiguous";
  const interrupted = recovery.status === "interrupted";
  const failed = recovery.status === "failed";
  const attention = ambiguous || interrupted || failed;
  return <>
    <Alert variant={attention ? "destructive" : "default"}>
      <AlertTitle>Developer recovery <Badge variant={attention ? "destructive" : "secondary"}>{labels[recovery.status]}</Badge></AlertTitle>
      <AlertDescription>
        <p>{ambiguous ? "Forge cannot prove ownership of the previous Developer process. Inspect the host process and worktree, stop it outside Forge if necessary, then recheck ownership." : recovery.summary ?? "Forge is tracking the Developer turn."}</p>
        {recovery.lastHeartbeatAt ? <p className="mt-1 text-xs">Last heartbeat {new Date(recovery.lastHeartbeatAt).toLocaleString()}</p> : null}
        {recovery.evidenceArtifactId ? <p className="mt-1 text-xs"><a href={`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(recovery.evidenceArtifactId)}`} target="_blank" rel="noreferrer">Open retained evidence</a></p> : null}
        <DeveloperRecoveryActions allowedCommands={ambiguous ? allowedCommands.filter((command) => command === "verify_developer_ownership") : allowedCommands} busy={busy} isAdmin={isAdmin} onAction={onAction} />
      </AlertDescription>
    </Alert>
  </>;
}
