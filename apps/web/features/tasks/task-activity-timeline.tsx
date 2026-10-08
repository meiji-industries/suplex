import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { TaskListTask } from "../../contracts/task-responses.js";
import { useTaskTimeline } from "./lib/task-queries.js";
import { useSyncLive } from "../../shell/sync.js";
import { checkRunLabel, checkRunName, checkRunStatus, useTaskChecks } from "./lib/task-checks.js";
import { taskElapsedDuration, taskTimelineDuration } from "../timeline/lib/task-timeline-duration.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { ToolIcon } from "../../components/app/tool-icons.js";
import { TimelineAgentLabel } from "../timeline/timeline-agent-label.js";

import { roleLabel } from "./workflow-presentation.js";

const statuses = { completed: "Completed", running: "In progress", failed: "Failed", interrupted: "Stopped" };
const freshnessMs = 10_000;

function timestamp(value: number): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function TaskActivityTimeline({ taskId, createdAt, checksKey, task }: { taskId: string; createdAt: string; checksKey?: string | null; task?: Pick<TaskListTask, "startedAt" | "status" | "statusChangedAt"> }) {
  const query = useTaskTimeline(taskId);
  const live = useSyncLive();
  // Same refresh key as the Checks tab: both share one poll per task.
  const { checks } = useTaskChecks(checksKey ? taskId : null, checksKey);
  const error = query.isError ? "Timeline is not available." : "";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [taskId]);
  // The sync socket pushes each change of the open task's timeline, so an unchanged value stays current while it is open.
  const snapshot = query.data ? { activity: query.data.tasks.find(task => task.id === taskId)?.activity ?? [], readAt: live && !error ? Math.max(now, query.dataUpdatedAt) : query.dataUpdatedAt } : null;
  const liveUntil = snapshot ? snapshot.readAt + freshnessMs : now;
  const asOf = Math.min(Math.max(now, snapshot?.readAt ?? now), error ? snapshot?.readAt ?? now : liveUntil);
  const intervals = (snapshot?.activity ?? []).map(entry => ({
    ...entry, start: Date.parse(entry.startedAt), end: Math.max(Date.parse(entry.startedAt), entry.finishedAt ? Date.parse(entry.finishedAt) : asOf),
    live: entry.status === "running" && !error && now <= liveUntil,
  }));
  // Latest run per check on the current PR head only; earlier pushes need persisted CI history.
  // Runs that began before the task existed belong to earlier work on the branch.
  const created = Date.parse(createdAt);
  const ciRuns = (checks?.runs ?? []).flatMap(run => {
    const status = checkRunStatus(run);
    const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    if (status === "skipped" || !Number.isFinite(started) || started < created) return [];
    const completed = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
    return [{ run, status, name: checkRunName(run), start: started, end: Math.max(started, Number.isFinite(completed) ? completed : status === "pending" ? now : started) }];
  });
  const ciStart = ciRuns.reduce((first, entry) => Math.min(first, entry.start), Infinity);
  const ciEnd = ciRuns.reduce((last, entry) => Math.max(last, entry.end), -Infinity);
  const start = Math.min(ciStart, intervals.reduce((first, entry) => Math.min(first, entry.start), Infinity));
  const end = Math.max(ciEnd, intervals.reduce((last, entry) => Math.max(last, entry.end), -Infinity));
  const elapsed = task && (task.status === "active" || task.status === "delivered") ? taskElapsedDuration(task, now) : null;
  const worked = intervals.reduce((total, entry) => total + entry.end - entry.start, 0);
  const span = Math.max(1, end - start);
  const ticks = Array.from({ length: 5 }, (_, index) => start + span * index / 4);
  const laneMap = new Map<string, { agentId: string; avatarSeed: string; name: string; roles: Set<string>; entries: typeof intervals }>();
  for (const entry of intervals) {
    const lane = laneMap.get(entry.agentId) ?? { agentId: entry.agentId, avatarSeed: entry.avatarSeed, name: entry.agentName, roles: new Set(), entries: [] };
    lane.roles.add(entry.label ?? roleLabel({ kind: entry.role, advisorRole: entry.advisorRole ?? null }));
    lane.entries.push(entry);
    laneMap.set(entry.agentId, lane);
  }
  const lanes = [...laneMap.values()];

  return <section aria-label="Task timeline" data-task-timeline className="min-w-0 pb-0">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!intervals.length ? snapshot || error ? <Alert><Info /><AlertDescription>{snapshot ? "No agent time yet." : "Agent time is not available."}</AlertDescription></Alert> : <p className="text-xs text-muted-foreground">Loading timeline…</p> : <div className="overflow-x-auto dark:bg-[color-mix(in_oklch,_var(--background),_white_6%)] not-dark:bg-[color-mix(in_oklch,_var(--background),_black_3%)] rounded-tl-[var(--radius)] rounded-tr-[var(--radius)] rounded-br-[var(--radius)] rounded-bl-[var(--radius)] pt-[15px] pb-1" aria-label="Task timeline Gantt chart">
      <div className="grid min-w-[45rem] grid-cols-[13rem_minmax(32rem,1fr)_15px] text-xs [&>.contents:last-child>*]:border-b-0">
        <div className="sticky left-0 z-20 truncate border-b border-border bg-background px-2 py-1 tabular-nums text-muted-foreground dark:bg-[color-mix(in_oklch,_var(--background),_white_6%)] not-dark:bg-[color-mix(in_oklch,_var(--background),_black_3%)] pl-[15px]" title="Total Coordinator and Worker execution time. Concurrent executions count separately. Elapsed span covers agent time and GitHub CI checks.">Worked for {taskTimelineDuration(worked)} during {taskTimelineDuration(elapsed ?? end - start)}</div>
        <div className="relative h-6 border-b border-border" data-task-time-axis>
          {ticks.map((tick, index) => <span key={index} className="absolute top-1 whitespace-nowrap text-muted-foreground" style={index === 4 ? { right: 0 } : { left: `${index * 25}%` }}>{new Date(tick).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(span < 300_000 ? { second: "2-digit" } : {}) })}</span>)}
        </div><div aria-hidden="true" className="border-b border-border" />
        {lanes.map(lane => <div className="contents" key={lane.agentId}>
          <div className="sticky left-0 z-10 flex items-center border-b border-border bg-background px-3 dark:bg-[color-mix(in_oklch,_var(--background),_white_6%)] not-dark:bg-[color-mix(in_oklch,_var(--background),_black_3%)] min-h-[54px] pt-[10px] pb-[10px] pl-[15px]">
            <TimelineAgentLabel avatarSeed={lane.avatarSeed} name={lane.name} role={[...lane.roles].join(" / ")} executionCount={lane.entries.length} duration={taskTimelineDuration(lane.entries.reduce((total, entry) => total + entry.end - entry.start, 0))} />
          </div>
          <div className="relative border-b border-border/70 min-h-[54px]" role="list" aria-label={`${lane.name} executions`}>
            {lane.entries.map(entry => {
              const left = Math.min(99.5, (entry.start - start) / span * 100);
              const width = Math.min(100 - left, Math.max(0.5, (entry.end - entry.start) / span * 100));
              const status = entry.status === "running" && !entry.live ? "Observation not available" : statuses[entry.status];
              const role = entry.label ?? roleLabel({ kind: entry.role, advisorRole: entry.advisorRole ?? null });
              const label = `${lane.name}, ${role}, session ${entry.attempt}: ${timestamp(entry.start)} to ${timestamp(entry.end)}, ${taskTimelineDuration(entry.end - entry.start)}. ${status}.`;
              return <div role="listitem" tabIndex={0} key={entry.id} data-task-timing={entry.role} data-task-agent-id={entry.agentId} data-task-timing-active={entry.live || undefined} aria-label={label} title={label} className={`absolute flex h-5 items-center overflow-hidden rounded-sm px-1 text-left text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.live ? "phase-timing-active text-emerald-950 motion-reduce:animate-none" : entry.status === "failed" ? "bg-destructive/20 text-destructive" : "bg-primary/15 text-foreground"} top-[17px]`} style={{ left: `${left}%`, width: `${width}%` }}><span className="truncate">{role}</span></div>;
            })}
          </div><div aria-hidden="true" className="border-b border-border/70" />
        </div>)}
        {ciRuns.length ? <div className="contents" data-task-ci-lane>
          <div className="sticky left-0 z-10 flex items-center border-b border-border bg-background px-3 dark:bg-[color-mix(in_oklch,_var(--background),_white_6%)] not-dark:bg-[color-mix(in_oklch,_var(--background),_black_3%)] min-h-[54px] pt-[5px] pb-[5px] pl-[15px]">
            <span className="flex min-w-0 items-center gap-2">
              {/* Same box as an agent's avatar, so the names line up. */}
              <span className="grid size-6 shrink-0 place-items-center"><ToolIcon tool="gh-auth" /></span>
              <span className="min-w-0"><span className="block truncate text-xs font-medium">GitHub CI</span><span className="block truncate text-xs text-muted-foreground">Checks · {ciRuns.length}× · {taskTimelineDuration(ciEnd - ciStart)}</span></span>
            </span>
          </div>
          <div className="relative border-b border-border/70 min-h-[54px]" role="list" aria-label="GitHub CI checks">
            {ciRuns.map((entry, index) => {
              const left = Math.min(99.5, (entry.start - start) / span * 100);
              const width = Math.min(100 - left, Math.max(0.5, (entry.end - entry.start) / span * 100));
              const label = `${entry.name}: ${timestamp(entry.start)} to ${timestamp(entry.end)}. ${checkRunLabel(entry.run, now)}.`;
              return <div role="listitem" tabIndex={0} key={`${entry.name}:${index}`} data-task-ci-check={entry.status} aria-label={label} title={label} className={`absolute flex h-5 items-center overflow-hidden rounded-sm px-1 text-left text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.status === "pending" ? "phase-timing-active text-emerald-950 motion-reduce:animate-none" : entry.status === "failed" ? "bg-destructive/20 text-destructive" : "bg-muted text-muted-foreground"} top-[17px]`} style={{ left: `${left}%`, width: `${width}%` }}><span className="truncate">{entry.name}</span></div>;
            })}
          </div><div aria-hidden="true" className="border-b border-border/70" />
        </div> : null}
      </div>
    </div>}
  </section>;
}
