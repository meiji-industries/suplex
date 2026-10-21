import { Archive, ArchiveRestore, ArrowUpToLine, CircleX, FastForward, Inbox, Link2, MessageSquare, Pencil, Play, type LucideIcon } from "lucide-react";
import type { TaskActivityAction } from "../../contracts/generated/TaskActivityAction.js";
import type { TaskActivityActionKind } from "../../contracts/generated/TaskActivityActionKind.js";
import type { TaskActivityResponse } from "../../contracts/generated/TaskActivityResponse.js";

type Turn = TaskActivityResponse["turns"][number];
export type TaskActivityRow = { kind: "turn"; turn: Turn } | { kind: "action"; action: TaskActivityAction };

const actions: Record<TaskActivityActionKind, { icon: LucideIcon; text: string }> = {
  task_started: { icon: Play, text: "started the task." },
  task_force_started: { icon: FastForward, text: "started the task anyway." },
  task_moved_to_front: { icon: ArrowUpToLine, text: "moved the task to the front of the queue." },
  task_disarmed: { icon: Inbox, text: "sent the task to the backlog." },
  task_cancelled: { icon: CircleX, text: "cancelled the task." },
  task_answered: { icon: MessageSquare, text: "answered the question." },
  task_details_updated: { icon: Pencil, text: "edited the task." },
  task_dependencies_updated: { icon: Link2, text: "changed Blocked by." },
  task_archived: { icon: Archive, text: "archived the task." },
  task_unarchived: { icon: ArchiveRestore, text: "opened the task from the archive." },
};

/** What the actor did. A force start also tells what held the task, when Suplex recorded it. */
export function actionText(action: TaskActivityAction): string {
  const queue = action.queue;
  const waits = queue?.waitingOn ?? [];
  return [
    actions[action.action].text,
    queue?.projectConcurrencyLimited ? "The project task limit was full." : "",
    queue?.planConcurrencyLimited ? "The Free plan task limit was full." : "",
    waits.length === 1 ? `${waits[0]!.title} was not complete.` : waits.length > 1 ? `${waits.length} prerequisites were not complete.` : "",
  ].filter(Boolean).join(" ");
}

/** Turns in their saved order. Each action comes before the first turn that started after it. */
export function activityRows(turns: readonly Turn[], taskActions: readonly TaskActivityAction[]): TaskActivityRow[] {
  const rows: TaskActivityRow[] = [];
  let next = 0;
  for (const turn of turns) {
    const at = turn.promptedAt ?? turn.completedAt;
    while (at && next < taskActions.length && Date.parse(taskActions[next]!.createdAt) <= Date.parse(at)) rows.push({ kind: "action", action: taskActions[next++]! });
    rows.push({ kind: "turn", turn });
  }
  return [...rows, ...taskActions.slice(next).map(action => ({ kind: "action" as const, action }))];
}

export function TaskActionRow({ action }: { action: TaskActivityAction }) {
  const Icon = actions[action.action].icon;
  return <div data-task-action={action.action} className="flex gap-3 border-b py-3 text-xs">
    <Icon className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1"><span className="font-medium">{action.actorName}</span> <span className="text-muted-foreground">{actionText(action)}</span></span>
    <time className="shrink-0 text-muted-foreground tabular-nums" dateTime={action.createdAt} title={new Date(action.createdAt).toLocaleString()}>{new Date(action.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
  </div>;
}
