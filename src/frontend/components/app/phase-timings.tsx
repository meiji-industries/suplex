import { useEffect, useState } from "react";

import type { TaskResponse } from "../../../http/contracts/tasks.js";
import type { IssuePhase } from "../../../issue-phases.js";
import { phaseTimingDuration, phaseTimingLanes, phaseTimings } from "../../lib/phase-timings.js";

type Activity = Pick<TaskResponse["activity"][number], "createdAt" | "eventType">;

function timestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function axisInterval(totalDuration: number): number {
  if (totalDuration <= 30 * 60_000) return 5;
  if (totalDuration <= 3 * 60 * 60_000) return 15;
  if (totalDuration <= 6 * 60 * 60_000) return 30;
  return 60;
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function PhaseTimings({ activity, phase, updatedAt }: { activity: Activity[]; phase: IssuePhase; updatedAt: string }) {
  const terminal = ["done", "cancelled", "failed"].includes(phase);
  const [asOf, setAsOf] = useState(() => terminal ? updatedAt : new Date().toISOString());
  useEffect(() => {
    setAsOf(terminal ? updatedAt : new Date().toISOString());
    if (terminal) return;
    const timer = window.setInterval(() => setAsOf(new Date().toISOString()), 30_000);
    return () => window.clearInterval(timer);
  }, [terminal, updatedAt]);
  const timings = phaseTimings(activity, phase, asOf);
  if (!timings.length) return null;
  const totalDuration = timings.reduce((total, timing) => total + timing.durationMs, 0);
  const lanes = phaseTimingLanes(timings);
  const startMs = Date.parse(timings[0]!.startAt);
  const endMs = Date.parse(timings.at(-1)!.endAt);
  const axisDuration = Math.max(1, endMs - startMs);
  const tickMs = axisInterval(axisDuration) * 60_000;
  const ticks = Array.from({ length: Math.ceil(axisDuration / tickMs) }, (_, index) => startMs + index * tickMs);

  return <section data-phase-timings aria-label="Phase timings" className="border-t border-border/70 pt-2">
    <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold">Timeline</h3><span className="text-[11px] tabular-nums text-muted-foreground" title="Elapsed phase time">Total {phaseTimingDuration(totalDuration)}</span></div>
    <div className="overflow-x-auto" aria-label="Phase timeline Gantt chart">
      <div className="grid min-w-[42rem] grid-cols-[10rem_minmax(32rem,1fr)] text-[11px]">
        <div className="sticky left-0 z-20 border-b border-border bg-background px-2 py-1 text-muted-foreground">Phase</div>
        <div className="relative h-6 border-b border-border" data-phase-time-axis>
          {ticks.map((tick) => <span className="absolute top-1 text-muted-foreground" key={tick} style={{ left: `${((tick - startMs) / axisDuration) * 100}%` }}>{timeLabel(tick)}</span>)}
          <span className="absolute right-0 top-1 text-muted-foreground">{timeLabel(endMs)}</span>
        </div>
        {lanes.map((lane) => <div className="contents" key={lane.phase}>
          <div className="sticky left-0 z-10 flex min-h-9 items-center border-b border-border bg-background px-2 font-medium" data-phase-lane={lane.phase}>{lane.label}</div>
          <div className="relative min-h-9 border-b border-border/70" role="list" aria-label={`${lane.label} phase visits`}>
            {lane.timings.map((timing) => {
              const left = ((Date.parse(timing.startAt) - startMs) / axisDuration) * 100;
              const width = Math.max(0.5, (timing.durationMs / axisDuration) * 100);
              const label = `${timing.label}: ${timestamp(timing.startAt)} to ${timestamp(timing.endAt)}, ${phaseTimingDuration(timing.durationMs)}.`;
              return <button className={`absolute top-2 h-5 overflow-hidden rounded-sm px-1 text-left text-[10px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring ${timing.current ? "animate-pulse bg-primary/30 text-foreground" : timing.label === "Needs attention" ? "bg-destructive/20 text-destructive" : "bg-primary/15 text-foreground"}`} data-phase-timing={timing.phase} type="button" role="listitem" key={`${timing.phase}-${timing.startAt}`} aria-current={timing.current ? "step" : undefined} aria-label={label} title={label} style={{ left: `${left}%`, width: `${width}%` }}><span className="sr-only">{label}</span></button>;
            })}
          </div>
        </div>)}
      </div>
    </div>
  </section>;
}
