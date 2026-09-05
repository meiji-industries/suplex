import { CheckCircle2, CircleDashed, CircleDotDashed, CircleHelp, CircleSlash } from "lucide-react";
import type { TaskControlStatus } from "../../../task-control.js";
import { Badge } from "../ui/badge.js";

export const taskStatusLabels = { backlog: "Backlog", active: "Active", waiting_human: "Answer necessary", cancelled: "Cancelled", delivered: "Delivered" } satisfies Record<TaskControlStatus, string>;
const appearances = {
  backlog: { icon: CircleDashed, color: "text-muted-foreground" },
  active: { icon: CircleDotDashed, color: "text-amber-500" },
  waiting_human: { icon: CircleHelp, color: "text-rose-500" },
  cancelled: { icon: CircleSlash, color: "text-muted-foreground" },
  delivered: { icon: CheckCircle2, color: "text-emerald-500" },
} satisfies Record<TaskControlStatus, { icon: typeof CircleDashed; color: string }>;

export function TaskStatusIcon({ status }: { status: TaskControlStatus }) {
  const { icon: Icon, color } = appearances[status];
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${color}`} />;
}

export function TaskStatus({ status }: { status: TaskControlStatus }) {
  return <Badge variant={status === "waiting_human" ? "destructive" : "secondary"}><TaskStatusIcon status={status} />{taskStatusLabels[status]}</Badge>;
}
