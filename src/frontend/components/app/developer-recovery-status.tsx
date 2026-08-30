import { Badge } from "../ui/badge.js";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card.js";
import { Collapsible } from "../ui/collapsible.js";
import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { DeveloperRecoveryActions, type DeveloperRecoveryAction } from "./developer-recovery-actions.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";
import type { AttentionCard } from "../../../recovery/convergence.js";

export type DeveloperRecoveryView = NonNullable<TaskResponse["developerRecovery"]>;

const labels: Record<DeveloperRecoveryView["status"], string> = {
  starting: "In Progress",
  active: "Active",
  reconnecting: "Reconnecting",
  result_pending_claim: "Finishing",
  interrupted: "Interrupted",
  cancellation_requested: "Cancellation requested",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function DeveloperRecoveryStatus({ recovery, executionStatus, allowedCommands, busy, isAdmin, onAction, attentionCard, developmentStatus, children }: { recovery: DeveloperRecoveryView | undefined; executionStatus?: string | undefined; allowedCommands: string[]; busy: boolean; isAdmin: boolean; onAction: (action: DeveloperRecoveryAction, note?: string) => Promise<void>; attentionCard?: AttentionCard; developmentStatus?: ReactNode; children?: ReactNode }): ReactElement | null {
  if (!recovery) return null;
  const interrupted = recovery.status === "interrupted";
  const failed = recovery.status === "failed";
  const blocked = executionStatus === "blocked";
  const attention = interrupted || (failed && !blocked);
  const description = attention ? recovery.summary : null;
  const recoveryCommands = allowedCommands;
  const hasActions = recoveryCommands.includes("retry_development") || recoveryCommands.includes("cancel_development");
  const idle = recovery.status === "starting" || recovery.status === "active" || recovery.status === "reconnecting" || recovery.status === "result_pending_claim";
  if (!hasActions && idle) return null;
  return <Card data-developer-recovery role="alert" size="sm">
      <Collapsible.Root defaultOpen className="flex flex-col gap-(--card-spacing)">
        <Collapsible.Trigger nativeButton={false} render={<CardHeader className="group/developer-recovery-trigger cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />}>
          <CardTitle className="flex flex-wrap items-center gap-2">Development <Badge variant={attention ? "destructive" : "secondary"}>{blocked ? "Needs a decision" : labels[recovery.status]}</Badge>{developmentStatus}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
          <CardAction><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/developer-recovery-trigger:rotate-90" /></CardAction>
        </Collapsible.Trigger>
        <Collapsible.Panel className="flex flex-col gap-(--card-spacing)">
          <CardContent>
            {children}
            {recovery.lastHeartbeatAt ? <p className="mt-1 text-xs">Last heartbeat {new Date(recovery.lastHeartbeatAt).toLocaleString()}</p> : null}
          </CardContent>
          {hasActions ? <CardFooter className="justify-start border-t text-left"><DeveloperRecoveryActions allowedCommands={recoveryCommands} busy={busy} isAdmin={isAdmin} onAction={onAction} {...(attentionCard ? { card: attentionCard } : {})} /></CardFooter> : null}
        </Collapsible.Panel>
      </Collapsible.Root>
    </Card>;
}
