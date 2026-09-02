import { useCallback, useEffect, useState, type ReactElement } from "react";

import { withCompany } from "../../lib/api.js";
import { readTaskList, subscribeTaskListInvalidations } from "../../lib/task-list.js";
import { type ApiAgentRuntime, type ApiTaskSummary } from "../../lib/view-shared.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { taskIsProcessing, TaskStatusIcon } from "./task-status.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { GitPullRequest } from "lucide-react";
import { liveTaskPanes, runtimeStatusLabel } from "./runtime-presentation.js";

function pullRequestStatus(task: ApiTaskSummary): { label: string; dotClass: string } | null {
  if (!task.release?.pullRequestNumber) return null;
  const state = task.deliveryGate?.release.state ?? (task.release.isDraft ? "draft" : "ready");
  if (state === "merged") return { label: "merged", dotClass: "bg-emerald-500" };
  if (state === "closed") return { label: "closed", dotClass: "bg-rose-500" };
  if (state === "ready") return { label: "open", dotClass: "bg-blue-500" };
  return { label: "draft", dotClass: "bg-amber-500" };
}

export function recentTasks<T extends { phase: string; updatedAt: string }>(tasks: T[]): T[] {
  return tasks.filter((task) => task.phase !== "cancelled").sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 10);
}

export function showRecentTasks(pathname: string): boolean {
  return pathname !== "/profile" && !pathname.startsWith("/admin") && !/^\/companies\/[^/]+\/settings$/.test(pathname);
}


export function RecentTasks({ close, runtime }: { close?: () => void; runtime: ApiAgentRuntime[] }): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const visible = showRecentTasks(window.location.pathname);
  const [tasks, setTasks] = useState<ApiTaskSummary[]>([]);
  const reload = useCallback(async (): Promise<void> => {
    if (!visible || !companyId) return setTasks([]);
    try {
      setTasks(recentTasks(await readTaskList(companyId)));
    } catch {
      setTasks([]);
    }
  }, [companyId, visible]);
  useEffect(() => { if (visible) void reload(); }, [reload, visible]);
  useEffect(() => {
    if (!visible || !companyId) return;
    return subscribeTaskListInvalidations(companyId, () => void reload());
  }, [companyId, reload, visible]);

  if (!visible || tasks.length === 0) return null;
  return <SidebarGroup><SidebarGroupLabel>Recent</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{tasks.map((task) => {
    const pr = pullRequestStatus(task);
    const processing = taskIsProcessing({ phase: task.phase, blocked: task.blocked, agentInvocations: task.agentInvocations, capacityStatus: task.capacity?.status });
    const panes = liveTaskPanes(task.id, runtime);
    return <SidebarMenuItem key={task.id}>
      <SidebarMenuButton render={<a href={withCompany(`/tasks/${encodeURIComponent(task.id)}`, companyId)} onClick={close} aria-label={`${task.title}${pr ? `, pull request ${pr.label}` : ""}`}><span className="flex min-w-0 flex-1 items-center gap-2"><TaskStatusIcon phase={task.phase} blocked={task.blocked} processing={processing} pullRequestState={task.githubPullRequest?.state} /><span className="min-w-0 flex-1 truncate">{task.title}</span>{pr ? <span className="relative inline-flex size-4 shrink-0 items-center justify-center" title={`Pull request ${pr.label}`}><GitPullRequest aria-hidden="true" className="size-4" /><span aria-hidden="true" className={`absolute bottom-0 right-0 size-1.5 rounded-full ring-2 ring-sidebar ${pr.dotClass}`} /></span> : null}</span></a>} isActive={window.location.pathname === `/tasks/${task.id}`} tooltip={task.title} />
      {panes.length ? <ul className="ml-6 min-w-0">{panes.map((pane) => <li key={`${pane.role}-${pane.paneId}`} data-live-pane-row={pane.paneId} title={`${pane.role}: ${runtimeStatusLabel(pane)}`} className="flex h-6 min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${pane.diagnosis === "working" ? "bg-emerald-500" : pane.diagnosis === "blocked" ? "bg-amber-500" : "bg-muted-foreground"}`} /><span className="min-w-0 truncate">{pane.role} · {runtimeStatusLabel(pane)}</span></li>)}</ul> : null}
    </SidebarMenuItem>;
  })}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
