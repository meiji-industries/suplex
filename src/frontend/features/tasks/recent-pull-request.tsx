import { useState } from "react";
import { Archive, GitPullRequest } from "lucide-react";
import { type Task } from "../../contracts/tasks.js";
import { useTaskChecks, type TaskChecks } from "./lib/task-checks.js";
import { SidebarMenuAction } from "../../components/ui/sidebar.js";
import { ArchiveTaskDialog } from "./archive-task-dialog.js";

type Checks = TaskChecks;
export type PullRequestColor = "purple" | "red" | "yellow" | "green" | "grey";

export function pullRequestColor(state: string, checks: Checks | null): PullRequestColor {
  const observed = checks?.available ? checks.pullRequestState ?? state : state;
  if (state === "merged" || observed === "merged") return "purple";
  if (observed === "closed") return "grey";
  const runs = checks?.available ? checks.runs : [];
  if (runs.some(run => run.status === "failing")) return "red";
  if (runs.some(run => run.status === "pending")) return "yellow";
  if (observed === "ready" || runs.length > 0 && runs.every(run => run.status === "successful")) return "green";
  return "grey";
}

export function canQuickArchive(color: PullRequestColor, status: Task["status"], archivedAt: Task["archivedAt"]): boolean {
  return color === "purple" && status === "delivered" && archivedAt === null;
}

const colors = { purple: "text-purple-500", red: "text-red-500", yellow: "text-yellow-500", green: "text-green-500", grey: "text-muted-foreground" };

export function RecentPullRequest({ taskId, number, state, headSha, status, archivedAt, onArchived, onError }: { taskId: string; number: number; state: string; headSha: string; status: Task["status"]; archivedAt: Task["archivedAt"]; onArchived: (task: Task) => void; onError: (error: string) => void }) {
  const { checks } = useTaskChecks(state === "merged" ? null : taskId, `${number}:${state}:${headSha}`);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const color = pullRequestColor(state, checks);
  const label = color === "red" ? "CI failed" : color === "yellow" ? "CI in progress" : color === "purple" ? "Merged" : color === "green" ? "Ready or CI passed" : "No passing CI result";
  const canArchive = canQuickArchive(color, status, archivedAt);
  if (canArchive) return <>
    <SidebarMenuAction data-recent-pull-request={state} data-pr-color={color} className="group/pr-action" render={<button type="button" aria-label="Archive task" title="Archive task"><span className="relative size-4 text-purple-500" aria-hidden="true"><GitPullRequest data-pr-icon="pull-request" className="absolute inset-0 size-4 transition-opacity group-hover/pr-action:opacity-0 group-focus/pr-action:opacity-0" /><Archive data-pr-icon="archive" className="absolute inset-0 size-4 opacity-0 transition-opacity group-hover/pr-action:opacity-100 group-focus/pr-action:opacity-100" /></span></button>} onClick={() => setArchiveOpen(true)} />
    <ArchiveTaskDialog task={{ id: taskId }} open={archiveOpen} onOpenChange={setArchiveOpen} onArchived={onArchived} onError={onError} />
  </>;
  return <SidebarMenuAction render={<span data-recent-pull-request={state} data-pr-color={color} title={label}><GitPullRequest aria-label={label} className={`size-4 ${colors[color]}`} /></span>} />;
}
