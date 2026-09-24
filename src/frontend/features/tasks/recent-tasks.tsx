import { useState, type ReactElement } from "react";
import { withCompany } from "../../lib/api.js";
import { showRecentTasks } from "./lib/task-list.js";
import { useTaskAgents, useTaskCache, useTaskData } from "./task-data.js";
import type { Task } from "../../../tasks/contracts.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../../components/ui/sidebar.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { blockedByLabel, TaskStatusIcon, taskStatusLabel } from "./task-status.js";
import { RecentTaskAgents } from "./recent-task-agents.js";
import { RecentPullRequest } from "./recent-pull-request.js";
import { useTaskCosts } from "../analytics/lib/analytics.js";
import { CostValue } from "../../components/app/cost-value.js";

export function recentTasks<T extends Pick<Task, "status" | "statusChangedAt">>(tasks: T[]): T[] {
  return tasks.filter(task => task.status !== "cancelled").sort((left, right) => right.statusChangedAt.localeCompare(left.statusChangedAt)).slice(0, 10);
}

export function RecentTasks({ close }: { close?: () => void }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const costs = useTaskCosts(companyId);
  return companyId && showRecentTasks(window.location.pathname) ? <RecentTasksContent costs={costs} {...(close ? { close } : {})} /> : null;
}

function RecentTasksContent({ close, costs }: { close?: () => void; costs: ReturnType<typeof useTaskCosts> }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const list = useTaskData();
  const tasks = recentTasks(list.data ?? []);
  const agents = useTaskAgents(tasks.map(task => task.id));
  const cacheTask = useTaskCache();
  const [archiveError, setArchiveError] = useState("");
  if (!tasks.length) return null;
  return <SidebarGroup><SidebarGroupLabel>Activity</SidebarGroupLabel>{archiveError ? <p role="alert" className="px-2 text-xs text-destructive">{archiveError}</p> : null}<SidebarGroupContent><SidebarMenu>{tasks.map(task => {
    const cost = costs.get(task.id);
    return <SidebarMenuItem key={task.id}>
      <SidebarMenuButton render={<a href={withCompany(`/tasks/${task.id}`, companyId)} onClick={close} aria-label={`${task.title}, ${taskStatusLabel(task)}${task.blockedBy.length ? `, ${blockedByLabel(task.blockedBy)}` : ""}${task.pullRequest ? `, pull request ${task.pullRequest.state}` : ""}`}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span data-recent-task-status={task.status} className={`inline-flex shrink-0${task.status === "active" ? " animate-spin" : ""}`}><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /></span>
          <span className="min-w-0 flex-1 truncate">{task.title}{task.blockedBy.length ? <span data-recent-task-blocked-by className="text-muted-foreground"> · {blockedByLabel(task.blockedBy)}</span> : null}</span>
          {cost?.cost != null ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} className="shrink-0 text-xs tabular-nums text-muted-foreground" suffix={cost.partial ? "+" : ""} /> : null}
        </span>
      </a>} isActive={window.location.pathname === `/tasks/${task.id}`} tooltip={`${task.title}${task.blockedBy.length ? ` · ${blockedByLabel(task.blockedBy)}` : ""}`} />
      {task.pullRequest ? <RecentPullRequest taskId={task.id} number={task.pullRequest.number} state={task.pullRequest.state} headSha={task.pullRequest.headSha} status={task.status} archivedAt={task.archivedAt} onArchived={cacheTask} onError={setArchiveError} /> : null}
      <RecentTaskAgents agents={(agents.data?.find(row => row.taskId === task.id)?.agents ?? []).map(agent => agents.isError ? { ...agent, status: "unknown" } : agent)} />
    </SidebarMenuItem>;
  })}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
