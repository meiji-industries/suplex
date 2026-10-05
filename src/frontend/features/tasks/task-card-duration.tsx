import { useEffect, useState } from "react";
import type { TaskListTask } from "../../contracts/task-responses.js";
import { taskTimelineDuration } from "../timeline/lib/task-timeline-duration.js";
import { useTaskChecks } from "./lib/task-checks.js";
import { useTaskTimeline } from "./lib/task-queries.js";
import { taskTimelineSpan } from "./lib/task-timeline-span.js";

export function TaskCardDuration({ task }: { task: TaskListTask }) {
  const active = task.status === "active";
  // The board's timeline reads are not pushed by the open-task sync feed.
  const query = useTaskTimeline(task.id, active ? 5000 : false);
  const checksKey = task.pullRequest ? `${task.pullRequest.number}:${task.pullRequest.state}:${task.pullRequest.headSha}` : null;
  const { checks } = useTaskChecks(checksKey ? task.id : null, checksKey);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const activity = query.data?.tasks.find(entry => entry.id === task.id)?.activity;
  if (!activity || query.isError) return null;
  const end = active ? now : Date.parse(task.statusChangedAt);
  const span = taskTimelineSpan(activity, checks?.runs ?? [], task.createdAt, end);
  const duration = active ? span.duration : Math.max(0, Math.min(end, span.end) - span.start);
  return <span data-task-duration title="Elapsed time, including GitHub CI" className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{taskTimelineDuration(duration)}</span>;
}
