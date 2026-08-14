import { Badge } from "../ui/badge.js";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card.js";
import type { ReactElement, ReactNode } from "react";

import { DeveloperRecoveryActions, type DeveloperRecoveryAction } from "./developer-recovery-actions.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";

export type DeveloperRecoveryView = NonNullable<TaskResponse["developerRecovery"]>;

const labels: Record<DeveloperRecoveryView["status"], string> = {
  starting: "In Progress",
  active: "Active",
  reconnecting: "Reconnecting",
  result_pending_claim: "Finishing",
  interrupted: "Interrupted",
  ownership_ambiguous: "Ownership ambiguous",
  cancellation_requested: "Cancellation requested",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function DeveloperRecoveryStatus({ taskId, recovery, allowedCommands, busy, isAdmin, onAction, developmentStatus, children }: { taskId: string; recovery: DeveloperRecoveryView | undefined; allowedCommands: string[]; busy: boolean; isAdmin: boolean; onAction: (action: DeveloperRecoveryAction) => Promise<void>; developmentStatus?: ReactNode; children?: ReactNode }): ReactElement | null {
  if (!recovery) return null;
  const ambiguous = recovery.status === "ownership_ambiguous";
  const interrupted = recovery.status === "interrupted";
  const failed = recovery.status === "failed";
  const attention = ambiguous || interrupted || failed;
  const recoveryCommands = ambiguous ? allowedCommands.filter((command) => command === "verify_developer_ownership") : allowedCommands;
  const hasActions = recoveryCommands.includes("retry_development") || recoveryCommands.includes("cancel_development") || (isAdmin && recoveryCommands.includes("verify_developer_ownership"));
  if (recovery.status === "active" && !hasActions) return null;
  const summary = ambiguous ? "Forge cannot prove ownership of the previous Implementer process. Inspect the host process and worktree, stop it outside Forge if necessary, then recheck ownership." : recovery.status === "starting" ? null : recovery.summary;
  return <Card data-developer-recovery role="alert" size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">Development <Badge variant={attention ? "destructive" : "secondary"}>{labels[recovery.status]}</Badge>{developmentStatus}</CardTitle>
        {summary ? <CardDescription>{summary}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {children}
        {recovery.lastHeartbeatAt ? <p className="mt-1 text-xs">Last heartbeat {new Date(recovery.lastHeartbeatAt).toLocaleString()}</p> : null}
        {recovery.evidenceArtifactId ? <p className="mt-1 text-xs"><a href={`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(recovery.evidenceArtifactId)}`} target="_blank" rel="noreferrer">Open retained evidence</a></p> : null}
      </CardContent>
      {hasActions ? <CardFooter className="border-t"><DeveloperRecoveryActions allowedCommands={recoveryCommands} busy={busy} isAdmin={isAdmin} onAction={onAction} /></CardFooter> : null}
    </Card>;
}
