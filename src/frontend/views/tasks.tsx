import { Collapsible } from ".././components/ui/collapsible.js";
import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from ".././components/ui/breadcrumb.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from ".././components/ui/dropdown-menu.js";
import { Input } from ".././components/ui/input.js";
import { InlineAttachmentPicker } from ".././components/ui/inline-attachment-picker.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from ".././components/ui/select.js";
import { Textarea } from ".././components/ui/textarea.js";
import { Skeleton } from ".././components/ui/skeleton.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { Kanban, KanbanBoard, KanbanColumn, KanbanColumnContent } from ".././components/reui/kanban.js";
import { Badge as ReuiBadge } from ".././components/reui/badge.js";
import { Tabs, TabsList, TabsTrigger } from ".././components/ui/tabs.js";
import { ApplicationFrame } from ".././components/app/application-frame.js";
import { ProfileAvatar } from ".././components/app/profile-avatar.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { getWorkerHealthFailure, useSystemHealth } from ".././components/app/system-health.js";
import { TaskStatus, TaskStatusIcon, taskStatusAppearance } from ".././components/app/task-status.js";
import { isApiError, readJson, withCompany, type CompanyStatus } from ".././lib/api.js";
import { navigate } from ".././lib/navigation.js";
import { ACTIVE_PHASES as activeTaskPhases, BLOCKED_PHASES as blockedTaskPhases, phaseLabel as taskPhaseLabel } from "../../issue-phases.js";
import { CheckCircle2, ChevronRight, CircleDashed, CircleDotDashed, CircleX, Ellipsis, Filter, FolderKanban, Layers3, ListFilter, Plus, Tags, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { relativeTime, reconcileScopedNotFound, taskActionPayload, taskPhases, type ApiAgent, type ApiProject, type ApiTask, type TaskPhase } from "../lib/view-shared.js";
import { TaskDetailsPage, TaskDetailsNotFound, TaskDetailsSkeleton, type PlanRevisionInput, type TaskPlanAction } from "./task-details.js";

async function fileAsImage(file: File): Promise<{ filename: string; mimeType: string; base64: string }> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image"));
    reader.onload = () => resolve({ filename: file.name, mimeType: file.type, base64: String(reader.result).replace(/^data:[^;]+;base64,/, "") });
    reader.readAsDataURL(file);
  });
}

type TaskListFilter = "active" | "backlog" | "all";

function taskListDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return relativeTime(timestamp);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function NewTaskDialog({ open, onOpenChange, companyName, companyStatus, projects, projectId, onProjectChange, agents, roleAgents, onRoleAgentChange, title, onTitleChange, description, onDescriptionChange, images, onAddImages, onRemoveImage, busy, error, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string | undefined;
  companyStatus: CompanyStatus | undefined;
  projects: ApiProject[];
  projectId: string;
  onProjectChange: (projectId: string) => void;
  agents: ApiAgent[];
  roleAgents: { analyst?: string | undefined; implementer?: string | undefined; reviewer?: string | undefined };
  onRoleAgentChange: (role: "analyst" | "implementer" | "reviewer", agentId: string) => void;
  title: string;
  onTitleChange: (title: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  images: Array<{ filename: string; mimeType: string; base64: string }>;
  onAddImages: (files: File[]) => Promise<void>;
  onRemoveImage: (index: number) => void;
  busy: boolean;
  error: string;
  onSubmit: () => Promise<void>;
}): ReactElement {
  const active = companyStatus === "active";
  const agentRoles = ["analyst", "implementer", "reviewer"] as const;
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}>
      <DialogContent className="max-h-[min(85vh,420px)] w-[min(92vw,936px)] max-w-none gap-0 overflow-y-auto rounded-xl p-0 shadow-2xl sm:max-w-[936px]" showCloseButton>
        <DialogHeader className="px-4 py-3 sm:px-5">
          <Breadcrumb>
            <BreadcrumbList className="gap-2 text-sm">
              <BreadcrumbItem>
                <ReuiBadge variant="outline" size="xl" radius="full" className="gap-1.5 bg-background text-foreground">
                  <span className="size-2 rounded-[2px] bg-destructive" aria-hidden="true" />
                  {companyName?.slice(0, 2).toUpperCase() || "FG"}
                </ReuiBadge>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><DialogTitle className="font-normal">New task</DialogTitle></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </DialogHeader>
        {active ? (
          <form className="flex min-h-[310px] flex-col" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
            <div className="px-5 pt-1">
              <Input id="task-title" aria-label="Task title" autoFocus placeholder="Task title" value={title} onChange={(event) => onTitleChange(event.target.value)} className="h-10 border-0 bg-transparent px-0 text-xl font-medium placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-xl" />
              <Textarea id="task-description" aria-label="Task description" placeholder="Add description…" value={description} onChange={(event) => onDescriptionChange(event.target.value)} className="min-h-20 resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none focus-visible:ring-0" />
            </div>
            {error ? <div className="px-5 pb-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
            <div className="mt-auto flex flex-wrap items-end gap-2 px-5 pb-4">
              <InlineAttachmentPicker compact attachments={images.map((image, index) => ({ id: `${image.filename}-${image.base64.length}-${index}`, filename: image.filename, previewUrl: `data:${image.mimeType};base64,${image.base64}` }))} onSelect={onAddImages} onRemove={onRemoveImage} disabled={busy} />
              <Button type="button" variant="outline" size="sm" className="rounded-full px-2.5"><CircleDashed className="size-3.5 text-muted-foreground" />Backlog</Button>
              <Button type="button" variant="outline" size="sm" className="rounded-full px-2.5 text-muted-foreground"><span aria-hidden="true">—</span>Priority</Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" className="rounded-full px-2.5" aria-label="Assignee"><UserRound className="size-3.5 text-muted-foreground" />Assignee</Button>} />
                <DropdownMenuContent align="start" className="w-64">
                  {agentRoles.flatMap((role) => agents.filter((agent) => agent.role === role).map((agent) => <DropdownMenuItem key={`${role}-${agent.id}`} onClick={() => onRoleAgentChange(role, agent.id)}><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span className="min-w-0 flex-1 truncate">{agent.name}</span><span className="text-[11px] text-muted-foreground">{role}</span>{roleAgents[role] === agent.id ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Select value={projectId || null} onValueChange={(value) => onProjectChange(value ?? "")}><SelectTrigger id="task-project" aria-label="Project" size="sm" className="w-auto min-w-0 rounded-full border-border bg-background px-2.5 shadow-none"><FolderKanban className="size-3.5 text-muted-foreground" /><SelectValue placeholder="Project">{(value) => projects.find((project) => project.id === value)?.name ?? (value ? "Unavailable project" : "Project")}</SelectValue></SelectTrigger><SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select>
              <Button type="button" variant="outline" size="sm" className="rounded-full px-2.5 text-muted-foreground"><Tags className="size-3.5" />Labels</Button>
              <Button type="button" variant="outline" size="icon-sm" className="rounded-full" aria-label="More task properties"><Ellipsis className="size-3.5" /></Button>
              <DialogFooter className="ml-auto flex-row items-center gap-2 sm:justify-end">
                <Button type="submit" size="sm" variant="outline" disabled={busy || !projectId || !title.trim() || !description.trim()}>{busy ? "Saving…" : "Create task"}</Button>
              </DialogFooter>
            </div>
          </form>
        ) : <p className="text-xs text-muted-foreground">{companyStatus === "paused" ? "Company paused. New tasks are unavailable." : companyStatus === "archived" ? "Company archived. New tasks are unavailable." : "No active company is available."}</p>}
      </DialogContent>
    </Dialog>
  );
}

export function TasksView({ mode = "tasks" }: { mode?: "tasks" | "board" }): ReactElement {
  const { currentCompany, loading, user, error: companyError, reloadCompanies } = useCompanyContext();
  const { snapshot: healthSnapshot } = useSystemHealth();
  const workerFailure = getWorkerHealthFailure(healthSnapshot);
  const planningUnavailable = workerFailure ? `${workerFailure.label} is unavailable. ${workerFailure.summary}` : "";
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [roleAgentOverrides, setRoleAgentOverrides] = useState<{ analyst?: string; implementer?: string; reviewer?: string }>({});
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [selectedState, setSelected] = useState<ApiTask>();
  const [projectId, setProjectId] = useState("");
  const [boardProjectId, setBoardProjectId] = useState("all");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<Array<{ filename: string; mimeType: string; base64: string }>>([]);
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");
  const [createOpen, setCreateOpen] = useState(() => mode === "tasks" && new URLSearchParams(window.location.search).get("new") === "1");
  const [taskFilter, setTaskFilter] = useState<TaskListFilter>("all");
  const [busy, setBusy] = useState(false);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const selectedRef = useRef<ApiTask | undefined>(undefined);
  const requestToken = useRef(0);
  const companyId = currentCompany?.id ?? "";

  useEffect(() => { selectedRef.current = selectedState; }, [selectedState]);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setError("");
    if (!companyId || loading) { setLoadedCompanyId(""); setProjects([]); setTasks([]); return; }
    try {
      const [projectResult, taskResult, agentResult] = await Promise.all([
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
        readJson<{ tasks: ApiTask[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks`),
        readJson<{ agents: ApiAgent[] }>("/api/agents"),
      ]);
      if (token !== requestToken.current) return;
      setProjects(projectResult.projects); setTasks(taskResult.tasks); setAgents(agentResult.agents);
      setProjectId((current) => projectResult.projects.some((project) => project.id === current && project.status === "active") ? current : projectResult.projects.find((project) => project.status === "active")?.id ?? "");
      const detailPrefix = mode === "board" ? "/board/" : "/tasks/";
      const routeTaskId = window.location.pathname.startsWith(detailPrefix) ? decodeURIComponent(window.location.pathname.slice(detailPrefix.length)) : "";
      const nextSelected = routeTaskId ? taskResult.tasks.find((task) => task.id === routeTaskId) : selectedRef.current ? taskResult.tasks.find((task) => task.id === selectedRef.current!.id) : undefined;
      setSelected(nextSelected);
      setDetailNotFound(Boolean(routeTaskId) && !nextSelected);
      setLoadedCompanyId(companyId);
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      else setError("Unable to load tasks");
    }
  }, [companyId, loading, mode, reloadCompanies]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (mode !== "tasks") return;
    const openNewTask = (): void => { setCreateError(""); setCreateOpen(true); };
    window.addEventListener("forge:new-task", openNewTask);
    const url = new URL(window.location.href);
    if (url.searchParams.get("new") === "1") {
      openNewTask();
      url.searchParams.delete("new");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return () => window.removeEventListener("forge:new-task", openNewTask);
  }, [mode]);
  useEffect(() => {
    selectedRef.current = undefined;
    setSelected(undefined); setProjectId(""); setRoleAgentOverrides({}); setTitle(""); setDescription(""); setImages([]); setCreateError(""); setDetailNotFound(false);
  }, [companyId]);
  useEffect(() => {
    const events = new EventSource("/api/tasks/events");
    events.addEventListener("ready", () => void reload());
    events.addEventListener("invalidate", () => void reload());
    return () => events.close();
  }, [reload]);

  const scopeLoaded = Boolean(companyId) && loadedCompanyId === companyId;
  const routeBase = mode === "board" ? "/board" : "/tasks";
  const detailPrefix = `${routeBase}/`;
  const routeTaskId = window.location.pathname.startsWith(detailPrefix) ? decodeURIComponent(window.location.pathname.slice(detailPrefix.length)) : "";
  const visibleProjects = scopeLoaded ? projects : [];
  const visibleTasks = scopeLoaded ? tasks : [];
  const boardTasks = boardProjectId === "all" ? visibleTasks : visibleTasks.filter((task) => task.projectId === boardProjectId);
  const taskBoard = Object.fromEntries(taskPhases.map((phase) => [phase, boardTasks.filter((task) => task.phase === phase)])) as Record<(typeof taskPhases)[number], ApiTask[]>;
  const selected = scopeLoaded ? selectedState : undefined;
  const availableProjects = visibleProjects.filter((project) => project.companyId === companyId && project.status === "active");
  const newTaskProject = availableProjects.find((project) => project.id === projectId);
  const newTaskRoleAgents = {
    analyst: roleAgentOverrides.analyst ?? newTaskProject?.roleDefaults.analyst,
    implementer: roleAgentOverrides.implementer ?? newTaskProject?.roleDefaults.implementer,
    reviewer: roleAgentOverrides.reviewer ?? newTaskProject?.roleDefaults.reviewer,
  };
  const activeCount = visibleTasks.filter((task) => activeTaskPhases.has(task.phase)).length;
  const backlogCount = visibleTasks.filter((task) => task.phase === "backlog").length;
  const taskGroups = [
    { id: "active", title: "In progress", phases: activeTaskPhases, tasks: visibleTasks.filter((task) => activeTaskPhases.has(task.phase)) },
    { id: "backlog", title: "Backlog", phases: new Set<TaskPhase>(["backlog"]), tasks: visibleTasks.filter((task) => task.phase === "backlog") },
    { id: "blocked", title: "Blocked", phases: blockedTaskPhases, tasks: visibleTasks.filter((task) => blockedTaskPhases.has(task.phase)) },
    { id: "completed", title: "Completed", phases: new Set<TaskPhase>(["done", "cancelled"]), tasks: visibleTasks.filter((task) => task.phase === "done" || task.phase === "cancelled") },
  ].filter((group) => taskFilter === "all" ? group.tasks.length > 0 : group.id === taskFilter).map((group) => ({ ...group, tasks: [...group.tasks].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)) }));
  const selectTask = (task: ApiTask): void => { setSelected(task); selectedRef.current = task; setDetailNotFound(false); window.history.pushState({}, "", withCompany(`${routeBase}/${encodeURIComponent(task.id)}`, companyId)); };
  const addImages = async (files: File[]): Promise<void> => {
    setCreateError("");
    if (images.length + files.length > 8) { setCreateError("At most eight images may be attached"); return; }
    if (files.some((file) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))) { setCreateError("Only PNG, JPEG, WebP, and GIF images are accepted"); return; }
    if (files.some((file) => file.size > 9_000_000)) { setCreateError("Each image must be smaller than 9 MB"); return; }
    try { const nextImages = await Promise.all(files.map(fileAsImage)); setImages((current) => [...current, ...nextImages]); }
    catch { setCreateError("Unable to read image"); }
  };
  const create = async (): Promise<void> => {
    if (!companyId || currentCompany?.status !== "active") return;
    setBusy(true); setCreateError(""); setError("");
    try {
      const result = await readJson<ApiTask>(`/api/companies/${companyId}/tasks`, { method: "POST", body: JSON.stringify({ projectId, title, description, images, roleAgents: newTaskRoleAgents, idempotencyKey: crypto.randomUUID() }) });
      const taskPath = withCompany(`/tasks/${encodeURIComponent(result.id)}`, companyId);
      if (result.allowedCommands.includes("start_planning")) {
        if (planningUnavailable) { navigate(taskPath); setError(planningUnavailable); return; }
        try {
          await readJson<ApiTask>(`/api/tasks/${encodeURIComponent(result.id)}/start-planning`, { method: "POST", body: JSON.stringify({ expectedRevision: result.revision }) });
        } catch (reason) {
          navigate(taskPath);
          setError(reason instanceof Error ? reason.message : "Unable to start planning");
          return;
        }
      }
      navigate(taskPath);
    } catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setCreateError(reason instanceof Error ? reason.message : "Unable to create task"); }
    finally { setBusy(false); }
  };
  const startPlanning = async (): Promise<void> => {
    if (!selected) return;
    if (planningUnavailable) { setError(planningUnavailable); return; }
    setBusy(true); setError("");
    const optimistic: ApiTask = { ...selected, phase: "planning", revision: selected.revision + 1, owner: "lead", allowedCommands: [], pendingAction: "Analyst planning" };
    selectedRef.current = optimistic; setSelected(optimistic); setTasks((current) => current.map((task) => task.id === optimistic.id ? optimistic : task));
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/start-planning`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision }) }); selectedRef.current = updated; setSelected(updated); setTasks((current) => current.map((task) => task.id === updated.id ? updated : task)); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to start planning"); }
    finally { setBusy(false); }
  };
  const planAction = async (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/${path}`, { method: "POST", body: JSON.stringify(taskActionPayload(selected.revision, note, payload)) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      const staleRevision = isApiError(reason, 409);
      if (staleRevision) { await reload(); throw reason; }
      setError(staleRevision ? "Issue changed; the latest state was loaded." : reason instanceof Error ? reason.message : "Unable to update the plan");
    }
    finally { setBusy(false); }
  };
  const markReady = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/mark-ready`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision }) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to mark the pull request ready"); }
    finally { setBusy(false); }
  };
  const revisePlan = async (input: PlanRevisionInput): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/revise-plan`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision, ...input }) });
      selectedRef.current = updated; setSelected(updated); setTasks((current) => current.map((task) => task.id === updated.id ? updated : task)); await reload();
    } catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to revise the plan"); }
    finally { setBusy(false); }
  };
  const continueWork = async (reason: string): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const result = await readJson<{ original: ApiTask; successor: ApiTask }>(`/api/tasks/${selected.id}/continue-work`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision, reason }) });
      const successorPath = `${routeBase}/${encodeURIComponent(result.successor.id)}`;
      window.history.pushState({}, "", withCompany(successorPath, companyId));
      selectedRef.current = result.successor; setSelected(result.successor); setTasks((current) => [...current.filter((task) => task.id !== result.successor.id), result.successor]); await reload();
    } catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to continue work"); }
    finally { setBusy(false); }
  };
  const resolveDecisionBlocker = async (answer: string): Promise<void> => {
    if (!selected || !answer.trim()) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/resolve-decision-blocker`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision, answer }) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setError(reason instanceof Error ? reason.message : "Unable to resolve the decision blocker"); }
    finally { setBusy(false); }
  };

  if (routeTaskId && loading) return <TaskDetailsSkeleton />;
  if (routeTaskId && !companyId) return <TaskDetailsNotFound companyId="" returnTo={mode} />;
  if (routeTaskId && !scopeLoaded && !error) return <TaskDetailsSkeleton />;
  if (routeTaskId && !scopeLoaded && error) return <ApplicationFrame title="Unable to load task"><div className="px-4 py-8 sm:px-6 lg:px-10"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div></ApplicationFrame>;
  if (routeTaskId && (!selected || detailNotFound)) return <TaskDetailsNotFound companyId={companyId} returnTo={mode} />;
  if (routeTaskId && selected) return <TaskDetailsPage task={selected} project={visibleProjects.find((project) => project.id === selected.projectId)} companyId={companyId} busy={busy} error={error} isAdmin={user?.role === "admin"} onStartPlanning={startPlanning} onPlanAction={planAction} onRevisePlan={revisePlan} onContinueWork={continueWork} onResolveDecisionBlocker={resolveDecisionBlocker} onMarkReady={markReady} onRefresh={reload} />;

  if (mode === "board") {
    return (
      <ApplicationFrame title="Board" headerRight={<span className="text-[11px] text-muted-foreground">Read-only state</span>}>
        <div className="flex h-[calc(100vh-2.5rem)] min-h-0 flex-col border-t border-border/70 bg-background">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-3 sm:px-4">
            <div className="flex items-center gap-2">
              <Select value={boardProjectId} onValueChange={(value) => setBoardProjectId(value ?? "all")}>
                <SelectTrigger aria-label="Filter board by project" className="h-7 w-auto min-w-28 rounded-full border-border bg-background px-2.5 text-xs shadow-none">
                  <SelectValue>{(value) => value === "all" ? "All projects" : visibleProjects.find((project) => project.id === value)?.name ?? "All projects"}</SelectValue>
                </SelectTrigger>
                <SelectContent><SelectItem value="all">All projects</SelectItem>{visibleProjects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
              </Select>
              <Layers3 className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label="Filter board" title="Filter board"><Filter className="size-3.5" /></Button>
              <Button variant="outline" size="icon-sm" aria-label="Board display options" title="Board display options"><ListFilter className="size-3.5" /></Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-2">
            <Kanban value={taskBoard} onValueChange={() => {}} getItemValue={(task) => task.id} className="h-full">
              <KanbanBoard className="h-full min-w-max grid-flow-col auto-cols-[286px] grid-cols-none gap-2">
                {taskPhases.map((phase) => {
                  return <KanbanColumn disabled key={phase} value={phase} className="min-h-0 rounded-md bg-muted/45">
                    <div className="flex h-10 shrink-0 items-center justify-between px-3 text-xs">
                      <div className="flex min-w-0 items-center gap-2"><TaskStatus phase={phase} /><span className="text-muted-foreground">{taskBoard[phase].length}</span></div>
                      <div className="flex items-center gap-0.5 text-muted-foreground"><Button variant="ghost" size="icon-sm" className="size-6" aria-label={`${taskPhaseLabel(phase)} options`}><Ellipsis className="size-3.5" /></Button><Button render={<a href={withCompany("/tasks", companyId)} />} variant="ghost" size="icon-sm" className="size-6" aria-label="Create task"><Plus className="size-3.5" /></Button></div>
                    </div>
                    <KanbanColumnContent value={phase} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                      {taskBoard[phase].map((task) => {
                        const project = visibleProjects.find((candidate) => candidate.id === task.projectId);
                        return <button type="button" className="block w-full rounded-md border border-border/90 bg-card px-3 py-2.5 text-left text-xs transition-colors hover:border-muted-foreground/35 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring" key={task.id} onClick={() => selectTask(task)}>
                          <span className="block font-medium leading-4 text-card-foreground">{task.issueKey ? <span className="mr-1.5 font-normal text-muted-foreground">{task.issueKey}</span> : null}{task.title}</span>
                          {task.pendingAction ? <span className="mt-1 block truncate text-[11px] leading-4 text-muted-foreground">{task.pendingAction}</span> : null}
                          <span className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Layers3 className="size-3" />{project?.name ?? "Unknown project"}</span>
                        </button>;
                      })}
                    </KanbanColumnContent>
                  </KanbanColumn>;
                })}
              </KanbanBoard>
            </Kanban>
          </div>
          {detailNotFound ? <div className="border-t border-border/70 px-4 py-3 text-xs text-muted-foreground">Task not found for this company.</div> : null}
        </div>
      </ApplicationFrame>
    );
  }

  return (
    <ApplicationFrame title="Tasks">
      <div data-task-list className="min-h-[calc(100vh-2.5rem)] border-t border-border/70 bg-background text-foreground">
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/70 px-3 py-1 sm:px-4">
          <Tabs value={taskFilter} onValueChange={(value) => setTaskFilter(value as TaskListFilter)}>
            <TabsList>
              <TabsTrigger value="active">Active <span className="text-[11px] text-muted-foreground">{activeCount}</span></TabsTrigger>
              <TabsTrigger value="backlog">Backlog <span className="text-[11px] text-muted-foreground">{backlogCount}</span></TabsTrigger>
              <TabsTrigger value="all">All tasks <span className="text-[11px] text-muted-foreground">{visibleTasks.length}</span></TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {error ? <div className="p-3 sm:p-4"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        {!scopeLoaded && !error ? <div className="space-y-px p-2" aria-label="Loading tasks" aria-busy="true"><Skeleton className="h-8 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div> : null}
        {scopeLoaded && taskGroups.length === 0 ? <div className="px-4 py-8 text-xs text-muted-foreground">{taskFilter === "active" ? "No active tasks." : taskFilter === "backlog" ? "No backlog tasks." : "No tasks yet. Press ⌘N to create one."}</div> : null}
        {scopeLoaded ? <div aria-label="Task groups" className="py-1">
          {taskGroups.map((group) => {
            const GroupIcon = group.id === "completed" ? CheckCircle2 : group.id === "blocked" ? CircleX : group.id === "active" ? CircleDotDashed : CircleDashed;
            const groupIconClass = group.id === "completed" ? "text-emerald-500" : group.id === "blocked" ? "text-rose-500" : group.id === "active" ? "text-amber-500" : "text-muted-foreground";
            return (
              <Collapsible.Root key={group.id} defaultOpen className="group/task-group pt-1">
                <Collapsible.Trigger className="mx-2 flex h-9 w-[calc(100%-1rem)] items-center gap-2 rounded-md bg-muted/60 px-2 text-left text-xs outline-none transition-colors hover:bg-muted/80 focus-visible:ring-1 focus-visible:ring-ring/50">
                  <ChevronRight className="size-3 text-muted-foreground transition-transform group-data-[open]/task-group:rotate-90" />
                  <GroupIcon className={`size-3.5 ${groupIconClass}`} />
                  <span className="font-medium">{group.title}</span>
                  <span className="text-muted-foreground">{group.tasks.length}</span>
                </Collapsible.Trigger>
                <Collapsible.Panel className="pt-0.5">
                  {group.tasks.map((task) => {
                    const project = visibleProjects.find((candidate) => candidate.id === task.projectId);
                    const appearance = taskStatusAppearance(task.phase);
                    return (
                      <a data-task-row key={task.id} href={withCompany(`/tasks/${encodeURIComponent(task.id)}`, companyId)} className="group/task-row grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 text-[13px] outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:px-4">
                        <TaskStatusIcon phase={task.phase} />
                        <span className="flex min-w-0 items-center gap-2">
                          {task.issueKey ? <span className="shrink-0 text-xs text-muted-foreground">{task.issueKey}</span> : null}
                          <span className="truncate font-medium">{task.title}</span>
                          {project ? <><ChevronRight className="hidden size-3 shrink-0 text-muted-foreground/60 md:block" /><span className="hidden truncate text-xs text-muted-foreground md:block">{project.name}</span></> : null}
                        </span>
                        <span className="hidden sm:inline-flex"><ReuiBadge variant={appearance.badge} size="sm" radius="full">{taskPhaseLabel(task.phase)}</ReuiBadge></span>
                        <time dateTime={task.updatedAt} className="w-16 text-right text-[11px] text-muted-foreground">{taskListDate(task.updatedAt)}</time>
                      </a>
                    );
                  })}
                </Collapsible.Panel>
              </Collapsible.Root>
            );
          })}
        </div> : null}
        {!currentCompany && scopeLoaded ? <div className="px-4 py-8 text-xs text-muted-foreground">{loading ? "Loading companies" : companyError ? "Unable to load companies" : user?.role === "admin" ? "Create a company to begin." : "No company access. Ask an administrator to assign a company."}</div> : null}
        <NewTaskDialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (open) setCreateError(""); }} companyName={currentCompany?.name} companyStatus={currentCompany?.status} projects={availableProjects} projectId={projectId} onProjectChange={(nextProjectId) => { setProjectId(nextProjectId); setRoleAgentOverrides({}); }} agents={agents} roleAgents={newTaskRoleAgents} onRoleAgentChange={(role, agentId) => setRoleAgentOverrides((current) => ({ ...current, [role]: agentId }))} title={title} onTitleChange={setTitle} description={description} onDescriptionChange={setDescription} images={images} onAddImages={addImages} onRemoveImage={(index) => setImages((current) => current.filter((_, candidate) => candidate !== index))} busy={busy} error={createError} onSubmit={create} />
      </div>
    </ApplicationFrame>
  );
}
