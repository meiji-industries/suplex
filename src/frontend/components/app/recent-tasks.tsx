import { useEffect, useState, type ReactElement } from "react";
import { withCompany } from "../../lib/api.js";
import { readTaskList } from "../../lib/task-list.js";
import type { Task } from "../../../task-contracts.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { TaskStatusIcon, taskStatusLabels } from "./task-status.js";
import { RecentTaskAgents } from "./recent-task-agents.js";
import { RecentPullRequest } from "./recent-pull-request.js";

export function recentTasks<T extends Pick<Task, "status" | "updatedAt">>(tasks: T[]): T[] {
  return tasks.filter(task => task.status !== "cancelled").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 10);
}

export function showRecentTasks(path: string): boolean {
  return !/^\/(?:admin(?:\/|$)|profile(?:\/|$)|companies\/[^/]+\/settings(?:\/|$))/.test(path);
}

export function RecentTasks({ close }: { close?: () => void }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const [tasks, setTasks] = useState<Task[]>([]);
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
  return <SidebarGroup><SidebarGroupLabel>Recent</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{tasks.map(task => <SidebarMenuItem key={task.id}>
    <SidebarMenuButton render={<a href={withCompany(`/tasks/${task.id}`, companyId)} onClick={close} aria-label={`${task.title}, ${taskStatusLabels[task.status]}${task.pullRequest ? `, pull request ${task.pullRequest.state}` : ""}`}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span data-recent-task-status={task.status} className={`inline-flex shrink-0${task.status === "active" ? " animate-spin" : ""}`}><TaskStatusIcon status={task.status} /></span>
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {task.pullRequest ? <RecentPullRequest taskId={task.id} state={task.pullRequest.state} headSha={task.pullRequest.headSha} /> : null}
      </span>
    </a>} isActive={window.location.pathname === `/tasks/${task.id}`} tooltip={task.title} />
    <RecentTaskAgents taskId={task.id} />
  </SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
