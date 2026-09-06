import { useEffect, useState } from "react";
import { TaskTimelineResponseSchema, type TimelineTask } from "../../../task-timeline-contracts.js";
import { readJson } from "../../lib/api.js";
import { duration } from "../../lib/analytics.js";
import { Alert, AlertDescription } from "../ui/alert.js";

const roles = [{ kind: "root", label: "Coordinator" }, { kind: "worker", label: "Worker" }] as const;
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
  const span = Math.max(1, end - start);
  const ticks = Array.from({ length: 5 }, (_, index) => start + span * index / 4);

  return <section aria-label="Task timeline" data-task-timeline className="min-w-0 border-b border-border/70 pb-3">
    <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold">Timeline</h3>{intervals.length ? <span className="text-[11px] tabular-nums text-muted-foreground" title="Elapsed time from the first agent response to the last">Elapsed {duration(end - start)}</span> : null}</div>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!intervals.length ? <p className="text-xs text-muted-foreground">{snapshot ? "No agent time yet." : error ? "Agent time is not available." : "Forge reads the timeline."}</p> : <div className="overflow-x-auto" aria-label="Task timeline Gantt chart">
      <div className="grid min-w-[42rem] grid-cols-[10rem_minmax(32rem,1fr)] text-[11px]">
        <div className="sticky left-0 z-20 border-b border-border bg-background px-2 py-1 text-muted-foreground">Agent</div>
        <div className="relative h-6 border-b border-border" data-task-time-axis>
          {ticks.map((tick, index) => <span key={index} className="absolute top-1 whitespace-nowrap text-muted-foreground" style={index === 4 ? { right: 0 } : { left: `${index * 25}%` }}>{new Date(tick).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(span < 300_000 ? { second: "2-digit" } : {}) })}</span>)}
        </div>
        {roles.map(role => <div className="contents" key={role.kind}>
          <div className="sticky left-0 z-10 flex min-h-9 items-center border-b border-border bg-background px-2 font-medium">{role.label}</div>
          <div className="relative min-h-9 border-b border-border/70" role="list" aria-label={`${role.label} executions`}>
            {intervals.filter(entry => entry.role === role.kind).map(entry => {
              const left = Math.min(99.5, (entry.start - start) / span * 100);
              const width = Math.min(100 - left, Math.max(0.5, (entry.end - entry.start) / span * 100));
              const status = entry.status === "running" && !entry.live ? "Observation not available" : statuses[entry.status];
              const label = `${role.label}, session ${entry.attempt}: ${timestamp(entry.start)} to ${timestamp(entry.end)}, ${duration(entry.end - entry.start)}. ${status}.`;
              return <div role="listitem" tabIndex={0} key={entry.id} data-task-timing={role.kind} data-task-timing-active={entry.live || undefined} aria-label={label} title={label} className={`absolute top-2 flex h-5 items-center overflow-hidden rounded-sm px-1 text-left text-[10px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.live ? "phase-timing-active text-emerald-950 motion-reduce:animate-none" : entry.status === "failed" ? "bg-destructive/20 text-destructive" : "bg-primary/15 text-foreground"}`} style={{ left: `${left}%`, width: `${width}%` }}><span className="truncate">{role.label}</span></div>;
            })}
          </div>
        </div>)}
      </div>
    </div>}
  </section>;
}
