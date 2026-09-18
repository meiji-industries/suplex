import { useId } from "react";
import { CheckCircle2, CircleDashed, CircleDotDashed, CircleHelp, CircleSlash } from "lucide-react";
import type { PullRequestReference, TaskControlStatus } from "../../../tasks/control.js";
import { Badge } from "../../components/ui/badge.js";
import { withCompany } from "../../lib/api.js";

export const taskStatusLabels = { backlog: "Backlog", active: "Active", waiting_human: "Answer necessary", cancelled: "Cancelled", delivered: "Delivered" } satisfies Record<TaskControlStatus, string>;
const appearances = {
  backlog: { icon: CircleDashed, color: "text-muted-foreground" },
  active: { icon: CircleDotDashed, color: "text-amber-500" },
  waiting_human: { icon: CircleHelp, color: "text-rose-500" },
  cancelled: { icon: CircleSlash, color: "text-muted-foreground" },
  delivered: { icon: CheckCircle2, color: "text-emerald-500" },
} satisfies Record<TaskControlStatus, { icon: typeof CircleDashed; color: string }>;

type TaskStatusProps = { status: TaskControlStatus; pullRequestState?: PullRequestReference["state"] | undefined };

export function TaskStatusIcon({ status, pullRequestState }: TaskStatusProps) {
  const maskId = useId();
  const { icon: Icon, color } = appearances[status];
  if (status === "delivered" && pullRequestState === "merged") return <svg role="img" aria-label="Delivered, merged" viewBox="0 0 24 24" className="size-3.5 shrink-0 text-emerald-500">
    <defs><mask id={maskId}><rect width="24" height="24" fill="white" /><path d="m9 12 2 2 4-4" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></mask></defs>
    <circle cx="12" cy="12" r="11" fill="currentColor" mask={`url(#${maskId})`} />
  </svg>;
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${color}`} />;
}

export function TaskStatus({ status, pullRequestState }: TaskStatusProps) {
  return <Badge variant={status === "waiting_human" ? "destructive" : "secondary"}><TaskStatusIcon status={status} pullRequestState={pullRequestState} />{taskStatusLabels[status]}</Badge>;
}

/** "Blocked by First · Active, Second · Backlog", or null when the task has no prerequisites. */
export function blockedByLabel(blockedBy: ReadonlyArray<{ title: string; status: TaskControlStatus }>): string | null {
  return blockedBy.length ? `Blocked by ${blockedBy.map(prerequisite => `${prerequisite.title} · ${taskStatusLabels[prerequisite.status]}`).join(", ")}` : null;
}

/** Status icon beside a task title, linking to the task. */
export function TaskTitleLink({ task, companyId, className = "" }: { task: { id: string; title: string; status: TaskControlStatus; pullRequest?: PullRequestReference | null }; companyId: string; className?: string }) {
  return <a className={`flex min-w-0 items-center gap-1.5 underline-offset-2 hover:underline ${className}`} href={withCompany(`/tasks/${task.id}`, companyId)} title={`${task.title} · ${taskStatusLabels[task.status]}`}><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="truncate">{task.title}</span></a>;
}
