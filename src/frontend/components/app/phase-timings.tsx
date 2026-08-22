import { useEffect, useState } from "react";

import type { TaskResponse } from "../../../http/contracts/tasks.js";
import type { IssuePhase } from "../../../issue-phases.js";
import { phaseTimingDuration, phaseTimings } from "../../lib/phase-timings.js";

type Activity = Pick<TaskResponse["activity"][number], "createdAt" | "eventType">;

function timestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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

  return <section data-phase-timings aria-label="Phase timings" className="border-t border-border/70 pt-2">
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <ol className="flex min-w-0 flex-1 flex-wrap gap-1 max-[420px]:grid max-[420px]:grid-cols-2" aria-label="Time in each phase">
        {timings.map((timing) => <li className="group relative min-w-0 flex-[1_1_4rem] outline-none focus-visible:ring-2 focus-visible:ring-ring max-[420px]:flex-none" data-phase-timing={timing.phase} tabIndex={0} key={`${timing.phase}-${timing.startAt}`} aria-current={timing.current ? "step" : undefined} aria-label={`${timing.label}: ${phaseTimingDuration(timing.durationMs)}. ${timestamp(timing.startAt)} to ${timestamp(timing.endAt)}.`} style={{ flexGrow: Math.max(1, timing.durationMs / 60_000) }}>
          <span className={`block truncate rounded-sm px-1.5 py-1 tabular-nums ${timing.current ? "animate-pulse bg-primary/15 text-foreground" : "bg-muted/70"}`}>{timing.label} {phaseTimingDuration(timing.durationMs)}</span>
          <span className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-max max-w-[18rem] rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-sm group-hover:block group-focus:block">{timestamp(timing.startAt)} – {timestamp(timing.endAt)}</span>
        </li>)}
      </ol>
      <span className="shrink-0 tabular-nums" title="Total elapsed across recorded phases">Total {phaseTimingDuration(totalDuration)}</span>
    </div>
  </section>;
}
