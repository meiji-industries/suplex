import { useEffect, useState } from "react";
import { TaskTimelineResponseSchema, type TimelineTask } from "../../../tasks/timeline/contracts.js";
import { readJson } from "../../lib/api.js";
import { taskTimelineDuration } from "../timeline/lib/task-timeline-duration.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { TimelineAgentLabel } from "../timeline/timeline-agent-label.js";

import { roleLabel } from "../../../coordination/workflows.js";

const statuses = { completed: "Completed", running: "In progress", failed: "Failed", interrupted: "Stopped" };
const freshnessMs = 10_000;

function timestamp(value: number): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function TaskActivityTimeline({ taskId }: { taskId: string }) {
  const [snapshot, setSnapshot] = useState<{ activity: TimelineTask["activity"]; readAt: number } | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let closed = false;
    let reading = false;
    setSnapshot(null);
    setError("");
    const read = async () => {
      if (reading || closed) return;
      reading = true;
      try {
        const result = TaskTimelineResponseSchema.parse(await readJson(`/api/tasks/${taskId}/timeline`));
        if (!closed) {
          setSnapshot({ activity: result.tasks.find(task => task.id === taskId)?.activity ?? [], readAt: Date.now() });
          setError("");
        }
      } catch { if (!closed) setError("Timeline is not available."); }
      finally { reading = false; }
    };
    void read();
    const poll = setInterval(() => void read(), 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { closed = true; clearInterval(poll); clearInterval(clock); };
  }, [taskId]);
  const liveUntil = snapshot ? snapshot.readAt + freshnessMs : now;
  const asOf = Math.min(Math.max(now, snapshot?.readAt ?? now), error ? snapshot?.readAt ?? now : liveUntil);
  const intervals = (snapshot?.activity ?? []).map(entry => ({
    ...entry, start: Date.parse(entry.startedAt), end: Math.max(Date.parse(entry.startedAt), entry.finishedAt ? Date.parse(entry.finishedAt) : asOf),
    live: entry.status === "running" && !error && now <= liveUntil,
  }));
  const start = intervals.reduce((first, entry) => Math.min(first, entry.start), Infinity);
  const end = intervals.reduce((last, entry) => Math.max(last, entry.end), -Infinity);
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

  return <section aria-label="Task timeline" data-task-timeline className="min-w-0 border-b border-border/70 pb-3">
    <div className="mb-2 flex flex-wrap items-center gap-2"><h3 className="text-xs font-semibold">Timeline</h3>{intervals.length ? <span className="text-xs tabular-nums text-muted-foreground" title="Total Coordinator and Worker execution time. Concurrent executions count separately. Elapsed span from the first agent response to the last.">Worked for {taskTimelineDuration(worked)} during {taskTimelineDuration(end - start)}</span> : null}</div>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!intervals.length ? <p className="text-xs text-muted-foreground">{snapshot ? "No agent time yet." : error ? "Agent time is not available." : "Loading timeline…"}</p> : <div className="overflow-x-auto" aria-label="Task timeline Gantt chart">
      <div className="grid min-w-[45rem] grid-cols-[13rem_minmax(32rem,1fr)] text-xs">
        <div className="sticky left-0 z-20 border-b border-border bg-background px-2 py-1 text-muted-foreground">Agent</div>
        <div className="relative h-6 border-b border-border" data-task-time-axis>
          {ticks.map((tick, index) => <span key={index} className="absolute top-1 whitespace-nowrap text-muted-foreground" style={index === 4 ? { right: 0 } : { left: `${index * 25}%` }}>{new Date(tick).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(span < 300_000 ? { second: "2-digit" } : {}) })}</span>)}
        </div>
        {lanes.map(lane => <div className="contents" key={lane.agentId}>
          <div className="sticky left-0 z-10 flex min-h-11 items-center border-b border-border bg-background px-3">
            <TimelineAgentLabel avatarSeed={lane.avatarSeed} name={lane.name} role={[...lane.roles].join(" / ")} executionCount={lane.entries.length} duration={taskTimelineDuration(lane.entries.reduce((total, entry) => total + entry.end - entry.start, 0))} />
          </div>
          <div className="relative min-h-11 border-b border-border/70" role="list" aria-label={`${lane.name} executions`}>
            {lane.entries.map(entry => {
              const left = Math.min(99.5, (entry.start - start) / span * 100);
              const width = Math.min(100 - left, Math.max(0.5, (entry.end - entry.start) / span * 100));
              const status = entry.status === "running" && !entry.live ? "Observation not available" : statuses[entry.status];
              const role = entry.label ?? roleLabel({ kind: entry.role, advisorRole: entry.advisorRole ?? null });
              const label = `${lane.name}, ${role}, session ${entry.attempt}: ${timestamp(entry.start)} to ${timestamp(entry.end)}, ${taskTimelineDuration(entry.end - entry.start)}. ${status}.`;
              return <div role="listitem" tabIndex={0} key={entry.id} data-task-timing={entry.role} data-task-agent-id={entry.agentId} data-task-timing-active={entry.live || undefined} aria-label={label} title={label} className={`absolute top-3 flex h-5 items-center overflow-hidden rounded-sm px-1 text-left text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.live ? "phase-timing-active text-emerald-950 motion-reduce:animate-none" : entry.status === "failed" ? "bg-destructive/20 text-destructive" : "bg-primary/15 text-foreground"}`} style={{ left: `${left}%`, width: `${width}%` }}><span className="truncate">{role}</span></div>;
            })}
          </div>
        </div>)}
      </div>
    </div>}
  </section>;
}
