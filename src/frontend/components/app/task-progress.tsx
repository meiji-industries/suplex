import { CheckIcon, CircleIcon, PlayIcon } from "lucide-react";

import { cn } from "../../lib/utils.js";
import { Badge } from "../reui/badge.js";
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../ui/timeline.js";

const stages = [
  { step: 1, title: "Plan" },
  { step: 2, title: "Build" },
  { step: 3, title: "Release" },
] as const;

type ProgressEvent = { metadata: Record<string, string | number | boolean>; createdAt: string };

function taskProgressStep(phase: string, canRetryDevelopment: boolean): number {
  if (["backlog", "planning", "approval", "failed"].includes(phase)) return 1;
  if (["ready_for_development", "development", "repair_required"].includes(phase)) return 2;
  if (phase === "delivery_blocked" && canRetryDevelopment) return 2;
  return 3;
}

function elapsedLabel(prefix: "Done in" | "In progress ·", startedAt: string, finishedAt: string): string {
  const elapsedMinutes = Math.max(1, Math.ceil((Date.parse(finishedAt) - Date.parse(startedAt)) / 60_000));
  return `${prefix} ${elapsedMinutes} ${elapsedMinutes === 1 ? "min" : "mins"}`;
}

function stageStart(timeline: ProgressEvent[], minimumStep: number): string | undefined {
  return timeline.find((event) => typeof event.metadata.phase === "string" && taskProgressStep(event.metadata.phase, false) >= minimumStep)?.createdAt;
}

export function TaskProgress({ phase, allowedCommands, createdAt, updatedAt, timeline }: { phase: string; allowedCommands: string[]; createdAt: string; updatedAt: string; timeline: ProgressEvent[] }) {
  const currentStep = taskProgressStep(phase, allowedCommands.includes("retry_development"));
  const terminal = ["accepted", "manual_merge", "done", "cancelled"].includes(phase);
  const stageStarts: Array<string | undefined> = [createdAt, stageStart(timeline, 2), stageStart(timeline, 3)];

  return (
    <section aria-label="Task progress" data-task-progress>
      <Timeline value={currentStep} orientation="horizontal">
        {stages.map((stage) => {
          const status = stage.step < currentStep || (terminal && stage.step === currentStep) ? "completed" : stage.step === currentStep ? "current" : "upcoming";
          const startedAt = stageStarts[stage.step - 1] ?? updatedAt;
          const nextStartedAt = stageStarts[stage.step];
          const duration = status === "completed"
            ? elapsedLabel("Done in", startedAt, nextStartedAt ?? updatedAt)
            : status === "current"
              ? elapsedLabel("In progress ·", startedAt, new Date().toISOString())
              : "Not started";
          return (
            <TimelineItem key={stage.step} step={stage.step} aria-current={status === "current" ? "step" : undefined}>
              <TimelineHeader>
                <TimelineSeparator className="bg-input! group-data-[orientation=horizontal]/timeline:-top-6 group-data-[orientation=horizontal]/timeline:left-2.5 group-data-[orientation=horizontal]/timeline:w-[calc(100%-2.25rem)]" />
                <TimelineTitle className="flex flex-wrap items-center gap-2">
                  <span>{stage.title}</span>
                  {status === "current" ? <Badge variant="primary-light" size="sm">Current</Badge> : null}
                </TimelineTitle>
                <TimelineIndicator className={cn(
                  "flex size-6 items-center justify-center border-none",
                  status === "completed" && "bg-emerald-500 text-white",
                  status === "current" && "bg-primary text-primary-foreground",
                  status === "upcoming" && "bg-muted text-muted-foreground",
                )}>
                  {status === "completed" ? <CheckIcon className="size-3.5" /> : status === "current" ? <PlayIcon className="size-3" /> : <CircleIcon className="size-3" />}
                </TimelineIndicator>
              </TimelineHeader>
              <TimelineContent className="text-xs">{duration}</TimelineContent>
            </TimelineItem>
          );
        })}
      </Timeline>
    </section>
  );
}
