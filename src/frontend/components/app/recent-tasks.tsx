import { useEffect, useState, type ReactElement } from "react";
import { withCompany } from "../../lib/api.js";
import { readTaskList } from "../../lib/task-list.js";
import type { Task } from "../../../task-contracts.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { useOptionalCompanyContext } from "./company-context.js";

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
  return <SidebarGroup><SidebarGroupLabel>Recent</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{tasks.map(task => <SidebarMenuItem key={task.id}><SidebarMenuButton render={<a href={withCompany(`/tasks/${task.id}`, companyId)} onClick={close}>{task.title}</a>} isActive={window.location.pathname === `/tasks/${task.id}`} tooltip={task.title} /></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
