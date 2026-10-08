import type { TaskListTask } from "../../../contracts/task-responses.js";

export function taskTimelineDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function taskElapsedDuration(task: Pick<TaskListTask, "startedAt" | "status" | "statusChangedAt">, now: number): number | null {
  if (!task.startedAt) return null;
  const end = task.status === "active" ? now : Date.parse(task.statusChangedAt);
  return Math.max(0, end - Date.parse(task.startedAt));
}
