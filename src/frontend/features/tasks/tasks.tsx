import { getTask, listTasks } from "./lib/task-api.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ClipboardList, ListFilter, Plus, RefreshCw, Search } from "lucide-react";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { Button } from "../../components/ui/button.js";
import { EmptyState } from "../../components/app/empty-state.js";
import { NewButton } from "../../components/ui/new-button.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group.js";
import { Kbd } from "../../components/ui/kbd.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { withCompany } from "../../lib/api.js";
import type { Task } from "../../contracts/tasks.js";
import { TaskControlStatusSchema, type TaskControlStatus } from "../../contracts/task-control.js";
import { requestNewTask } from "../../shell/global-new-task-dialog.js";
import { useCommandKFocus } from "../../shell/shortcuts.js";
import { TaskOptions } from "./task-options.js";
import { TaskDetailsPage } from "./task-details.js";
import { blockedByLabel, TaskStatus, TaskStatusIcon, taskStatusLabels } from "./task-status.js";
import { ProjectLabel } from "../../components/app/project-label.js";
import { CostValue } from "../../components/app/cost-value.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { useTaskCosts } from "../analytics/lib/analytics.js";
import { relativeTime, type ApiProject } from "../../shell/view-shared.js";
import { useTaskCache, useTaskData } from "./task-data.js";
import { queueOrder } from "./lib/task-list.js";
import { LoadingState } from "../../components/app/loading-state.js";
import { listProjects } from "../projects/lib/project-api.js"; import { readTaskListFilters, taskListReturnHref, useTaskListScroll, useTaskListUrl } from "./lib/task-list-url-state.js";

type BoardView = "compact" | "full";

/** Task, project, branch, status, PR, cost, and updated columns of the wide task list. */
const listColumns = "lg:grid-cols-[minmax(12rem,1fr)_fit-content(12rem)_10rem_repeat(4,max-content)]";

export function TasksView({ mode = "list" }: { mode?: "list" | "board" }): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  const selectedId = /^\/(?:tasks|board)\/([^/]+)$/.exec(window.location.pathname)?.[1]; const [initialFilters] = useState(readTaskListFilters);
  const taskList = useTaskData();
  const cacheTask = useTaskCache();
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [detailsLoaded, setLoaded] = useState(false);
  const [archived, setArchived] = useState(initialFilters.archived);
  const tasks = archived ? archivedTasks : taskList.data ?? [];
  const loaded = detailsLoaded && Boolean(selectedId || archived || !companyId || !taskList.isPending);
  const readError = error || (!archived && taskList.error?.message) || "";
  const [query, setQuery] = useState(initialFilters.query);
  const filterInput = useRef<HTMLInputElement>(null);
  useCommandKFocus(filterInput);
  const [status, setStatus] = useState(initialFilters.status);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [projectId, setProjectId] = useState(initialFilters.projectId);
  const [boardView, setBoardView] = useState<BoardView>(initialFilters.boardView);
  const [boardStatus, setBoardStatus] = useState<TaskControlStatus | "all">(() => { const value = initialFilters.boardStatus; return value !== "all" && TaskControlStatusSchema.safeParse(value).success ? TaskControlStatusSchema.parse(value) : "all"; });
  const costs = useTaskCosts(mode === "list" && !selectedId ? companyId : undefined); useTaskListUrl({ archived, status, projectId, query, boardView, boardStatus }, !selectedId); useTaskListScroll(!selectedId && loaded);
  const scope = `${companyId}:${selectedId}:${archived}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const reload = useCallback(async () => {
    if (!companyId) { setLoaded(true); return; }
    const [result, task, projectResult] = await Promise.all([
      archived ? listTasks(companyId, { archived: true }) : Promise.resolve(null),
      selectedId ? getTask(selectedId) : Promise.resolve(null),
      listProjects(companyId),
    ]);
    if (currentScope.current !== scope) return;
    if (task && task.companyId !== companyId) throw new Error("This task is not in the selected company");
    if (result) setArchivedTasks(result);
    setSelected(task);
    setProjects(projectResult);
    setLoaded(true);
    setError("");
  }, [companyId, selectedId, archived, scope]);
  useEffect(() => {
    setSelected(null); setArchivedTasks([]); setLoaded(false);
    let closed = false;
    let reading = false;
    const poll = async () => {
      if (closed || reading) return;
      reading = true;
      try { await reload(); }
      catch (error) { if (!closed) { setError(error instanceof Error ? error.message : "Tasks are not available"); setLoaded(true); } }
      finally { reading = false; }
    };
    void poll();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void poll(); }, 3000);
    return () => { closed = true; clearInterval(timer); };
  }, [reload]);
  const updateTask = (task: Task) => { setSelected(task); cacheTask(task); };
  const refresh = async () => { await Promise.all([reload(), ...(!archived && companyId ? [taskList.refetch({ throwOnError: true })] : [])]); };
  const visible = tasks.filter(task => (status === "all" || task.status === status || status === "active" && task.status === "waiting_human") && (boardStatus === "all" || task.status === boardStatus) && (projectId === "all" || task.projectId === projectId) && `${task.issueKey ?? ""} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  const hasFilters = Boolean(query.trim() || status !== "all" || projectId !== "all" || boardStatus !== "all" || archived);
  const groups = ["backlog", "queued", "active", "waiting_human", "delivered", "cancelled"] as const;
  return <ApplicationFrame title={mode === "board" ? "Board" : "Tasks"} viewportBound={Boolean(selectedId)} headerRight={<><Button variant="ghost" size="icon-sm" aria-label="Check tasks" onClick={() => void refresh().catch(error => setError(String(error)))}><RefreshCw /></Button></>}>
    {readError ? <Alert variant="destructive"><AlertDescription>{readError}</AlertDescription></Alert> : null}
    {selectedId ? selected ? <TaskDetailsPage key={selected.id} task={selected} project={projects.find(project => project.id === selected.projectId)} onChange={updateTask} backHref={taskListReturnHref(withCompany(mode === "board" ? "/board" : "/tasks", selected.companyId))} titleActions={<TaskOptions task={selected} onChange={updateTask} onError={setError} />} /> : loaded ? <p className="p-4">Task not found</p> : <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading task…</span></p> : <div data-task-list className="min-w-0 flex flex-col flex-1">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b p-3">
        <div className="flex max-w-full flex-wrap items-center gap-2"><div className="max-w-full overflow-x-auto"><Tabs value={archived ? "archived" : status} onValueChange={value => { setArchived(value === "archived"); setStatus(value === "archived" ? "all" : String(value)); }}><TabsList variant="pill">
          <TabsTrigger className="font-normal" value="active">Active</TabsTrigger><TabsTrigger className="font-normal" value="backlog">Backlog</TabsTrigger><TabsTrigger className="font-normal" value="queued">Queued</TabsTrigger><TabsTrigger className="font-normal" value="all">All tasks</TabsTrigger><TabsTrigger className="font-normal" value="archived">Archived</TabsTrigger>
        </TabsList></Tabs></div>{mode === "board" ? <Select value={boardView} onValueChange={value => { if (value === "compact" || value === "full") setBoardView(value); }}><SelectTrigger aria-label="Board view"><SelectValue>{value => value === "full" ? "Full View" : "Compact View"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="compact">Compact View</SelectItem><SelectItem value="full">Full View</SelectItem></SelectContent></Select> : null}{mode === "board" ? <Select value={boardStatus} onValueChange={value => setBoardStatus(value ?? "all")}><SelectTrigger aria-label="Filter by status"><SelectValue>{value => value === "all" ? <><ListFilter aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />All statuses</> : <><TaskStatusIcon status={TaskControlStatusSchema.parse(value)} />{taskStatusLabels[TaskControlStatusSchema.parse(value)]}</>}</SelectValue></SelectTrigger><SelectContent><SelectItem value="all"><ListFilter aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />All statuses</SelectItem>{TaskControlStatusSchema.options.map(value => <SelectItem key={value} value={value}><TaskStatusIcon status={value} />{taskStatusLabels[value]}</SelectItem>)}</SelectContent></Select> : null}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <InputGroup className="w-44"><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput ref={filterInput} aria-label="Filter tasks" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); setQuery(""); }} placeholder="Filter tasks" /><InputGroupAddon align="inline-end"><Kbd className="font-normal" variant="outline">⌘K</Kbd></InputGroupAddon></InputGroup>
          <Select value={projectId} onValueChange={value => setProjectId(value ?? "all")}><SelectTrigger aria-label="Filter by project"><SelectValue>{value => value === "all" ? "All projects" : projects.find(project => project.id === value)?.name}</SelectValue></SelectTrigger><SelectContent><SelectItem value="all">All projects</SelectItem>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select>
        </div>
      </div>
      {!loaded ? <LoadingState /> : !visible.length && (mode !== "board" || boardView === "compact") ? <EmptyState icon={ClipboardList} title={hasFilters ? "No matching tasks" : "No tasks yet"} description={hasFilters ? "Change the filters to find your tasks." : "Create your first task and let your agents get to work."} action={hasFilters ? <Button variant="outline" onClick={() => { setQuery(""); setStatus("all"); setProjectId("all"); setBoardStatus("all"); setArchived(false); }}>Clear filters</Button> : <NewButton className="text-base gap-1 p-5" disabled={currentCompany?.status !== "active"} onClick={() => requestNewTask()}>Create your first task</NewButton>} /> : mode === "board" ? <div className="max-w-full overflow-x-auto px-3 py-1 sm:px-4" data-task-board><div className="flex min-h-[calc(100dvh-12rem)] w-max gap-2">{TaskControlStatusSchema.options.filter(value => (boardStatus === "all" || value === boardStatus) && (boardView === "full" || visible.some(task => task.status === value))).map(value => <section key={value} className="w-72 shrink-0 rounded-md bg-muted/45" aria-label={taskStatusLabels[value]}><header className="flex h-10 items-center gap-2 px-3 text-xs"><TaskStatusIcon status={value} /><h2 className="font-medium">{taskStatusLabels[value]}</h2><span className="text-muted-foreground">{visible.filter(task => task.status === value).length}</span><div className="ml-auto"><Button size="icon-xs" variant="ghost" aria-label={`New task in ${taskStatusLabels[value]}`} onClick={() => requestNewTask()}><Plus /></Button></div></header><ul className="grid grid-cols-1 gap-2 px-2 pb-2">{(value === "queued" ? queueOrder : (column: Task[]) => column)(visible.filter(task => task.status === value)).map(task => <li key={task.id} className="min-w-0"><a href={withCompany(`/board/${task.id}`, task.companyId)} className="block min-w-0 rounded-md border bg-card p-3 text-xs hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"><span className="flex min-w-0 items-center gap-2 font-medium leading-5"><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="min-w-0 truncate">{task.issueKey ? <span className="mr-2 text-muted-foreground">{task.issueKey}</span> : null}{task.title}</span></span>{task.blockedBy.length ? <p data-task-blocked-by className="mt-1 truncate text-muted-foreground">{blockedByLabel(task.blockedBy)}</p> : null}{task.humanQuestion ? <p className="mt-1 truncate text-muted-foreground">{task.humanQuestion.text}</p> : null}<span className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground"><ProjectLabel project={projects.find(project => project.id === task.projectId)} fallback={task.configuration.repository} /></span></a></li>)}</ul></section>)}</div></div> : <div className={`px-2 pb-2 lg:grid ${listColumns} gap-x-[22px]`}><div data-task-columns className="col-span-full hidden grid-cols-subgrid items-center px-3 pt-2 pb-1 text-muted-foreground lg:grid text-sm dark:text-[#d1d1d1]"><span data-task-column="title" className="pl-0">Task</span><span data-task-column="project">Project</span><span data-task-column="branch">Branch</span><span data-task-column="status">Status</span><span data-task-column="pr">PR</span><span data-task-column="cost" className="text-right">Cost</span><span data-task-column="time" className="text-right">Updated</span></div><ul aria-label="Tasks" className="col-span-full lg:grid lg:grid-cols-subgrid">{groups.flatMap(value => visible.filter(task => task.status === value)).map(task => <TaskRow key={task.id} task={task} project={projects.find(project => project.id === task.projectId)} cost={costs.get(task.id)} />)}</ul></div>}
    </div>}
  </ApplicationFrame>;
}

export function TaskRow({ task, project, cost }: { task: Task; project: ApiProject | undefined; cost: ReturnType<typeof useTaskCosts> extends Map<string, infer Value> ? Value | undefined : never }): ReactElement {
  const settled = task.status === "delivered" || task.status === "cancelled";
  return <li data-task-row className={`relative grid min-h-13.5 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md px-3 py-2 text-sm before:absolute before:top-0 before:right-3 before:left-9 before:h-px before:bg-border first:before:hidden hover:bg-muted hover:before:hidden [&:hover+li]:before:hidden lg:col-span-full lg:grid-cols-subgrid lg:py-1 gap-x-[22px]`}>
    <a className="col-span-full row-start-1 grid min-w-0 grid-cols-subgrid items-center focus-visible:outline-2 focus-visible:outline-ring" href={withCompany(`/tasks/${task.id}`, task.companyId)}>
      <span data-task-title className="flex min-w-0 items-center gap-2.5"><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="flex min-w-0 flex-col"><span className="flex min-w-0 items-baseline gap-2">{task.issueKey ? <span className="shrink-0 text-muted-foreground">{task.issueKey}</span> : null}<span className={`truncate ${settled ? "text-muted-foreground" : "text-foreground"} text-base not-dark:font-medium`}>{task.title}</span></span></span></span>
      <span data-task-project className="hidden min-w-0 items-center gap-2 text-muted-foreground lg:flex"><ProjectLabel project={project} fallback="Not available" /></span>
      <span data-task-branch className="hidden min-w-0 truncate font-mono text-muted-foreground lg:block text-[12px]" title={task.configuration.branch}>{task.configuration.branch}</span>
      <span data-task-status className="hidden lg:block"><TaskStatus status={task.status} pullRequestState={task.pullRequest?.state} /></span>
      <span className="hidden lg:block">{task.pullRequest ? null : <span className="text-muted-foreground">—</span>}</span>
      <span data-task-cost className="hidden text-right tabular-nums text-muted-foreground lg:block">{cost?.cost != null ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} suffix={cost.partial ? "+" : ""} /> : null}</span>
      <time data-task-time dateTime={task.updatedAt} className="col-start-2 row-start-1 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground lg:col-auto lg:row-auto">{new Date(task.updatedAt).toDateString() === new Date().toDateString() ? relativeTime(task.updatedAt) : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(task.updatedAt))}</time>
      <span data-task-compact-details className="col-span-2 flex min-w-0 items-center gap-2 pl-6 text-xs text-muted-foreground lg:hidden"><span data-task-compact-project className="flex min-w-0 items-center gap-1.5"><ProjectLabel project={project} fallback="Not available" /></span><span data-task-compact-cost className="ml-auto shrink-0 text-right tabular-nums">{cost?.cost != null ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} suffix={cost.partial ? "+" : ""} /> : null}</span></span>
    </a>
    {task.pullRequest ? <span data-task-pr className="pointer-events-none relative z-10 col-start-5 row-start-1 hidden lg:block"><a href={task.pullRequest.url} target="_blank" rel="noreferrer" className="pointer-events-auto underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">#{task.pullRequest.number}</a></span> : null}
  </li>;
}
