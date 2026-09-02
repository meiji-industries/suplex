import { CheckIcon, CircleIcon, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils.js";
import { ProfileAvatar } from "./profile-avatar.js";
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../ui/timeline.js";
import { taskIsProcessing } from "./task-status.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";
import type { IssuePhase } from "../../../issue-phases.js";

const stages = [
  { step: 1, title: "Plan" },
  { step: 2, title: "Build" },
  { step: 3, title: "Review" },
  { step: 4, title: "Ship" },
  { step: 5, title: "Done" },
] as const;

type ProgressEvent = Pick<TaskResponse["timeline"][number], "metadata" | "createdAt">;
type AgentInvocation = TaskResponse["agentInvocations"][number];
type ActiveCapacity = NonNullable<TaskResponse["capacity"]>;
type DeveloperLiveness = { status: string; lastHeartbeatAt: string | null };

function isIssuePhase(phase: string): phase is IssuePhase {
  return ["backlog", "planning", "approval", "building", "reviewing", "shipping", "done", "cancelled"].includes(phase);
}

function taskProgressStep(phase: IssuePhase): number {
  if (["backlog", "planning", "approval"].includes(phase)) return 1;
  if (phase === "building") return 2;
  if (phase === "reviewing") return 3;
  if (phase === "shipping") return 4;
  return 5;
}

function elapsedLabel(prefix: "Done in" | "In progress ·", startedAt: string, finishedAt: string): string {
  const elapsedMinutes = Math.max(1, Math.ceil((Date.parse(finishedAt) - Date.parse(startedAt)) / 60_000));
  return `${prefix} ${elapsedMinutes} ${elapsedMinutes === 1 ? "min" : "mins"}`;
}

function stageStart(timeline: ProgressEvent[], minimumStep: number): string | undefined {
  return timeline.find((event) => typeof event.metadata.phase === "string" && isIssuePhase(event.metadata.phase) && taskProgressStep(event.metadata.phase) >= minimumStep)?.createdAt;
}

function activeDuration(startedAt: string, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  return `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
}

function activeAgent(phase: IssuePhase, invocations: AgentInvocation[]): AgentInvocation | undefined {
  const role = phase === "planning" ? "planner" : phase === "building" ? "builder" : "reviewer";
  return [...invocations].reverse().find((invocation) => invocation.role === role && ["starting", "running", "cancelling"].includes(invocation.status));
}

export function TaskProgress({ phase, blocked = false, createdAt, updatedAt, timeline, agentInvocations, activeCapacity, developerLiveness }: { phase: IssuePhase; blocked?: boolean; createdAt: string; updatedAt: string; timeline: ProgressEvent[]; agentInvocations: AgentInvocation[]; activeCapacity?: ActiveCapacity | undefined; developerLiveness?: DeveloperLiveness | undefined }) {
  const currentStep = taskProgressStep(phase);
  const terminal = phase === "done" || phase === "cancelled";
  const stageStarts: Array<string | undefined> = [createdAt, stageStart(timeline, 2), stageStart(timeline, 3), stageStart(timeline, 4), stageStart(timeline, 5)];
  const [now, setNow] = useState(() => Date.now());
  const buildLive = phase === "building" && Boolean(developerLiveness?.lastHeartbeatAt) && ["starting", "running", "active", "reconnecting", "cancellation_requested", "cancelling"].includes(developerLiveness?.status ?? "") && now - Date.parse(developerLiveness!.lastHeartbeatAt!) <= 15_000;
  const processing = taskIsProcessing({ phase, blocked, agentInvocations, capacityStatus: activeCapacity?.status });
  const spinning = phase === "building" ? buildLive : processing;
  const ticking = !terminal && !blocked;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const agent = activeAgent(phase, agentInvocations) ?? activeCapacity;

  return (
    <section aria-label="Task progress" data-task-progress>
      <Timeline value={currentStep} orientation="vertical">
        {stages.map((stage) => {
          const status = stage.step < currentStep || (terminal && stage.step === currentStep) ? "completed" : stage.step === currentStep ? "current" : "upcoming";
          const startedAt = stageStarts[stage.step - 1] ?? updatedAt;
          const nextStartedAt = stageStarts[stage.step];
          const duration = status === "completed"
            ? elapsedLabel("Done in", startedAt, nextStartedAt ?? updatedAt)
            : status === "current"
              ? activeDuration(startedAt, ticking ? now : Date.parse(updatedAt))
              : "Not started";
          return (
            <TimelineItem className="gap-1" key={stage.step} step={stage.step} aria-current={status === "current" ? "step" : undefined}>
              <TimelineHeader className="flex items-center gap-2">
                <TimelineSeparator />
                <TimelineTitle>{stage.title}</TimelineTitle>
                <TimelineIndicator className={cn(
                  "flex size-6 items-center justify-center border-none",
                  status === "completed" && "bg-emerald-500 text-white",
                  status === "current" && "bg-primary text-primary-foreground",
                  status === "upcoming" && "bg-muted text-muted-foreground",
                )}>
                  {status === "completed" ? <CheckIcon className="size-3.5" /> : status === "current" && spinning ? <LoaderCircle className="size-3 animate-spin" /> : <CircleIcon className="size-3" />}
                </TimelineIndicator>
              </TimelineHeader>
              <TimelineContent className="text-xs">
                {status === "current" ? <div className="flex items-center gap-1">{agent?.agentName ? <ProfileAvatar name={agent.agentName} seed={agent.avatarSeed ?? agent.agentName} size="xs" /> : null}<span>{agent?.agentName ?? "In progress"}</span><span>·</span><span className="tabular-nums">{duration}</span></div> : <div className="tabular-nums">{duration}</div>}
              </TimelineContent>
            </TimelineItem>
          );
        })}
      </Timeline>
    </section>
  );
}
