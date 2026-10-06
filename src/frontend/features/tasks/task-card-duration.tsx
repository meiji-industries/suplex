import { useEffect, useState } from "react";
import type { TaskListTask } from "../../contracts/task-responses.js";
import { taskElapsedDuration, taskTimelineDuration } from "../timeline/lib/task-timeline-duration.js";

export function TaskCardDuration({ task }: { task: TaskListTask }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (task.status !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.status]);
  const duration = taskElapsedDuration(task, now);
  if (duration === null) return null;
  return <span data-task-duration title="Elapsed time, including GitHub CI" className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{taskTimelineDuration(duration)}</span>;
}
