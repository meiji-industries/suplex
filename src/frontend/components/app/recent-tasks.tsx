import { useEffect, useState, type ReactElement } from "react";
import { withCompany } from "../../lib/api.js";
import { readTaskList } from "../../lib/task-list.js";
import type { Task } from "../../../task-contracts.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { TaskStatusIcon, taskStatusLabels } from "./task-status.js";
import { RecentTaskAgents } from "./recent-task-agents.js";
import { RecentPullRequest } from "./recent-pull-request.js";
import { money, useTaskCosts } from "../../lib/analytics.js";

export function recentTasks<T extends Pick<Task, "status" | "updatedAt">>(tasks: T[]): T[] {
  return tasks.filter(task => task.status !== "cancelled").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 10);
}

export function showRecentTasks(path: string): boolean {
  return !/^\/(?:admin(?:\/|$)|profile(?:\/|$)|companies\/[^/]+\/settings(?:\/|$))/.test(path);
}

export function RecentTasks({ close }: { close?: () => void }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const costs = useTaskCosts(companyId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archiveError, setArchiveError] = useState("");
  useEffect(() => {
    setTasks([]);
    if (!companyId) return;
    let cancelled = false;
    const load = async () => { try { const rows = await readTaskList(companyId); if (!cancelled) setTasks(recentTasks(rows)); } catch { if (!cancelled) setTasks([]); } };
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [companyId]);
  if (!tasks.length || !showRecentTasks(window.location.pathname)) return null;
  return <SidebarGroup><SidebarGroupLabel>Activity</SidebarGroupLabel>{archiveError ? <p role="alert" className="px-2 text-xs text-destructive">{archiveError}</p> : null}<SidebarGroupContent><SidebarMenu>{tasks.map(task => <SidebarMenuItem key={task.id}>
     <SidebarMenuButton render={<a href={withCompany(`/tasks/${task.id}`, companyId)} onClick={close} aria-label={`${task.title}, ${taskStatusLabels[task.status]}${task.pullRequest ? `, pull request ${task.pullRequest.state}` : ""}`}>
       <span className="flex min-w-0 flex-1 items-center gap-2">
         <span data-recent-task-status={task.status} className={`inline-flex shrink-0${task.status === "active" ? " animate-spin" : ""}`}><TaskStatusIcon status={task.status} /></span>
         <span className="min-w-0 flex-1 truncate">{task.title}</span>
         {costs.get(task.id)?.cost != null ? <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title={`Estimated cost (USD)${costs.get(task.id)?.partial ? ", partial usage" : ""}. OpenCode estimates are not bills.`}>{money(costs.get(task.id)?.cost ?? null)}{costs.get(task.id)?.partial ? "+" : ""}</span> : null}
       </span>
     </a>} isActive={window.location.pathname === `/tasks/${task.id}`} tooltip={task.title} />
     {task.pullRequest ? <RecentPullRequest taskId={task.id} state={task.pullRequest.state} headSha={task.pullRequest.headSha} status={task.status} archivedAt={task.archivedAt} onArchived={() => setTasks(current => current.filter(candidate => candidate.id !== task.id))} onError={setArchiveError} /> : null}
     <RecentTaskAgents taskId={task.id} />
   </SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
