import { listTasks } from "./lib/task-api.js";
import { Fragment, memo, useEffect, useMemo, useState, type ReactElement } from "react";
import { ClipboardList, ListFilter, Plus, RefreshCw, Zap } from "lucide-react";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { Button } from "../../components/ui/button.js";
import { EmptyState } from "../../components/app/empty-state.js";
import { Empty, EmptyContent, EmptyHeader } from "../../components/ui/empty.js";
import { TasksIllustration } from "./tasks-illustration.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { ApiConnectionError, billingSettingsPath, withCompany } from "../../lib/api.js";
import type { TaskListTask } from "../../contracts/task-responses.js";
import type { MoveResponse } from "../../contracts/generated/MoveResponse.js";
import type { MoveRunResponse } from "../../contracts/generated/MoveRunResponse.js";
import { TaskControlStatusSchema, type TaskControlStatus } from "../../contracts/task-control.js";
import { requestNewTask, useHasProjects } from "../../shell/global-new-task-dialog.js";
import { TaskCardDuration } from "./task-card-duration.js";
import { TaskOptions } from "./task-options.js";
import { TaskDetailsPage } from "./task-details.js";
import { blockedByLabel, TaskStatus, TaskStatusIcon, taskStatusLabels } from "./task-status.js";
import { ProjectLabel } from "../../components/app/project-label.js";
import { ProjectSelect } from "../../components/app/project-select.js";
import { DataList, DataListRow, FilterInput, ListToolbar, ViewTabs } from "../../components/app/data-list.js";
import { CostValue } from "../../components/app/cost-value.js";
import { useTaskCosts } from "../analytics/lib/analytics.js";
import { relativeTime, type ApiProject } from "../../shell/view-shared.js";
import { taskListKey, useTaskCache, useTaskData } from "./task-data.js";
import { queueOrder } from "./lib/task-list.js";
import { skipToken, useQuery } from "@tanstack/react-query";
import { syncedPolling, useSyncLive } from "../../shell/sync.js";
import { useTask } from "./lib/task-queries.js";
import { useShellRuns } from "../moves/lib/move-runs.js";
import { LoadingState } from "../../components/app/loading-state.js";
import { getBillingSummary } from "../settings/lib/billing-api.js";
import { useProjects } from "../projects/lib/projects.js"; import { readTaskListFilters, taskListReturnHref, useTaskListScroll, useTaskListUrl } from "./lib/task-list-url-state.js";

type BoardView = "compact" | "full";
const boardShowOptions = [["all", "Tasks and moves", ListFilter], ["tasks", "Tasks", ClipboardList], ["moves", "Moves", Zap]] as const;
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
/** The Free plan limit in `rust/src/billing/mod.rs`. */
const FREE_RUNNING_TASKS = 3;
const noProjects: ApiProject[] = [];
const taskViews = [["active", "Active"], ["backlog", "Backlog"], ["queued", "Queued"], ["all", "All tasks"], ["archived", "Archived"]] as const;

/** Task, project, branch, status, PR, cost, and updated columns of the wide task list. */
const listColumns = "lg:grid-cols-[minmax(12rem,1fr)_fit-content(12rem)_10rem_repeat(4,max-content)]";

export function TasksView({ mode = "list" }: { mode?: "list" | "board" }): ReactElement {
  const { currentCompany, user } = useCompanyContext();
  const companyId = currentCompany?.id;
  const hasProjects = useHasProjects(companyId);
  const selectedId = /^\/(?:tasks|board)\/([^/]+)$/.exec(window.location.pathname)?.[1]; const [initialFilters] = useState(readTaskListFilters);
  const taskList = useTaskData();
  const cacheTask = useTaskCache();
  const [error, setError] = useState<string | Error>("");
  const [archived, setArchived] = useState(initialFilters.archived);
  // The open task and the archived list poll without the sync socket. With it, the open task arrives in frames, and the archived list reads again when a task leaves or enters the active list.
  const taskQuery = useTask(selectedId);
  const archivedList = useQuery({ queryKey: taskListKey(user?.id, companyId, true), queryFn: companyId ? ({ signal }) => listTasks(companyId, { archived: true, signal }) : skipToken, enabled: archived, ...syncedPolling(useSyncLive()) });
  const selected = taskQuery.data ?? null;
  const tasks = archived ? archivedList.data ?? [] : taskList.data ?? [];
  const projectList = useProjects(companyId);
  const projects = projectList.data ?? noProjects;
  const detailsLoaded = !companyId || (!selectedId || !taskQuery.isPending) && (!archived || !archivedList.isPending);
  const loaded = detailsLoaded && Boolean(!companyId || !projectList.isPending) && Boolean(selectedId || archived || !companyId || !taskList.isPending);
  const readFailure = [error, selectedId && taskQuery.error, archived ? archivedList.error : taskList.error, projectList.error].find(error => error && !(error instanceof ApiConnectionError));
  const readError = readFailure instanceof Error ? readFailure.message : readFailure;
  // A successful read clears an earlier error.
  useEffect(() => setError(""), [taskQuery.dataUpdatedAt, archivedList.dataUpdatedAt]);
  const [query, setQuery] = useState(initialFilters.query);
  const [status, setStatus] = useState(initialFilters.status);
  const [projectId, setProjectId] = useState(initialFilters.projectId);
  const [boardView, setBoardView] = useState<BoardView>(initialFilters.boardView);
  const [boardStatus, setBoardStatus] = useState<TaskControlStatus | "all">(() => { const value = initialFilters.boardStatus; return value !== "all" && TaskControlStatusSchema.safeParse(value).success ? TaskControlStatusSchema.parse(value) : "all"; });
  const [boardShow, setBoardShow] = useState(initialFilters.boardShow);
  const costs = useTaskCosts(mode === "list" && !selectedId ? companyId : undefined); useTaskListUrl({ archived, status, projectId, query, boardView, boardStatus, boardShow }, !selectedId); useTaskListScroll(!selectedId && loaded);
  const refresh = async () => { await Promise.all([projectList.refetch({ throwOnError: true }), ...(companyId ? [(archived ? archivedList : taskList).refetch({ throwOnError: true }), ...(selectedId ? [taskQuery.refetch({ throwOnError: true })] : [])] : [])]); };
  const visible = tasks.filter(task => (mode !== "board" || boardShow !== "moves") && (status === "all" || task.status === status || status === "active" && task.status === "waiting_human") && (boardStatus === "all" || task.status === boardStatus) && (projectId === "all" || task.projectId === projectId) && `${task.issueKey ?? ""} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  // Move runs show as delivered work on the board.
  const boardRuns = useShellRuns(mode === "board" && !selectedId && !archived ? companyId : undefined).filter(({ move }) => boardShow !== "tasks" && status === "all" && (boardStatus === "all" || boardStatus === "delivered") && (projectId === "all" || move.projectId === projectId) && move.name.toLowerCase().includes(query.trim().toLowerCase()));
  const projectsById = useMemo(() => new Map(projects.map(item => [item.id, item])), [projects]);
  const project = (id: string): ApiProject | undefined => projectsById.get(id);
  // Delivered work, move runs too, shows the newest first.
  const boardColumn = (value: TaskControlStatus): ReactElement[] => {
    const column = visible.filter(task => task.status === value);
    // Active work shows the task that became active last first.
    if (value === "active") column.sort((left, right) => right.statusChangedAt.localeCompare(left.statusChangedAt) || left.id.localeCompare(right.id));
    if (value === "queued") return queueOrder(column).map(task => <BoardTaskCard key={task.id} task={task} project={project(task.projectId)} />);
    if (value !== "delivered") return column.map(task => <BoardTaskCard key={task.id} task={task} project={project(task.projectId)} />);
    return [
      ...column.map(task => ({ at: task.statusChangedAt, card: <BoardTaskCard key={task.id} task={task} project={project(task.projectId)} /> })),
      ...boardRuns.map(({ move, run }) => ({ at: run.startedAt, card: <BoardRunCard key={run.id} move={move} run={run} project={project(move.projectId)} /> })),
    ].sort((left, right) => right.at.localeCompare(left.at)).map(item => item.card);
  };
  // Count tasks that Pro can start without waiting for a project slot or dependency.
  const planHeld = !archived && currentCompany?.plan === "free" ? tasks.filter(task => task.status === "queued" && task.queue.planConcurrencyLimited && !task.queue.projectConcurrencyLimited && task.queue.waitingOn.length === 0).length : 0;
  const hasFilters = Boolean(query.trim() || status !== "all" || projectId !== "all" || boardStatus !== "all" || boardShow !== "all" || archived);
  const groups = ["backlog", "queued", "active", "waiting_human", "delivered", "cancelled"] as const;
  // The list puts work that needs you first; the board keeps the left-to-right flow.
  const listGroups = ["waiting_human", "active", "queued", "backlog", "delivered", "cancelled"] as const;
  return <ApplicationFrame title={mode === "board" ? "Board" : "Tasks"} viewportBound={Boolean(selectedId)} headerRight={<><Button variant="ghost" size="icon-sm" aria-label="Check tasks" onClick={() => void refresh().catch(error => setError(error instanceof Error ? error : String(error)))}><RefreshCw /></Button></>}>
    {readError ? <Alert variant="destructive"><AlertDescription>{readError}</AlertDescription></Alert> : null}
    {selectedId ? selected ? <TaskDetailsPage key={selected.id} task={selected} project={project(selected.projectId)} onChange={cacheTask} backHref={taskListReturnHref(withCompany(mode === "board" ? "/board" : "/tasks", selected.companyId))} titleActions={<TaskOptions task={selected} onChange={cacheTask} onError={setError} />} /> : loaded ? <p className="p-4">Task not found</p> : <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading task…</span></p> : <div data-task-list className="min-w-0 flex flex-col flex-1">
      <ListToolbar filters={<><FilterInput label="Filter tasks" value={query} onChange={setQuery} /><ProjectSelect label="Filter by project" allLabel="All projects" projects={projects} value={projectId} onChange={setProjectId} /></>}>
        <ViewTabs value={archived ? "archived" : status} options={taskViews} onChange={value => { setArchived(value === "archived"); setStatus(value === "archived" ? "all" : value); }} />{mode === "board" ? <Select value={boardView} onValueChange={value => { if (value === "compact" || value === "full") setBoardView(value); }}><SelectTrigger aria-label="Board view"><SelectValue>{value => value === "full" ? "Full" : "Compact"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="compact">Compact</SelectItem><SelectItem value="full">Full</SelectItem></SelectContent></Select> : null}{mode === "board" ? <Select value={boardShow} onValueChange={value => { const option = boardShowOptions.find(([candidate]) => candidate === value); if (option) setBoardShow(option[0]); }}><SelectTrigger aria-label="Show tasks or moves"><SelectValue>{() => boardShowOptions.filter(([value]) => value === boardShow).map(([value, label, Icon]) => <Fragment key={value}><Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />{label}</Fragment>)}</SelectValue></SelectTrigger><SelectContent className="w-max min-w-(--anchor-width)">{boardShowOptions.map(([value, label, Icon]) => <SelectItem key={value} value={value}><Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />{label}</SelectItem>)}</SelectContent></Select> : null}{mode === "board" ? <Select value={boardStatus} onValueChange={value => setBoardStatus(value ?? "all")}><SelectTrigger aria-label="Filter by status"><SelectValue>{value => value === "all" ? <><ListFilter aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />All statuses</> : <><TaskStatusIcon status={TaskControlStatusSchema.parse(value)} />{taskStatusLabels[TaskControlStatusSchema.parse(value)]}</>}</SelectValue></SelectTrigger><SelectContent className="w-max min-w-(--anchor-width)"><SelectItem value="all"><ListFilter aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />All statuses</SelectItem>{TaskControlStatusSchema.options.map(value => <SelectItem key={value} value={value}><TaskStatusIcon status={value} />{taskStatusLabels[value]}</SelectItem>)}</SelectContent></Select> : null}
      </ListToolbar>
      {!loaded ? <LoadingState /> : !visible.length && !boardRuns.length && (mode !== "board" || boardView === "compact") ? hasFilters ? <EmptyState icon={ClipboardList} title="No matching tasks" description="Change the filters to find your tasks." action={<Button variant="outline" onClick={() => { setQuery(""); setStatus("all"); setProjectId("all"); setBoardStatus("all"); setBoardShow("all"); setArchived(false); }}>Clear filters</Button>} /> : <Empty><TasksIllustration /><EmptyHeader><h2 className="whitespace-nowrap text-center text-xl font-extralight tracking-tight sm:text-3xl">You write the task. <span className="text-primary">Your agents do the work.</span></h2></EmptyHeader><EmptyContent><NewButton disabled={currentCompany?.status !== "active"} onClick={() => requestNewTask()}>{hasProjects === false ? "Add project" : "New task"}</NewButton></EmptyContent></Empty> : mode === "board" ? <div className="max-w-full overflow-x-auto px-3 py-1 sm:px-4" data-task-board><div className="flex min-h-[calc(100dvh-12rem)] w-max gap-2">{groups.filter(value => (boardStatus === "all" || value === boardStatus) && (boardView === "full" || visible.some(task => task.status === value) || value === "active" && planHeld > 0 || value === "delivered" && boardRuns.length > 0)).map(value => <section key={value} className="w-72 shrink-0 rounded-md bg-muted/45" aria-label={taskStatusLabels[value]}><header className="flex h-10 items-center gap-2 px-3 text-xs"><TaskStatusIcon status={value} /><h2 className="font-medium">{taskStatusLabels[value]}</h2><span className="text-muted-foreground">{visible.filter(task => task.status === value).length + (value === "delivered" ? boardRuns.length : 0)}</span><div className="ml-auto"><Button size="icon-xs" variant="ghost" aria-label={`New task in ${taskStatusLabels[value]}`} onClick={() => requestNewTask()}><Plus /></Button></div></header><ul className="grid grid-cols-1 gap-2 px-2 pb-2">{value === "active" && planHeld > 0 && companyId ? <PlanLimitCard queued={planHeld} billingHref={user?.role === "admin" ? billingSettingsPath(companyId) : undefined} /> : null}{boardColumn(value)}</ul></section>)}</div></div> : <DataList columns={listColumns} label="Tasks" header={<><span data-task-column="title" className="pl-0">Task</span><span data-task-column="project">Project</span><span data-task-column="branch">Branch</span><span data-task-column="status">Status</span><span data-task-column="pr">PR</span><span data-task-column="cost" className="text-right">Cost</span><span data-task-column="time" className="text-right">Updated</span></>}>{listGroups.flatMap(value => { const column = visible.filter(task => task.status === value); return value === "queued" ? queueOrder(column) : column; }).map(task => <TaskRow key={task.id} task={task} project={project(task.projectId)} cost={costs.get(task.id)} />)}</DataList>}
    </div>}
  </ApplicationFrame>;
}

/** Tells why the queue does not move on Free, at the top of the Active column. The trial offer comes from the billing summary. */
function PlanLimitCard({ queued, billingHref }: { queued: number; billingHref: string | undefined }): ReactElement {
  const [trial, setTrial] = useState(false);
  useEffect(() => { if (billingHref) void getBillingSummary().then(summary => setTrial(summary.trialAvailable), () => undefined); }, [billingHref]);
  return <li className="min-w-0"><Card highlighted size="sm" data-plan-limit-card>
    <CardHeader><CardTitle>{queued === 1 ? "1 task is ready." : `${queued} tasks are ready.`} {FREE_RUNNING_TASKS} slots are full.</CardTitle><CardDescription>Free runs {FREE_RUNNING_TASKS} tasks at a time. Pro runs the full queue at the same time.</CardDescription></CardHeader>
    {billingHref ? <CardContent><Button size="sm" nativeButton={false} render={<a href={billingHref} />}><Zap />{trial ? `Start ${queued === 1 ? "it" : `all ${queued}`} with a free trial` : `Go Pro and start ${queued === 1 ? "it" : `all ${queued}`}`}</Button>{trial ? <p className="text-xs text-muted-foreground">No credit card is necessary.</p> : null}</CardContent> : null}
  </Card></li>;
}

// A pushed change replaces one task object. Memoized cards and rows keep the other tasks from rendering again.
const BoardTaskCard = memo(function BoardTaskCard({ task, project }: { task: TaskListTask; project: ApiProject | undefined }): ReactElement {
  return <li className="min-w-0"><a href={withCompany(`/board/${task.id}`, task.companyId)} className="block min-w-0 rounded-md border bg-card p-3 text-xs hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"><span className="flex min-w-0 items-center gap-2 font-medium leading-5"><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="min-w-0 truncate">{task.issueKey ? <span className="mr-2 text-muted-foreground">{task.issueKey}</span> : null}{task.title}</span></span>{task.blockedBy.length ? <p data-task-blocked-by className="mt-1 truncate text-muted-foreground">{blockedByLabel(task.blockedBy)}</p> : null}{task.humanQuestion ? <p className="mt-1 truncate text-muted-foreground">{task.humanQuestion.text}</p> : null}<span className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground"><ProjectLabel project={project} fallback={task.configuration.repository} />{task.status === "active" || task.status === "delivered" ? <TaskCardDuration key={task.statusChangedAt} task={task} /> : null}</span></a></li>;
});

function BoardRunCard({ move, run, project }: { move: MoveResponse; run: MoveRunResponse; project: ApiProject | undefined }): ReactElement {
  return <li className="min-w-0"><a href={withCompany(`/moves/${move.id}/runs/${run.id}`, move.companyId)} className="block min-w-0 rounded-md border bg-card p-3 text-xs hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"><span className="flex min-w-0 items-center gap-2 font-medium leading-5"><Zap aria-hidden="true" className={`size-3.5 shrink-0 ${run.live ? "text-primary motion-safe:animate-pulse" : "text-muted-foreground"}`} /><span className="min-w-0 truncate">{move.name}</span></span><p className="mt-1 truncate text-muted-foreground">{run.live ? "Live" : "Ended"} · {relativeTime(run.startedAt)}</p><span className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground"><ProjectLabel project={project} fallback="Not available" /></span></a></li>;
}

export const TaskRow = memo(function TaskRow({ task, project, cost }: { task: TaskListTask; project: ApiProject | undefined; cost: ReturnType<typeof useTaskCosts> extends Map<string, infer Value> ? Value | undefined : never }): ReactElement {
  const settled = task.status === "delivered" || task.status === "cancelled";
  return <DataListRow data-task-row>
    <a className="col-span-full row-start-1 grid min-w-0 grid-cols-subgrid items-center focus-visible:outline-2 focus-visible:outline-ring" href={withCompany(`/tasks/${task.id}`, task.companyId)}>
      <span data-task-title className="flex min-w-0 items-center gap-2.5"><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="flex min-w-0 flex-col"><span className="flex min-w-0 items-baseline gap-2">{task.issueKey ? <span className="shrink-0 text-muted-foreground">{task.issueKey}</span> : null}<span className={`truncate ${settled ? "text-muted-foreground" : "text-foreground"} not-dark:font-medium`}>{task.title}</span></span></span></span>
      <span data-task-project className="hidden min-w-0 items-center gap-2 text-muted-foreground lg:flex"><ProjectLabel project={project} fallback="Not available" /></span>
      <span data-task-branch className="hidden min-w-0 truncate font-mono text-muted-foreground lg:block text-[12px]" title={task.configuration.branch}>{task.configuration.branch}</span>
      <span data-task-status className="hidden lg:block"><TaskStatus status={task.status} pullRequestState={task.pullRequest?.state} /></span>
      <span className="hidden lg:block">{task.pullRequest ? null : <span className="text-muted-foreground">—</span>}</span>
      <span data-task-cost className="hidden text-right tabular-nums text-muted-foreground lg:block">{cost?.cost != null ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} suffix={cost.partial ? "+" : ""} /> : null}</span>
      <time data-task-time dateTime={task.updatedAt} className="col-start-2 row-start-1 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground lg:col-auto lg:row-auto">{new Date(task.updatedAt).toDateString() === new Date().toDateString() ? relativeTime(task.updatedAt) : shortDate.format(new Date(task.updatedAt))}</time>
      <span data-task-compact-details className="col-span-2 flex min-w-0 items-center gap-2 pl-6 text-xs text-muted-foreground lg:hidden"><span data-task-compact-project className="flex min-w-0 items-center gap-1.5"><ProjectLabel project={project} fallback="Not available" /></span><span data-task-compact-cost className="ml-auto shrink-0 text-right tabular-nums">{cost?.cost != null ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} suffix={cost.partial ? "+" : ""} /> : null}</span></span>
    </a>
    {task.pullRequest ? <span data-task-pr className="pointer-events-none relative z-10 col-start-5 row-start-1 hidden lg:block"><a href={task.pullRequest.url} target="_blank" rel="noreferrer" className="pointer-events-auto underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">#{task.pullRequest.number}</a></span> : null}
  </DataListRow>;
});
