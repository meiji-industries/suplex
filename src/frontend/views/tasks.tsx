import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronRight, CirclePlus, Layers3, RefreshCw } from "lucide-react";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { Button } from "../components/ui/button.js";
import { NewButton } from "../components/ui/new-button.js";
import { Input } from "../components/ui/input.js";
import { Spinner } from "../components/ui/spinner.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { readJson, withCompany } from "../lib/api.js";
import type { Task } from "../../task-contracts.js";
import { TaskControlStatusSchema } from "../../task-control.js";
import { requestNewTask } from "../components/app/global-new-task-dialog.js";
import { TaskOptions } from "../components/app/task-options.js";
import { TaskDetailsPage } from "./task-details.js";
import { TaskStatus, TaskStatusIcon, taskStatusLabels } from "../components/app/task-status.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { relativeTime, type ApiProject } from "../lib/view-shared.js";

type BoardView = "compact" | "full";

export function TasksView({ mode = "list" }: { mode?: "list" | "board" }): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  const selectedId = /^\/(?:tasks|board)\/([^/]+)$/.exec(window.location.pathname)?.[1];
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [projectId, setProjectId] = useState("all");
  const [boardView, setBoardView] = useState<BoardView>("compact");
  const scope = `${companyId}:${selectedId}:${archived}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const reload = useCallback(async () => {
    if (!companyId) return;
    const [result, task, projectResult] = await Promise.all([
      readJson<{ tasks: Task[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks?archived=${archived}`),
      selectedId ? readJson<Task>(`/api/tasks/${encodeURIComponent(selectedId)}`) : Promise.resolve(null),
      readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
    ]);
    if (currentScope.current !== scope) return;
    if (task && task.companyId !== companyId) throw new Error("This task is not in the selected company");
    setTasks(result.tasks);
    setSelected(task);
    setProjects(projectResult.projects);
    setLoaded(true);
    setError("");
  }, [companyId, selectedId, archived, scope]);
  useEffect(() => {
    setSelected(null); setTasks([]); setLoaded(false);
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
    const timer = setInterval(() => void poll(), 3000);
    return () => { closed = true; clearInterval(timer); };
  }, [reload]);
  const visible = tasks.filter(task => (status === "all" || task.status === status || status === "active" && task.status === "waiting_human") && (projectId === "all" || task.projectId === projectId) && `${task.issueKey ?? ""} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = ["waiting_human", "active", "backlog", "delivered", "cancelled"] as const;
  return <ApplicationFrame title={selected ? `${selected.issueKey ? `${selected.issueKey} · ` : ""}${selected.title}` : mode === "board" ? "Board" : "Tasks"} headerActions={selected ? <TaskOptions key={selected.id} task={selected} onChange={setSelected} onError={setError} /> : null} headerRight={<><Button variant="ghost" size="icon-sm" aria-label="Check tasks" onClick={() => void reload().catch(error => setError(String(error)))}><RefreshCw /></Button><NewButton disabled={!companyId || currentCompany?.status !== "active"} onClick={() => requestNewTask()}>New task</NewButton></>}>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {selectedId ? selected ? <TaskDetailsPage key={selected.id} task={selected} project={projects.find(project => project.id === selected.projectId)} onChange={setSelected} /> : loaded ? <p className="p-4">Task not found</p> : <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Forge reads the task.</span></p> : <div data-task-list className="min-w-0">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-3 py-1 sm:px-4">
        <div className="flex max-w-full flex-wrap items-center gap-2"><div className="max-w-full overflow-x-auto"><Tabs value={archived ? "archived" : status} onValueChange={value => { setArchived(value === "archived"); setStatus(value === "archived" ? "all" : String(value)); }}><TabsList>
          <TabsTrigger value="active">Active</TabsTrigger><TabsTrigger value="backlog">Backlog</TabsTrigger><TabsTrigger value="all">All tasks</TabsTrigger><TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList></Tabs></div>{mode === "board" ? <Select value={boardView} onValueChange={value => { if (value === "compact" || value === "full") setBoardView(value); }}><SelectTrigger size="sm" aria-label="Board view"><SelectValue>{value => value === "full" ? "Full View" : "Compact View"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="compact">Compact View</SelectItem><SelectItem value="full">Full View</SelectItem></SelectContent></Select> : null}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="w-44"><Input aria-label="Search tasks" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); setQuery(""); }} placeholder="Search tasks" /></div>
          <Select value={projectId} onValueChange={value => setProjectId(value ?? "all")}><SelectTrigger size="sm" aria-label="Filter by project"><SelectValue>{value => value === "all" ? "All projects" : projects.find(project => project.id === value)?.name}</SelectValue></SelectTrigger><SelectContent><SelectItem value="all">All projects</SelectItem>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select>
        </div>
      </div>
      {!loaded ? <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Forge reads the tasks.</span></p> : !visible.length && (mode !== "board" || boardView === "compact") ? <p className="px-4 py-8 text-xs text-muted-foreground">{query.trim() ? "No tasks match the search." : "No tasks"}</p> : mode === "board" ? <div className="max-w-full overflow-x-auto p-2" data-task-board><div className="flex min-h-[calc(100dvh-12rem)] w-max gap-2">{TaskControlStatusSchema.options.filter(value => boardView === "full" || visible.some(task => task.status === value)).map(value => <section key={value} className="w-72 shrink-0 rounded-md bg-muted/45" aria-label={taskStatusLabels[value]}><header className="flex h-10 items-center gap-2 px-3 text-xs"><TaskStatusIcon status={value} /><h2 className="font-medium">{taskStatusLabels[value]}</h2><span className="text-muted-foreground">{visible.filter(task => task.status === value).length}</span><div className="ml-auto"><Button size="icon-xs" variant="ghost" aria-label={`New task in ${taskStatusLabels[value]}`} onClick={() => requestNewTask()}><CirclePlus /></Button></div></header><ul className="grid grid-cols-1 gap-2 px-2 pb-2">{visible.filter(task => task.status === value).map(task => <li key={task.id} className="min-w-0"><a href={withCompany(`/board/${task.id}`, task.companyId)} className="block min-w-0 rounded-md border bg-card p-3 text-xs hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"><span className="flex min-w-0 items-start gap-2 font-medium leading-5"><TaskStatusIcon status={task.status} /><span className="min-w-0 truncate">{task.issueKey ? <span className="mr-2 text-muted-foreground">{task.issueKey}</span> : null}{task.title}</span></span>{task.humanQuestion ? <p className="mt-1 truncate text-muted-foreground">{task.humanQuestion.text}</p> : null}<span className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground"><Layers3 className="size-3 shrink-0" /><span className="min-w-0 truncate">{projects.find(project => project.id === task.projectId)?.name ?? task.configuration.repository}</span></span></a></li>)}</ul></section>)}</div></div> : <div aria-label="Task groups" className="py-1">{groups.filter(value => visible.some(task => task.status === value)).map(value => <details key={value} open className="group/task-group pt-1"><summary className="mx-2 flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md bg-muted/60 px-2 text-xs focus-visible:outline"><ChevronRight className="size-3 transition-transform group-open/task-group:rotate-90" /><TaskStatusIcon status={value} /><span className="font-medium">{taskStatusLabels[value]}</span><span className="text-muted-foreground">{visible.filter(task => task.status === value).length}</span></summary><ul className="pt-0.5">{visible.filter(task => task.status === value).map(task => <TaskRow key={task.id} task={task} project={projects.find(project => project.id === task.projectId)} />)}</ul></details>)}</div>}
    </div>}
  </ApplicationFrame>;
}

function TaskRow({ task, project }: { task: Task; project: ApiProject | undefined }): ReactElement {
  return <li><a data-task-row className="grid min-h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 text-[13px] hover:bg-muted/40 focus-visible:outline sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:px-4" href={withCompany(`/tasks/${task.id}`, task.companyId)}><TaskStatusIcon status={task.status} /><span className="flex min-w-0 items-center gap-2">{task.issueKey ? <span className="shrink-0 text-xs text-muted-foreground">{task.issueKey}</span> : null}<span className="truncate font-medium">{task.title}</span>{project ? <><ChevronRight className="hidden size-3 shrink-0 text-muted-foreground md:block" /><span className="hidden truncate text-xs text-muted-foreground md:block">{project.name}</span></> : null}</span><span className="hidden sm:block"><TaskStatus status={task.status} /></span><time dateTime={task.updatedAt} className="w-16 text-right text-[11px] text-muted-foreground">{new Date(task.updatedAt).toDateString() === new Date().toDateString() ? relativeTime(task.updatedAt) : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(task.updatedAt))}</time></a></li>;
}
