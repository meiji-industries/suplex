import { Badge } from "../ui/badge.js";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card.js";
import { Collapsible } from "../ui/collapsible.js";
import { ChevronRight } from "lucide-react";
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
  ownership_ambiguous: "Interrupted",
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
  const description = attention ? recovery.summary : null;
  const recoveryCommands = allowedCommands;
  const hasActions = recoveryCommands.includes("retry_development") || recoveryCommands.includes("cancel_development");
  if (recovery.status === "active" && !hasActions) return null;
  return <Card data-developer-recovery role="alert" size="sm">
      <Collapsible.Root defaultOpen className="flex flex-col gap-(--card-spacing)">
        <Collapsible.Trigger nativeButton={false} render={<CardHeader className="group/developer-recovery-trigger cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />}>
          <CardTitle className="flex flex-wrap items-center gap-2">Development <Badge variant={attention ? "destructive" : "secondary"}>{labels[recovery.status]}</Badge>{developmentStatus}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
          <CardAction><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/developer-recovery-trigger:rotate-90" /></CardAction>
        </Collapsible.Trigger>
        <Collapsible.Panel className="flex flex-col gap-(--card-spacing)">
          <CardContent>
            {children}
            {recovery.lastHeartbeatAt ? <p className="mt-1 text-xs">Last heartbeat {new Date(recovery.lastHeartbeatAt).toLocaleString()}</p> : null}
            {recovery.evidenceArtifactId ? <p className="mt-1 text-xs"><a href={`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(recovery.evidenceArtifactId)}`} target="_blank" rel="noreferrer">Open retained evidence</a></p> : null}
          </CardContent>
          {hasActions ? <CardFooter className="justify-end border-t"><DeveloperRecoveryActions allowedCommands={recoveryCommands} busy={busy} isAdmin={isAdmin} onAction={onAction} /></CardFooter> : null}
        </Collapsible.Panel>
      </Collapsible.Root>
    </Card>;
}
