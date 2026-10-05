import { useState, type ReactElement } from "react";
import { Zap } from "lucide-react";
import { withCompany } from "../../lib/api.js";
import { showRecentTasks } from "./lib/task-list.js";
import { useTaskAgents, useTaskCache, useTaskData } from "./task-data.js";
import type { TaskListTask } from "../../contracts/task-responses.js";
import type { MoveRunResponse } from "../../contracts/generated/MoveRunResponse.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../../components/ui/sidebar.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { useRunActions, useShellRuns } from "../moves/lib/move-runs.js";
import { RunActionBadge } from "../moves/run-badge.js";
import { blockedByLabel, TaskStatusIcon, taskStatusLabel } from "./task-status.js";
import { RecentTaskAgents } from "./recent-task-agents.js";
import { RecentPullRequest } from "./recent-pull-request.js";
import { useTaskCosts } from "../analytics/lib/analytics.js";
import { CostValue } from "../../components/app/cost-value.js";

export function recentTasks<T extends Pick<TaskListTask, "status" | "statusChangedAt">>(tasks: T[]): T[] {
  return tasks.filter(task => task.status !== "cancelled").sort((left, right) => right.statusChangedAt.localeCompare(left.statusChangedAt)).slice(0, 10);
}

/** Tasks and shell move runs, newest first. Other runners already show through the tasks they start. */
export function recentActivity<T extends Pick<TaskListTask, "status" | "statusChangedAt">, R extends Pick<MoveRunResponse, "startedAt">>(tasks: T[], runs: R[]): Array<{ task: T; run?: never } | { run: R; task?: never }> {
  return [...recentTasks(tasks).map(task => ({ at: task.statusChangedAt, item: { task } })), ...runs.map(run => ({ at: run.startedAt, item: { run } }))]
    .sort((left, right) => right.at.localeCompare(left.at)).slice(0, 10).map(entry => entry.item);
}

export function RecentTasks({ close }: { close?: () => void }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const costs = useTaskCosts(companyId);
  return companyId && showRecentTasks(window.location.pathname) ? <RecentTasksContent costs={costs} {...(close ? { close } : {})} /> : null;
}

function RecentTasksContent({ close, costs }: { close?: () => void; costs: ReturnType<typeof useTaskCosts> }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const list = useTaskData();
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set());
  const runActions = useRunActions();
  const activity = recentActivity(list.data ?? [], useShellRuns(companyId).map(({ run }) => run).filter(run => !archived.has(run.id)));
  const tasks = activity.flatMap(item => item.task ? [item.task] : []);
  const agents = useTaskAgents(tasks.map(task => task.id));
  const cacheTask = useTaskCache();
  const [archiveError, setArchiveError] = useState("");
  if (!activity.length) return null;
  return <SidebarGroup><SidebarGroupLabel>Activity</SidebarGroupLabel>{archiveError ? <p role="alert" className="px-2 text-xs text-destructive">{archiveError}</p> : null}<SidebarGroupContent><SidebarMenu>{activity.map(({ task, run }) => {
    if (run) {
      const path = `/moves/${run.moveId}/runs/${run.id}`;
      return <SidebarMenuItem key={run.id}>
        <SidebarMenuButton render={<a href={withCompany(path, companyId)} onClick={close} aria-label={`${run.moveName}, move, ${run.live ? "live" : "ended"}`}>
          <span className="flex min-w-0 flex-1 items-center gap-2 pr-16">
            <Zap aria-hidden="true" className={`size-3.5 shrink-0 ${run.live ? "text-primary motion-safe:animate-pulse" : "text-muted-foreground"}`} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{run.moveName}</span>
          </span>
        </a>} isActive={window.location.pathname === path} tooltip={run.moveName} />
        <RunActionBadge live={run.live} label={run.moveName}
          onStop={() => { runActions.stop(run.id).catch((cause: unknown) => setArchiveError(cause instanceof Error ? cause.message : "Suplex could not stop the run.")); }}
          onArchive={() => { setArchived(current => new Set(current).add(run.id)); runActions.archive(run.id).catch((cause: unknown) => { setArchived(current => { const next = new Set(current); next.delete(run.id); return next; }); setArchiveError(cause instanceof Error ? cause.message : "Suplex could not archive the run."); }); }} />
      </SidebarMenuItem>;
    }
    const cost = costs.get(task.id);
    return <SidebarMenuItem key={task.id}>
      <SidebarMenuButton render={<a href={withCompany(`/tasks/${task.id}`, companyId)} onClick={close} aria-label={`${task.title}, ${taskStatusLabel(task)}${task.blockedBy.length ? `, ${blockedByLabel(task.blockedBy)}` : ""}${task.pullRequest ? `, pull request ${task.pullRequest.state}` : ""}`}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span data-recent-task-status={task.status} className={`inline-flex shrink-0${task.status === "active" ? " animate-spin" : ""}`}><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /></span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}{task.blockedBy.length ? <span data-recent-task-blocked-by className="text-muted-foreground"> · {blockedByLabel(task.blockedBy)}</span> : null}</span>
          {cost?.cost != null ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} className="shrink-0 text-xs tabular-nums text-muted-foreground" suffix={cost.partial ? "+" : ""} /> : null}
        </span>
      </a>} isActive={window.location.pathname === `/tasks/${task.id}`} tooltip={`${task.title}${task.blockedBy.length ? ` · ${blockedByLabel(task.blockedBy)}` : ""}`} />
      {task.pullRequest ? <RecentPullRequest taskId={task.id} number={task.pullRequest.number} state={task.pullRequest.state} headSha={task.pullRequest.headSha} status={task.status} archivedAt={task.archivedAt} onArchived={cacheTask} onError={setArchiveError} /> : null}
      <RecentTaskAgents agents={(agents.data?.find(row => row.taskId === task.id)?.agents ?? []).map(agent => agents.isError ? { ...agent, status: "unknown" } : agent)} />
    </SidebarMenuItem>;
  })}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
