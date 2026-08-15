import { useCallback, useEffect, useState, type ReactElement } from "react";

import { readJson, withCompany } from "../../lib/api.js";
import { type ApiTask } from "../../lib/view-shared.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { taskIsProcessing, taskPresentationPhase, TaskStatusIcon } from "./task-status.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { GitPullRequest } from "lucide-react";

function pullRequestStatus(task: ApiTask): { label: string; dotClass: string } | null {
  if (!task.release?.pullRequestNumber) return null;
  const state = task.deliveryGate?.release.state ?? (task.release.isDraft ? "draft" : "ready");
  if (state === "merged") return { label: "merged", dotClass: "bg-emerald-500" };
  if (state === "closed") return { label: "closed", dotClass: "bg-rose-500" };
  if (state === "ready") return { label: "open", dotClass: "bg-blue-500" };
  return { label: "draft", dotClass: "bg-amber-500" };
}

export function recentTasks<T extends { phase: string; updatedAt: string }>(tasks: T[]): T[] {
  return tasks.filter((task) => task.phase !== "cancelled").sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 5);
}

export function showRecentTasks(pathname: string): boolean {
  return pathname !== "/profile" && !pathname.startsWith("/admin") && !/^\/companies\/[^/]+\/settings$/.test(pathname);
}

export function RecentTasks({ close }: { close?: () => void }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const visible = showRecentTasks(window.location.pathname);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const reload = useCallback(async (): Promise<void> => {
    if (!visible || !companyId) return setTasks([]);
    try {
      const result = await readJson<{ tasks: ApiTask[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks`);
      setTasks(recentTasks(result.tasks));
    } catch {
      setTasks([]);
    }
  }, [companyId, visible]);
  useEffect(() => { if (visible) void reload(); }, [reload, visible]);
  useEffect(() => {
    if (!visible) return;
    const events = new EventSource("/api/tasks/events");
    events.addEventListener("invalidate", () => void reload());
    return () => events.close();
  }, [reload, visible]);

  if (!visible || tasks.length === 0) return null;
  return <SidebarGroup><SidebarGroupLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{tasks.map((task) => { const pr = pullRequestStatus(task); const phase = taskPresentationPhase({ phase: task.phase, releaseStatus: task.release?.status, ciOutcome: task.ci?.outcome, allowedCommands: task.allowedCommands }); const processing = taskIsProcessing({ phase: task.phase, agentInvocations: task.agentInvocations, capacityStatus: task.capacity?.status }); return <SidebarMenuItem key={task.id}><SidebarMenuButton render={<a href={withCompany(`/tasks/${encodeURIComponent(task.id)}`, companyId)} onClick={close} aria-label={`${task.title}${pr ? `, pull request ${pr.label}` : ""}`}><span className="flex min-w-0 flex-1 items-center gap-2"><TaskStatusIcon phase={phase} processing={processing} /><span className="min-w-0 flex-1 truncate">{task.title}</span>{pr ? <span className="relative inline-flex size-4 shrink-0 items-center justify-center" title={`Pull request ${pr.label}`}><GitPullRequest aria-hidden="true" className="size-4" /><span aria-hidden="true" className={`absolute bottom-0 right-0 size-1.5 rounded-full ring-2 ring-sidebar ${pr.dotClass}`} /></span> : null}</span></a>} isActive={window.location.pathname === `/tasks/${task.id}`} tooltip={task.title} /></SidebarMenuItem>; })}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
