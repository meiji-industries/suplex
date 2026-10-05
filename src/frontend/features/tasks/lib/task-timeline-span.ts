import type { TimelineTask } from "../../../contracts/timeline.js";
import { checkRunStatus, type CheckRun } from "./task-checks.js";

/** The elapsed span shown by the task timeline, including GitHub CI. */
export function taskTimelineSpan(activity: TimelineTask["activity"], runs: CheckRun[], createdAt: string, now: number, asOf = now): { start: number; end: number; duration: number } {
  const intervals = activity.map(entry => {
    const start = Date.parse(entry.startedAt);
    return { start, end: Math.max(start, entry.finishedAt ? Date.parse(entry.finishedAt) : asOf) };
  });
  for (const run of runs) {
    const status = checkRunStatus(run);
    const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
    if (status === "skipped" || !Number.isFinite(start) || start < Date.parse(createdAt)) continue;
    const completed = run.completedAt ? Date.parse(run.completedAt) : NaN;
    intervals.push({ start, end: Math.max(start, Number.isFinite(completed) ? completed : status === "pending" ? now : start) });
  }
  const start = intervals.reduce((first, entry) => Math.min(first, entry.start), Infinity);
  const end = intervals.reduce((last, entry) => Math.max(last, entry.end), -Infinity);
  return { start, end, duration: intervals.length ? Math.max(0, end - start) : 0 };
}
