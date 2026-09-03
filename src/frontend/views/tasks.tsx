import { Collapsible } from ".././components/ui/collapsible.js";
import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button, buttonVariants } from ".././components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from ".././components/ui/avatar.js";
import { Checkbox } from ".././components/ui/checkbox.js";
import { RadioGroup, RadioGroupItem } from ".././components/ui/radio-group.js";
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
import { ACTIVE_INVOCATION_STATUSES, LiveStatusDot, TaskStatus, TaskStatusIcon, taskStatusAppearance, taskStatusLabel } from ".././components/app/task-status.js";
import { isApiError, readJson, withCompany, type CompanyStatus } from ".././lib/api.js";
import { invalidateTaskList, readTaskList, subscribeTaskListInvalidations } from ".././lib/task-list.js";
import { navigate } from ".././lib/navigation.js";
import { taskListGroups, type TaskListFilter } from "../lib/task-list-groups.js";
import { ACTIVE_PHASES as activeTaskPhases, phaseLabel as taskPhaseLabel } from "../../issue-phases.js";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, CircleDotDashed, CircleSlash, CircleX, Ellipsis, FileText, Filter, FolderKanban, Layers3, ListFilter, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactElement } from "react";
import { relativeTime, reconcileScopedNotFound, taskActionPayload, taskPhases, type ApiAgent, type ApiCompanyBranchSync, type ApiProject, type ApiTask, type ApiTaskSummary, type ApiTaskTemplate } from "../lib/view-shared.js";
import { TaskDetailsPage, TaskDetailsNotFound, TaskDetailsSkeleton, type PlanRevisionInput, type TaskPlanAction } from "./task-details.js";
import { prefillForTaskSource, preserveEditedPrefill, TaskSourcePicker, type TaskSourceSelector, type TaskSourceSummary } from "../components/app/task-source-picker.js";
import { TaskRoleSelectors } from "../components/app/task-role-selectors.js";
import { taskDeliveryTargetOptions } from "../components/app/task-delivery-target.js";
import { newTaskFormSettings, readNewTaskMemory, resolveNewTaskProjectId, writeNewTaskMemory, type NewTaskMemory } from "../components/app/new-task-memory.js";
import { newTaskImageError } from "../components/app/new-task-images.js";
import { duplicateTaskDraft } from "../lib/duplicate-task-prefill.js";
import { findForgeProject, fixTaskDraft, type TaskDiagnostics } from "../lib/fix-task-prefill.js";

async function fileAsImage(file: File): Promise<{ filename: string; mimeType: string; base64: string }> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image"));
    reader.onload = () => resolve({ filename: file.name || `pasted-image.${file.type.split("/")[1] ?? "png"}`, mimeType: file.type, base64: String(reader.result).replace(/^data:[^;]+;base64,/, "") });
    reader.readAsDataURL(file);
  });
}

function taskListDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return relativeTime(timestamp);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
export function NewTaskDialog({ open, onOpenChange, companyStatus, projects, projectId, onProjectChange, sourceSummary, onSourceSelect, onSourceClear, agents, roleAgents, onRoleAgentChange, onApplyTemplate, title, onTitleChange, description, onDescriptionChange, autoApprovePlan, onAutoApprovePlanChange, startImmediately, onStartImmediatelyChange, deliveryTarget, onDeliveryTargetChange, runProjectTests, onRunProjectTestsChange, visualEvidence, onVisualEvidenceChange, supplementalReview, onSupplementalReviewChange, images, onAddImages, onRemoveImage, busy, error, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyStatus: CompanyStatus | undefined;
  projects: ApiProject[];
  projectId: string;
  onProjectChange: (projectId: string) => void;
  sourceSummary?: TaskSourceSummary | undefined;
  onSourceSelect: (summary: TaskSourceSummary, selector: TaskSourceSelector) => void;
  onSourceClear: () => void;
  agents: ApiAgent[];
  roleAgents: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  onRoleAgentChange: (role: "planner" | "builder" | "reviewer" | "integrator", agentId: string) => void;
  onApplyTemplate: (template: ApiTaskTemplate) => Promise<void>;
  title: string;
  onTitleChange: (title: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  autoApprovePlan: boolean;
  onAutoApprovePlanChange: (autoApprovePlan: boolean) => void;
  startImmediately: boolean;
  onStartImmediatelyChange: (startImmediately: boolean) => void;
  deliveryTarget: "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged";
  onDeliveryTargetChange: (deliveryTarget: "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged") => void;
  runProjectTests: boolean;
  onRunProjectTestsChange: (value: boolean) => void;
  visualEvidence: "off" | "capture" | "required";
  onVisualEvidenceChange: (value: "off" | "capture" | "required") => void;
  supplementalReview: boolean;
  onSupplementalReviewChange: (value: boolean) => void;
  images: Array<{ filename: string; mimeType: string; base64: string }>;
  onAddImages: (files: File[]) => Promise<void>;
  onRemoveImage: (index: number) => void;
  busy: boolean;
  error: string;
  onSubmit: () => Promise<void>;
}): ReactElement {
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const loadTemplates = useCallback(async (): Promise<void> => { if (open && projectId) setTemplates((await readJson<{ templates: ApiTaskTemplate[] }>(`/api/projects/${encodeURIComponent(projectId)}/task-templates`)).templates); }, [open, projectId]);
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);
  const active = companyStatus === "active";
  const project = projects.find((candidate) => candidate.id === projectId);
  const hasProjectTests = Boolean(project?.verificationCommand.trim());
  const canSupplementalReview = Boolean(project?.roleDefaults.reviewer && roleAgents.reviewer);
  const pasteImages = (event: ClipboardEvent<HTMLFormElement>): void => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length || busy) return;
    event.preventDefault();
    void onAddImages(files);
  };
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}>
      <DialogContent className="max-h-[min(85vh,420px)] w-[min(92vw,936px)] max-w-none gap-0 overflow-y-auto rounded-xl p-0 shadow-2xl sm:max-w-[936px]" showCloseButton={false}>
        <DialogHeader className="flex-row items-center justify-between px-4 py-3 sm:px-5">
          <Breadcrumb>
            <BreadcrumbList className="gap-2 text-sm">
              <BreadcrumbItem>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" aria-label="Project" disabled={busy || projects.length === 0} />}>
                    {project ? <Avatar size="xs" shape="square"><AvatarImage src={`/api/projects/${project.id}/favicon`} alt="" /><AvatarFallback>{project.name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar> : <FolderKanban className="size-3.5 text-muted-foreground" />}
                    <span className="max-w-40 truncate">{project?.name ?? "Project"}</span>
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {projects.map((candidate) => <DropdownMenuItem key={candidate.id} onClick={() => onProjectChange(candidate.id)}><Avatar size="xs" shape="square"><AvatarImage src={`/api/projects/${candidate.id}/favicon`} alt="" /><AvatarFallback>{candidate.name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="min-w-0 flex-1 truncate">{candidate.name}</span>{candidate.id === projectId ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><DialogTitle className="font-normal">New task</DialogTitle></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex items-center gap-1"><TaskSourcePicker projectId={projectId} value={sourceSummary} disabled={busy} onSelect={onSourceSelect} onClear={onSourceClear} />{templates.length ? <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={busy} />}><FileText className="size-3.5" />Template</DropdownMenuTrigger><DropdownMenuContent align="end">{templates.map((template) => <DropdownMenuItem key={template.id} onClick={() => void onApplyTemplate(template)}>{template.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu> : null}</div>
        </DialogHeader>
        {active ? (
          <form className="flex min-h-[310px] flex-col" onPaste={pasteImages} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
            <div className="px-5 pt-1">
              <Input id="task-title" aria-label="Task title" autoFocus placeholder="Task title" value={title} onChange={(event) => onTitleChange(event.target.value)} className="h-10 border-0 bg-transparent px-0 text-xl font-medium placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-xl" />
              <Textarea id="task-description" aria-label="Task description" placeholder="Add description…" value={description} onChange={(event) => onDescriptionChange(event.target.value)} className="min-h-20 resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none focus-visible:ring-0" />
            </div>
            {error ? <div className="px-5 pb-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
            <div className="mt-auto flex flex-wrap items-end gap-2 px-5 pb-4">
              <InlineAttachmentPicker compact attachments={images.map((image, index) => ({ id: `${image.filename}-${image.base64.length}-${index}`, filename: image.filename, previewUrl: `data:${image.mimeType};base64,${image.base64}` }))} onSelect={onAddImages} onRemove={onRemoveImage} disabled={busy} />
              <TaskRoleSelectors agents={agents} assignments={roleAgents} deliveryTarget={deliveryTarget} supplementalReview={supplementalReview} busy={busy} onChange={onRoleAgentChange} />
              <Button type="button" variant="outline" size="icon-sm" className="rounded-full" aria-label="More task properties"><Ellipsis className="size-3.5" /></Button>
              <DialogFooter className="ml-auto flex-row items-center gap-2 sm:justify-end">
                <Button type="submit" size="sm" disabled={busy || !projectId || !title.trim() || !description.trim()} title="Create task (⌘Enter)">{busy ? "Saving…" : "Create task"}</Button>
              </DialogFooter>
            </div>
            <fieldset className="border-t border-border/70 bg-muted/30 px-5 py-3">
              <legend className="px-0 text-xs font-medium text-muted-foreground">Delivery &amp; checks</legend>
              <RadioGroup aria-label="Delivery target" value={deliveryTarget} onValueChange={(value) => { if (["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"].includes(value)) onDeliveryTargetChange(value as typeof deliveryTarget); }} className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
                {taskDeliveryTargetOptions.map(({ value, label }) => <label className="flex items-center gap-1.5 text-xs" key={value}><RadioGroupItem value={value} />{label}</label>)}
              </RadioGroup>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-2.5 text-xs">
                <label className="flex cursor-pointer items-center gap-2"><Checkbox id="task-start-immediately" checked={startImmediately} onCheckedChange={(checked) => onStartImmediatelyChange(checked === true)} />Start immediately</label>
                <label className="flex cursor-pointer items-center gap-2"><Checkbox id="task-auto-approve-plan" checked={autoApprovePlan} onCheckedChange={(checked) => onAutoApprovePlanChange(checked === true)} />Auto-approve plan</label>
                {hasProjectTests ? <label className="flex items-center gap-2"><Checkbox checked={runProjectTests} onCheckedChange={(checked) => onRunProjectTestsChange(checked === true)} />Run project tests</label> : <span className="text-muted-foreground">No project test command configured.</span>}
                {canSupplementalReview ? <label className="flex items-center gap-2"><Checkbox checked={supplementalReview} onCheckedChange={(checked) => onSupplementalReviewChange(checked === true)} />Second review</label> : null}
                <label className="flex items-center gap-2">Screenshots <Select value={visualEvidence} onValueChange={(value) => { if (value === "off" || value === "capture" || value === "required") onVisualEvidenceChange(value); }}><SelectTrigger aria-label="Screenshots" size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Reviewer flags missing screenshots</SelectItem></SelectContent></Select></label>
              </div>
            </fieldset>
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
  const remembered = useRef(readNewTaskMemory());
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [roleAgentOverrides, setRoleAgentOverrides] = useState<{ planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined }>(remembered.current.roleAgents);
  const [tasks, setTasks] = useState<ApiTaskSummary[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [selectedState, setSelected] = useState<ApiTask>();
  const [projectId, setProjectId] = useState(remembered.current.projectId ?? "");
  const [boardProjectId, setBoardProjectId] = useState("all");
  const [hideEmptyColumns, setHideEmptyColumns] = useState(() => {
    try { return localStorage.getItem("forge.board.hideEmptyColumns") !== "false"; }
    catch { return true; }
  });
  const [showArchived, setShowArchived] = useState(() => {
    try { return localStorage.getItem("forge.board.showArchived") === "true"; }
    catch { return false; }
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<TaskSourceSelector>();
  const [sourceSummary, setSourceSummary] = useState<TaskSourceSummary>();
  const sourcePrefill = useRef({ title: "", description: "" });
  const [autoApprovePlan, setAutoApprovePlan] = useState(remembered.current.autoApprovePlan);
  const [startImmediately, setStartImmediately] = useState(remembered.current.startImmediately);
  const [deliveryTarget, setDeliveryTarget] = useState<"local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged">(remembered.current.deliveryTarget);
  const [runProjectTests, setRunProjectTests] = useState(remembered.current.runProjectTests);
  const [visualEvidence, setVisualEvidence] = useState<"off" | "capture" | "required">(remembered.current.visualEvidence);
  const [supplementalReview, setSupplementalReview] = useState(remembered.current.supplementalReview);
  const [images, setImages] = useState<Array<{ filename: string; mimeType: string; base64: string }>>([]);
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");
  const [createOpen, setCreateOpen] = useState(() => mode === "tasks" && new URLSearchParams(window.location.search).get("new") === "1");
  const [taskFilter, setTaskFilter] = useState<TaskListFilter>("all");
  const [branchSync, setBranchSync] = useState<ApiCompanyBranchSync>({});
  const [busy, setBusy] = useState(false);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const selectedRef = useRef<ApiTask | undefined>(undefined);
  const requestToken = useRef(0);
  const taskListToken = useRef(0);
  const companyId = currentCompany?.id ?? "";
  const routeBase = mode === "board" ? "/board" : "/tasks";
  const detailPrefix = `${routeBase}/`;
  const routeTaskId = window.location.pathname.startsWith(detailPrefix) ? decodeURIComponent(window.location.pathname.slice(detailPrefix.length)) : "";
  const resetNewTaskSettings = (): void => {
    const settings = newTaskFormSettings(remembered.current);
    setAutoApprovePlan(settings.autoApprovePlan); setStartImmediately(settings.startImmediately); setDeliveryTarget(settings.deliveryTarget); setRunProjectTests(settings.runProjectTests); setVisualEvidence(settings.visualEvidence); setSupplementalReview(settings.supplementalReview); setRoleAgentOverrides(settings.roleAgents);
  };

  useEffect(() => { selectedRef.current = selectedState; }, [selectedState]);
  useEffect(() => {
    try { localStorage.setItem("forge.board.hideEmptyColumns", String(hideEmptyColumns)); }
    catch { /* Local storage may be unavailable. */ }
  }, [hideEmptyColumns]);
  useEffect(() => {
    try { localStorage.setItem("forge.board.showArchived", String(showArchived)); }
    catch { /* Local storage may be unavailable. */ }
  }, [showArchived]);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    taskListToken.current += 1;
    setError("");
    if (!companyId || loading) { setLoadedCompanyId(""); setProjects([]); setTasks([]); return; }
    try {
      const [projectResult, taskResult, agentResult] = await Promise.all([
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
        readTaskList(companyId, taskFilter === "archived"),
        readJson<{ agents: ApiAgent[] }>("/api/agents"),
      ]);
      if (token !== requestToken.current) return;
      setProjects(projectResult.projects); setTasks(taskResult); setAgents(agentResult.agents);
      setProjectId((current) => resolveNewTaskProjectId(current || remembered.current.projectId, projectResult.projects));
      setRoleAgentOverrides((current) => Object.fromEntries(Object.entries(current).filter(([, id]) => !id || agentResult.agents.some((agent) => agent.id === id))));
      // The list is only one visibility slice (for example, active or archived).
      // Let the authoritative detail request decide whether a routed task exists.
      setDetailNotFound(false);
      setLoadedCompanyId(companyId);
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      else setError("Unable to load tasks");
    }
  }, [companyId, loading, mode, reloadCompanies, taskFilter]);
  useEffect(() => { void reload(); }, [reload]);
  const activeTaskKey = tasks.filter((task) => activeTaskPhases.has(task.phase)).map((task) => task.id).sort().join(",");
  useEffect(() => {
    if (!companyId || !loadedCompanyId || loadedCompanyId !== companyId || !activeTaskKey) { setBranchSync({}); return; }
    let cancelled = false;
    const refresh = () => {
      void readJson<ApiCompanyBranchSync>(`/api/companies/${encodeURIComponent(companyId)}/branch-sync`).then((value) => { if (!cancelled) setBranchSync(value); }).catch(() => { if (!cancelled) setBranchSync({}); });
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [companyId, loadedCompanyId, activeTaskKey]);
  useEffect(() => {
    if (!companyId || !routeTaskId || !loadedCompanyId || detailNotFound) return;
    let cancelled = false;
    setSelected(undefined);
    void readJson<ApiTask>(`/api/tasks/${encodeURIComponent(routeTaskId)}`).then((task) => { if (!cancelled) { selectedRef.current = task; setSelected(task); } }).catch(() => { if (!cancelled) setDetailNotFound(true); });
    return () => { cancelled = true; };
  }, [companyId, detailNotFound, loadedCompanyId, routeTaskId]);
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
    setSelected(undefined); setProjectId(remembered.current.projectId ?? ""); setTitle(""); setDescription(""); setSource(undefined); setSourceSummary(undefined); sourcePrefill.current = { title: "", description: "" }; resetNewTaskSettings(); setImages([]); setCreateError(""); setDetailNotFound(false);
  }, [companyId]);
  const reloadTasks = useCallback(async (): Promise<void> => {
    const token = ++taskListToken.current;
    if (!companyId) { setTasks([]); return; }
    try {
      const tasks = await readTaskList(companyId, taskFilter === "archived");
      if (token !== taskListToken.current) return;
      setTasks(tasks);
      setDetailNotFound(Boolean(routeTaskId) && !tasks.some((task) => task.id === routeTaskId));
    } catch { /* The mount reload already surfaces load errors. */ }
  }, [companyId, routeTaskId, taskFilter]);
  useEffect(() => {
    if (!companyId) return;
    return subscribeTaskListInvalidations(companyId, () => void reloadTasks());
  }, [companyId, reloadTasks]);

  const scopeLoaded = Boolean(companyId) && loadedCompanyId === companyId;
  const visibleProjects = scopeLoaded ? projects : [];
  const visibleTasks = scopeLoaded ? tasks : [];
  const boardTasks = boardProjectId === "all" ? visibleTasks : visibleTasks.filter((task) => task.projectId === boardProjectId);
  const taskBoard = Object.fromEntries(taskPhases.map((phase) => [phase, boardTasks.filter((task) => task.phase === phase && (phase !== "done" || showArchived || task.worktreeState !== "cleaned"))])) as Record<(typeof taskPhases)[number], ApiTaskSummary[]>;
  const selected = scopeLoaded ? selectedState : undefined;
  const availableProjects = visibleProjects.filter((project) => project.companyId === companyId);
  const forgeProject = currentCompany?.status === "active" ? findForgeProject(availableProjects) : undefined;
  const newTaskProject = availableProjects.find((project) => project.id === projectId);
  const newTaskRoleAgents = {
    planner: roleAgentOverrides.planner ?? newTaskProject?.roleDefaults.planner,
    builder: roleAgentOverrides.builder ?? newTaskProject?.roleDefaults.builder,
    reviewer: roleAgentOverrides.reviewer ?? newTaskProject?.roleDefaults.reviewer,
    integrator: roleAgentOverrides.integrator ?? newTaskProject?.roleDefaults.integrator,
  };
  const activeCount = visibleTasks.filter((task) => activeTaskPhases.has(task.phase) || task.blocked).length;
  const backlogCount = visibleTasks.filter((task) => task.phase === "backlog").length;
  const taskGroups = taskListGroups(visibleTasks, taskFilter);
  const archivedCount = taskFilter === "archived" ? taskGroups.reduce((count, group) => count + group.tasks.length, 0) : undefined;
  const selectTask = (task: ApiTaskSummary): void => { setSelected(undefined); selectedRef.current = undefined; setDetailNotFound(false); window.history.pushState({}, "", withCompany(`${routeBase}/${encodeURIComponent(task.id)}`, companyId)); window.dispatchEvent(new Event("forge:navigate")); };
  const addImages = async (files: File[]): Promise<void> => {
    setCreateError("");
    const imageError = newTaskImageError(images.length, files);
    if (imageError) { setCreateError(imageError); return; }
    try { const nextImages = await Promise.all(files.map(fileAsImage)); setImages((current) => [...current, ...nextImages]); }
    catch { setCreateError("Unable to read image"); }
  };
  const create = async (): Promise<void> => {
    if (!companyId || currentCompany?.status !== "active") return;
    setBusy(true); setCreateError(""); setError("");
    try {
      const result = await readJson<ApiTask>(`/api/companies/${companyId}/tasks`, { method: "POST", body: JSON.stringify({ projectId, title, description, images, roleAgents: newTaskRoleAgents, autoApprovePlan, startImmediately, deliveryTarget, runProjectTests, visualEvidence, supplementalReview, ...(source ? { source } : {}), idempotencyKey: crypto.randomUUID() }) });
      invalidateTaskList(companyId);
      setTasks((current) => [...current.filter((task) => task.id !== result.id), result]);
      const memory: NewTaskMemory = { projectId, deliveryTarget, autoApprovePlan, startImmediately, runProjectTests, visualEvidence, supplementalReview, roleAgents: Object.fromEntries(Object.entries(newTaskRoleAgents).filter(([, id]) => typeof id === "string" && agents.some((agent) => agent.id === id))) };
      remembered.current = memory; writeNewTaskMemory(memory);
      const taskPath = withCompany(`/tasks/${encodeURIComponent(result.id)}`, companyId);
      if (startImmediately && result.allowedCommands.includes("start_planning")) { navigate(taskPath); setError(planningUnavailable || "Planning did not start. Use Start planning on the task."); return; }
      navigate(taskPath);
    } catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setCreateError(reason instanceof Error ? reason.message : "Unable to create task"); }
    finally { setBusy(false); }
  };
  const selectSource = (summary: TaskSourceSummary, selector: TaskSourceSelector): void => {
    const next = prefillForTaskSource(summary);
    const preserved = preserveEditedPrefill({ title, description }, sourcePrefill.current, next);
    setTitle(preserved.title); setDescription(preserved.description); sourcePrefill.current = next;
    setSource(selector); setSourceSummary(summary);
  };
  const applyTemplate = async (template: ApiTaskTemplate): Promise<void> => {
    setDescription(template.description); setDeliveryTarget(template.deliveryTarget); setRunProjectTests(template.runProjectTests); setVisualEvidence(template.visualEvidence); setSupplementalReview(template.supplementalReview); setAutoApprovePlan(template.autoApprovePlan); setRoleAgentOverrides({ ...template.roleAgents });
    const templateSource = template.source;
    if (!templateSource || !projectId) return;
    try {
      const result = await readJson<{ sources: TaskSourceSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/task-sources?kind=${templateSource.kind}`);
      const source = result.sources.find((candidate) => templateSource.kind === "pull_request" ? candidate.kind === "pull_request" && candidate.number === templateSource.number : candidate.kind === "branch" && candidate.branch === templateSource.branch);
      if (source) selectSource(source, templateSource);
    } catch { /* The saved source was removed or cannot currently be discovered. */ }
  };
  const startPlanning = async (): Promise<void> => {
    if (!selected) return;
    if (planningUnavailable) { setError(planningUnavailable); return; }
    setBusy(true); setError("");
    const optimistic: ApiTask = { ...selected, phase: "planning", step: "planning", blocked: false, revision: selected.revision + 1, owner: "lead", allowedCommands: [], pendingAction: "Planner planning" };
    selectedRef.current = optimistic; setSelected(optimistic); setTasks((current) => current.map((task) => task.id === optimistic.id ? optimistic : task));
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/start-planning`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision }) }); selectedRef.current = updated; setSelected(updated); setTasks((current) => current.map((task) => task.id === updated.id ? updated : task)); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to start planning"); }
    finally { setBusy(false); }
  };
  const refreshTask = useCallback(async (): Promise<void> => {
    if (!selected) return;
    const refreshed = await readJson<ApiTask>(`/api/tasks/${encodeURIComponent(selected.id)}?refresh=1`);
    selectedRef.current = refreshed;
    setSelected(refreshed);
    setTasks((current) => current.map((task) => task.id === refreshed.id ? refreshed : task));
  }, [selected?.id]);
  const duplicateTask = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError(""); setCreateError("");
    try {
      const usedTitles = new Set(tasks.filter((task) => task.projectId === selected.projectId).map((task) => task.title));
      const draft = duplicateTaskDraft(selected, usedTitles);
      setProjectId(draft.projectId); setRoleAgentOverrides(draft.roleAgents); setAutoApprovePlan(draft.autoApprovePlan); setDeliveryTarget(draft.deliveryTarget); setRunProjectTests(draft.runProjectTests); setVisualEvidence(draft.visualEvidence); setSupplementalReview(draft.supplementalReview); setTitle(draft.title); setDescription(draft.description);
      setSource(undefined); setSourceSummary(undefined); sourcePrefill.current = { title: "", description: "" };
      if (draft.source) {
        try {
          const result = await readJson<{ sources: TaskSourceSummary[] }>(`/api/projects/${encodeURIComponent(draft.projectId)}/task-sources?kind=${draft.source.kind}`);
          const summary = result.sources.find((candidate) => draft.source?.kind === "pull_request" ? candidate.kind === "pull_request" && candidate.number === draft.source.number : candidate.kind === "branch" && candidate.branch === draft.source?.branch);
          if (summary) { setSource(draft.source); setSourceSummary(summary); }
        } catch { /* The source was removed or cannot currently be discovered. */ }
      }
      const duplicateImages = await Promise.all(selected.images.map(async (image) => {
        const response = await fetch(`/api/tasks/${encodeURIComponent(selected.id)}/images/${encodeURIComponent(image.artifactId)}`, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`Unable to load image ${image.filename}`);
        return fileAsImage(new File([await response.blob()], image.filename, { type: image.mimeType }));
      }));
      setImages(duplicateImages); setCreateOpen(true);
    } catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      setError(`Unable to duplicate task${reason instanceof Error ? `: ${reason.message}` : ""}`);
    } finally { setBusy(false); }
  };
  const prepareFixTask = async (): Promise<void> => {
    if (!selected || !forgeProject) return;
    setCreateError(""); setError("");
    let diagnostics: TaskDiagnostics | undefined;
    try { diagnostics = await readJson<TaskDiagnostics>(`/api/tasks/${encodeURIComponent(selected.id)}/diagnostics`); }
    catch { /* The draft remains useful from the task snapshot alone. */ }
    const draft = fixTaskDraft(selected, diagnostics, window.location.href);
    setProjectId(forgeProject.id); setRoleAgentOverrides({}); setTitle(draft.title); setDescription(draft.description);
    setSource(undefined); setSourceSummary(undefined); sourcePrefill.current = { title: "", description: "" }; setImages([]); resetNewTaskSettings(); setCreateOpen(true);
  };
  const saveTaskAsTemplate = async (): Promise<void> => {
    if (!selected) return;
    const name = window.prompt("Template name")?.trim();
    if (!name) return;
    setBusy(true); setError("");
    try { await readJson(`/api/tasks/${encodeURIComponent(selected.id)}/save-as-template`, { method: "POST", body: JSON.stringify({ name }) }); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setError(reason instanceof Error ? reason.message : "Unable to save template"); }
    finally { setBusy(false); }
  };
  const updateTaskDetails = async (input: { title?: string; description?: string }): Promise<void> => {
    if (!selected) return;
    try {
      const updated = await readJson<ApiTask>(`/api/tasks/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: JSON.stringify(input) });
      selectedRef.current = updated; setSelected(updated); setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
    } catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      setError(reason instanceof Error ? reason.message : "Unable to save task details");
      throw reason;
    }
  };
  const planAction = async (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>): Promise<void> => {
    if (!selected) return;
    const retryPendingAction = path === "retry-forward-merge-verification" ? "Retrying pinned forward-merge verification" : path === "retry-target-base-reconciliation" ? "Retrying target-base reconciliation" : undefined;
    setBusy(true); setError("");
    if (retryPendingAction) {
      const optimistic: ApiTask = { ...selected, revision: selected.revision + 1, owner: "lead", allowedCommands: [], pendingAction: retryPendingAction };
      selectedRef.current = optimistic; setSelected(optimistic); setTasks((current) => current.map((task) => task.id === optimistic.id ? optimistic : task));
    }
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/${path}`, { method: "POST", body: JSON.stringify(taskActionPayload(selected.revision, note, payload)) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      const staleRevision = isApiError(reason, 409);
      if (staleRevision || retryPendingAction) { await reload(); if (staleRevision) throw reason; }
      setError(staleRevision ? "Issue changed; the latest state was loaded." : reason instanceof Error ? reason.message : "Unable to update the plan");
    }
    finally { setBusy(false); }
  };
  const markReady = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/mark-ready`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision }) }); selectedRef.current = updated; setSelected(updated); await refreshTask(); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to mark the pull request ready"); }
    finally { setBusy(false); }
  };
  const mergePullRequest = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true); setError("");
    try { const updated = await readJson<ApiTask>(`/api/tasks/${selected.id}/merge-pull-request`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.revision }) }); selectedRef.current = updated; setSelected(updated); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; await reload(); setError(reason instanceof Error ? reason.message : "Unable to merge the pull request"); }
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
  const rescueTask = async (): Promise<{ steps: Array<{ name: string; outcome: "completed" | "skipped" | "failed"; detail: string }> }> => {
    if (!selected) return { steps: [] };
    setBusy(true); setError("");
    try { const report = await readJson<{ steps: Array<{ name: string; outcome: "completed" | "skipped" | "failed"; detail: string }> }>(`/api/tasks/${selected.id}/rescue`, { method: "POST" }); await reload(); return report; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to rescue task"); throw reason; }
    finally { setBusy(false); }
  };

  const newTaskDialog = <NewTaskDialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (open) setCreateError(""); else { setSource(undefined); setSourceSummary(undefined); sourcePrefill.current = { title: "", description: "" }; resetNewTaskSettings(); } }} companyStatus={currentCompany?.status} projects={availableProjects} projectId={projectId} onProjectChange={(nextProjectId) => { setProjectId(nextProjectId); setSource(undefined); setSourceSummary(undefined); sourcePrefill.current = { title: "", description: "" }; setRoleAgentOverrides({}); }} sourceSummary={sourceSummary} onSourceSelect={selectSource} onSourceClear={() => { setSource(undefined); setSourceSummary(undefined); sourcePrefill.current = { title: "", description: "" }; }} agents={agents} roleAgents={newTaskRoleAgents} onRoleAgentChange={(role, agentId) => setRoleAgentOverrides((current) => { const next = { ...current, [role]: agentId }; if (role === "reviewer" && !agentId) setSupplementalReview(false); return next; })} title={title} onTitleChange={setTitle} description={description} onDescriptionChange={setDescription} autoApprovePlan={autoApprovePlan} onAutoApprovePlanChange={setAutoApprovePlan} startImmediately={startImmediately} onStartImmediatelyChange={setStartImmediately} deliveryTarget={deliveryTarget} onDeliveryTargetChange={setDeliveryTarget} runProjectTests={runProjectTests} onRunProjectTestsChange={setRunProjectTests} visualEvidence={visualEvidence} onVisualEvidenceChange={setVisualEvidence} supplementalReview={supplementalReview} onSupplementalReviewChange={setSupplementalReview} images={images} onAddImages={addImages} onRemoveImage={(index) => setImages((current) => current.filter((_, candidate) => candidate !== index))} busy={busy} error={createError} onSubmit={create} onApplyTemplate={applyTemplate} />;

  if (routeTaskId && loading) return <TaskDetailsSkeleton />;
  if (routeTaskId && !companyId) return <TaskDetailsNotFound companyId="" returnTo={mode} />;
  if (routeTaskId && !scopeLoaded && !error) return <TaskDetailsSkeleton />;
  if (routeTaskId && !scopeLoaded && error) return <ApplicationFrame title="Unable to load task"><div className="px-4 py-8 sm:px-6 lg:px-10"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div></ApplicationFrame>;
  if (routeTaskId && detailNotFound) return <TaskDetailsNotFound companyId={companyId} returnTo={mode} />;
  if (routeTaskId && !selected) return <TaskDetailsSkeleton />;
  if (routeTaskId && selected) return <><TaskDetailsPage task={selected} project={visibleProjects.find((project) => project.id === selected.projectId)} companyId={companyId} returnTo={mode} busy={busy} error={error} isAdmin={user?.role === "admin"} onStartPlanning={startPlanning} onPlanAction={planAction} onRevisePlan={revisePlan} onContinueWork={continueWork} onResolveDecisionBlocker={resolveDecisionBlocker} onMarkReady={markReady} onMerge={mergePullRequest} onDuplicate={duplicateTask} {...(forgeProject ? { onFixInNewTask: prepareFixTask } : {})} onUpdateDetails={updateTaskDetails} onRefresh={refreshTask} onRescue={rescueTask} onSaveTemplate={saveTaskAsTemplate} />{newTaskDialog}</>;

  if (mode === "board") {
    return (
      <ApplicationFrame title="Board" headerRight={<span className="text-[11px] text-muted-foreground">Read-only state</span>}>
        <div className="flex h-[calc(100vh-2.5rem)] min-h-0 min-w-0 flex-col border-t border-border/70 bg-background">
          <div className="flex h-11 shrink-0 items-center justify-between overflow-x-auto border-b border-border/70 px-3 sm:px-4">
            <div className="flex items-center gap-2">
              <Select value={boardProjectId} onValueChange={(value) => setBoardProjectId(value ?? "all")}>
                <SelectTrigger aria-label="Filter board by project" className="h-7 w-auto min-w-28 rounded-full border-border bg-background px-2.5 text-xs shadow-none">
                  <SelectValue>{(value) => value === "all" ? "All projects" : visibleProjects.find((project) => project.id === value)?.name ?? "All projects"}</SelectValue>
                </SelectTrigger>
                <SelectContent><SelectItem value="all">All projects</SelectItem>{visibleProjects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
              </Select>
              <label className="flex cursor-pointer items-center gap-2 text-xs"><Checkbox checked={hideEmptyColumns} onCheckedChange={(c) => setHideEmptyColumns(c === true)} />Hide empty columns</label>
              <label className="flex cursor-pointer items-center gap-2 text-xs"><Checkbox checked={showArchived} onCheckedChange={(checked) => setShowArchived(checked === true)} />Show archived</label>
              <label className="flex cursor-pointer items-center gap-2 text-xs"><Checkbox checked={taskFilter === "archived"} onCheckedChange={(checked) => setTaskFilter(checked === true ? "archived" : "all")} />Archived</label>
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
                {taskPhases.filter((phase) => !hideEmptyColumns || taskBoard[phase].length > 0).length === 0 ? <p className="text-xs text-muted-foreground">No tasks</p> : taskPhases.filter((phase) => !hideEmptyColumns || taskBoard[phase].length > 0).map((phase) => {
                  return <KanbanColumn disabled key={phase} value={phase} className="min-h-0 rounded-md bg-muted/45">
                    <div className="flex h-10 shrink-0 items-center justify-between px-3 text-xs">
                      <div className="flex min-w-0 items-center gap-2"><TaskStatus phase={phase} /><span className="text-muted-foreground">{taskBoard[phase].length}</span></div>
                      <div className="flex items-center gap-0.5 text-muted-foreground"><Button variant="ghost" size="icon-sm" className="size-6" aria-label={`${taskPhaseLabel(phase)} options`}><Ellipsis className="size-3.5" /></Button><a className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "size-6" })} href={withCompany("/tasks", companyId)} aria-label="Create task"><Plus className="size-3.5" /></a></div>
                    </div>
                    <KanbanColumnContent value={phase} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                      {taskBoard[phase].map((task) => {
                        const project = visibleProjects.find((candidate) => candidate.id === task.projectId);
                        const activeInvocations = Array.from(task.agentInvocations.reduce((byAgent, invocation) => {
                          if (!ACTIVE_INVOCATION_STATUSES.has(invocation.status)) return byAgent;
                          const current = byAgent.get(invocation.agentId);
                          if (!current || invocation.startedAt > current.startedAt) byAgent.set(invocation.agentId, invocation);
                          return byAgent;
                        }, new Map<string | null | undefined, (typeof task.agentInvocations)[number]>()).values());
                        return <button type="button" className="block w-full rounded-md border border-border/90 bg-card px-3 py-2.5 text-left text-xs transition-colors hover:border-muted-foreground/35 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring" key={task.id} onClick={() => selectTask(task)}>
                          <span className="flex items-center gap-1.5 font-medium leading-4 text-card-foreground"><TaskStatusIcon phase={task.phase} blocked={task.blocked} pullRequestState={task.githubPullRequest?.state} /><LiveStatusDot liveStatus={task.liveStatus ?? []} /><span>{task.issueKey ? <span className="mr-1.5 font-normal text-muted-foreground">{task.issueKey}</span> : null}{task.title}</span></span>
                          {task.pendingAction ? <span className="mt-1 block truncate text-[11px] leading-4 text-muted-foreground">{task.pendingAction}</span> : null}
                          <span className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Layers3 className="size-3" />{project?.name ?? "Unknown project"}</span>
                          {activeInvocations.length ? <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                            {activeInvocations.map((invocation) => <span key={invocation.id} className="flex items-center gap-1"><ProfileAvatar name={invocation.agentName ?? invocation.role} seed={invocation.avatarSeed ?? invocation.id} size="xs" /><span className="truncate">{invocation.agentName ?? invocation.role}</span><span className="text-[10px] text-muted-foreground/70">{invocation.role}</span></span>)}
                          </span> : null}
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
              <TabsTrigger value="archived">Archived {archivedCount === undefined ? null : <span className="text-[11px] text-muted-foreground">{archivedCount}</span>}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {error ? <div className="p-3 sm:p-4"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        {!scopeLoaded && !error ? <div className="space-y-px p-2" aria-label="Loading tasks" aria-busy="true"><Skeleton className="h-8 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div> : null}
        {scopeLoaded && taskGroups.length === 0 ? <div className="px-4 py-8 text-xs text-muted-foreground">{taskFilter === "active" ? "No active tasks." : taskFilter === "backlog" ? "No backlog tasks." : taskFilter === "archived" ? "No archived tasks." : "No tasks yet. Press ⌘N to create one."}</div> : null}
        {scopeLoaded ? <div aria-label="Task groups" className="py-1">
          {taskGroups.map((group) => {
            const GroupIcon = group.id === "completed" ? CheckCircle2 : group.id === "cancelled" ? CircleSlash : group.id === "blocked" ? CircleX : group.id === "active" ? CircleDotDashed : CircleDashed;
            const groupIconClass = group.id === "completed" ? "text-emerald-500" : group.id === "cancelled" ? "text-muted-foreground" : group.id === "blocked" ? "text-rose-500" : group.id === "active" ? "text-amber-500" : "text-muted-foreground";
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
                    const appearance = taskStatusAppearance(task.phase, task.blocked);
                    return (
                      <a data-task-row key={task.id} href={withCompany(`/tasks/${encodeURIComponent(task.id)}`, companyId)} className="group/task-row grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 text-[13px] outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:px-4">
                        <span className="flex items-center gap-1.5"><TaskStatusIcon phase={task.phase} blocked={task.blocked} pullRequestState={task.githubPullRequest?.state} /><LiveStatusDot liveStatus={task.liveStatus ?? []} /></span>
                        <span className="flex min-w-0 items-center gap-2">
                          {task.issueKey ? <span className="shrink-0 text-xs text-muted-foreground">{task.issueKey}</span> : null}
                          <span className="truncate font-medium">{task.title}</span>
                          {branchSync[task.id]?.ahead ? <ReuiBadge variant="secondary" size="sm" radius="full">↑{branchSync[task.id]?.ahead}</ReuiBadge> : null}
                          {project ? <><ChevronRight className="hidden size-3 shrink-0 text-muted-foreground/60 md:block" /><span className="hidden truncate text-xs text-muted-foreground md:block">{project.name}</span></> : null}
                        </span>
                        <span className="hidden sm:inline-flex"><ReuiBadge variant={appearance.badge} size="sm" radius="full">{taskStatusLabel(task.phase, task.pendingAction)}</ReuiBadge></span>
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
        {newTaskDialog}
      </div>
    </ApplicationFrame>
  );
}
