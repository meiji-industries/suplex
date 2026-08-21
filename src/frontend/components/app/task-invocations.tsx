import { CheckIcon, Clock3, XIcon } from "lucide-react";

import { cn } from "../../lib/utils.js";
import { Badge } from "../reui/badge.js";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../ui/timeline.js";
import { ProfileAvatar } from "./profile-avatar.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";

export type TaskInvocation = TaskResponse["agentInvocations"][number];

export function roleLabel(role: TaskInvocation["role"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function invocationActorLabel(invocation: Pick<TaskInvocation, "agentName" | "profileName" | "role">): string {
  return `${roleLabel(invocation.role)}${invocation.profileName ? ` (${invocation.profileName})` : ""}`;
}

function invocationDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function invocationDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const durationSeconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000));
  if (durationSeconds < 1) return "<1s";
  if (durationSeconds < 60) return `${durationSeconds}s`;
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function invocationSummary(invocation: TaskInvocation): string {
  if (invocation.failureSummary) return invocation.failureSummary;
  if (invocation.status === "completed") return "Invocation completed";
  return "Invocation in progress";
}

function statusBadgeVariant(status: string): "success-light" | "destructive-light" | "warning-light" {
  if (status === "failed") return "destructive-light";
  if (status === "completed") return "success-light";
  return "warning-light";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "failed") return <XIcon className="size-3.5" />;
  if (status === "completed") return <CheckIcon className="size-3.5" />;
  return <Clock3 className="size-3.5" />;
}

export function TaskInvocations({ invocations }: { invocations: TaskInvocation[] }) {
  return (
    <div data-task-invocations>
      <Timeline defaultValue={invocations.length}>
        {invocations.map((invocation, index) => {
          const duration = invocationDuration(invocation.startedAt, invocation.finishedAt);
          return (
            <TimelineItem key={invocation.id} step={index + 1} className="group-data-[orientation=vertical]/timeline:ms-10">
              <TimelineHeader>
                <TimelineSeparator className="bg-input! group-data-[orientation=vertical]/timeline:-left-7 group-data-[orientation=vertical]/timeline:h-[calc(100%-1.5rem-0.25rem)] group-data-[orientation=vertical]/timeline:translate-y-6.5" />
                <div className="flex items-center gap-2">
                  {invocation.agentName && invocation.avatarSeed ? <ProfileAvatar name={invocation.agentName} seed={invocation.avatarSeed} /> : null}
                  <TimelineTitle className="text-sm">{invocationActorLabel(invocation)} · attempt {invocation.attempt}</TimelineTitle>
                  <Badge variant={statusBadgeVariant(invocation.status)} size="sm">{invocation.status}</Badge>
                </div>
                <TimelineIndicator className={cn(
                  "flex size-6 items-center justify-center border-none group-data-[orientation=vertical]/timeline:-left-7",
                  invocation.status === "completed" ? "bg-emerald-500 text-white" : invocation.status === "failed" ? "bg-destructive text-white" : "bg-warning text-white"
                )}><StatusIcon status={invocation.status} /></TimelineIndicator>
              </TimelineHeader>
              <TimelineContent>
                <p className="whitespace-pre-wrap text-[13px] text-foreground">{invocationSummary(invocation)}</p>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {invocation.failureCode ? <code>{invocation.failureCode}</code> : null}
                  {invocation.evidenceArtifactId ? <code className="break-all">{invocation.evidenceArtifactId}</code> : null}
                  {invocation.sessionRef ? <code className="break-all">{invocation.sessionRef}</code> : null}
                  {duration ? <span>{duration}</span> : null}
                </div>
                <TimelineDate className="mt-1 mb-0" dateTime={invocation.startedAt}>{invocationDate(invocation.startedAt)}</TimelineDate>
              </TimelineContent>
            </TimelineItem>
          );
        })}
      </Timeline>
    </div>
  );
}
