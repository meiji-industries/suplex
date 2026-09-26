import { useId } from "react";
import { CheckCircle2, CircleDashed, CircleDotDashed, CircleHelp, CircleSlash, Clock } from "lucide-react";
import type { PullRequestReference, TaskControlStatus } from "../../contracts/task-control.js";
import { Badge } from "../../components/ui/badge.js";
import { withCompany } from "../../lib/api.js";

export const taskStatusLabels = { backlog: "Backlog", queued: "Queued", active: "Active", waiting_human: "Answer necessary", cancelled: "Cancelled", delivered: "Delivered" } satisfies Record<TaskControlStatus, string>;
/** Bubble tone for each status. The icon colors below use the same palette. */
export const taskStatusTones = {
  backlog: "neutral",
  queued: "sky",
  active: "teal",
  waiting_human: "amber",
  cancelled: "neutral",
  delivered: "green",
} as const satisfies Record<TaskControlStatus, "amber" | "teal" | "green" | "sky" | "neutral">;
const appearances = {
  backlog: { icon: CircleDashed, color: "text-muted-foreground" },
  queued: { icon: Clock, color: "text-sky-500" },
  active: { icon: CircleDotDashed, color: "text-teal-500" },
  waiting_human: { icon: CircleHelp, color: "text-amber-500" },
  cancelled: { icon: CircleSlash, color: "text-muted-foreground" },
  delivered: { icon: CheckCircle2, color: "text-green-500" },
} satisfies Record<TaskControlStatus, { icon: typeof CircleDashed; color: string }>;

type TaskStatusProps = { status: TaskControlStatus; pullRequestState?: PullRequestReference["state"] | undefined };

export function taskStatusLabel(task: { status: TaskControlStatus }): string {
  return taskStatusLabels[task.status];
}

export function TaskStatusIcon({ status, pullRequestState }: TaskStatusProps) {
  const maskId = useId();
  const { icon: Icon, color } = appearances[status];
  if (status === "delivered" && pullRequestState === "merged") return <svg role="img" aria-label="Delivered, merged" viewBox="0 0 24 24" className="size-3.5 shrink-0 text-green-500">
    <defs><mask id={maskId}><rect width="24" height="24" fill="white" /><path d="m9 12 2 2 4-4" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></mask></defs>
    <circle cx="12" cy="12" r="11" fill="currentColor" mask={`url(#${maskId})`} />
  </svg>;
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${color}`} />;
}

export function TaskStatus({ status, pullRequestState }: TaskStatusProps) {
  return <Badge variant={taskStatusTones[status]} size="lg">{taskStatusLabels[status]}{status === "delivered" && pullRequestState === "merged" ? <span className="sr-only">, merged</span> : null}</Badge>;
}

/** "Blocked by First · Active, Second · Backlog", or null when the task has no prerequisites. */
type PullRequestBlockerState = "open" | "closed" | "merged";
type BlockedByLabelInput = { title: string; status: TaskControlStatus; kind?: "task" | "pull_request" | undefined; number?: number | undefined; state?: PullRequestBlockerState | undefined };
const pullRequestBlockerStateLabels = { open: "Open", closed: "Closed", merged: "Merged" } satisfies Record<PullRequestBlockerState, string>;

function isPullRequestBlocker(value: BlockedByLabelInput): value is BlockedByLabelInput & { kind: "pull_request"; number: number; state: PullRequestBlockerState } {
  return value.kind === "pull_request" && typeof value.number === "number" && value.state !== undefined;
}

export function blockedByLabel(blockedBy: ReadonlyArray<BlockedByLabelInput>): string | null {
  return blockedBy.length ? `Blocked by ${blockedBy.map(prerequisite => isPullRequestBlocker(prerequisite) ? `#${prerequisite.number} ${prerequisite.title} · ${pullRequestBlockerStateLabels[prerequisite.state]}` : `${prerequisite.title} · ${taskStatusLabel(prerequisite)}`).join(", ")}` : null;
}

/** Status icon beside a task title, linking to the task. */
export function TaskTitleLink({ task, companyId, className = "" }: { task: { id: string; title: string; status: TaskControlStatus; pullRequest?: PullRequestReference | null }; companyId: string; className?: string }) {
  return <a className={`flex min-w-0 items-center gap-1.5 underline-offset-2 hover:underline ${className}`} href={withCompany(`/tasks/${task.id}`, companyId)} title={`${task.title} · ${taskStatusLabel(task)}`}><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="truncate">{task.title}</span></a>;
}
