import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { readJson, withCompany } from "../lib/api.js";
import { navigate } from "../lib/navigation.js";
import type { Task } from "../../task-contracts.js";
import { TaskControlStatusSchema } from "../../task-control.js";
import { NewTaskDialog } from "../components/app/new-task-dialog.js";
import { TaskDetailsPage } from "./task-details.js";

export const taskStatusLabels = { backlog: "Backlog", active: "Active", waiting_human: "Answer necessary", cancelled: "Cancelled", delivered: "Delivered" };

export function TasksView({ mode = "list" }: { mode?: "list" | "board" }): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  const selectedId = /^\/(?:tasks|board)\/([^/]+)$/.exec(window.location.pathname)?.[1];
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const scope = `${companyId}:${selectedId}:${archived}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const reload = useCallback(async () => {
    if (!companyId) return;
    const [result, task] = await Promise.all([
      readJson<{ tasks: Task[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks?archived=${archived}`),
      selectedId ? readJson<Task>(`/api/tasks/${encodeURIComponent(selectedId)}`) : Promise.resolve(null),
    ]);
    if (currentScope.current !== scope) return;
    if (task && task.companyId !== companyId) throw new Error("This task is not in the selected company");
    setTasks(result.tasks);
    setSelected(task);
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
  useEffect(() => {
    const open = () => setCreateOpen(true);
    window.addEventListener("forge:new-task", open);
    return () => window.removeEventListener("forge:new-task", open);
  }, []);
  const visible = tasks.filter(task => (status === "all" || task.status === status) && `${task.issueKey} ${task.title}`.toLowerCase().includes(query.toLowerCase()));
  return <ApplicationFrame title={selected?.issueKey ?? (mode === "board" ? "Board" : "Tasks")} headerRight={<><Button variant="ghost" size="icon-sm" aria-label="Check tasks" onClick={() => void reload().catch(error => setError(String(error)))}><RefreshCw /></Button><Button size="sm" disabled={!companyId || currentCompany?.status !== "active"} onClick={() => setCreateOpen(true)}><Plus />Create task</Button></>}>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {selectedId ? selected ? <TaskDetailsPage key={selected.id} task={selected} onChange={setSelected} /> : <p className="p-4">{loaded ? "Task not found" : "Forge reads the task"}</p> : <>
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="min-w-40 flex-1"><Input aria-label="Search tasks" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tasks" /></div>
        <Select value={status} onValueChange={value => setStatus(value ?? "all")}><SelectTrigger aria-label="Task status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{TaskControlStatusSchema.options.map(value => <SelectItem key={value} value={value}>{taskStatusLabels[value]}</SelectItem>)}</SelectContent></Select>
        <Button variant="outline" size="sm" onClick={() => setArchived(value => !value)}>{archived ? "Open current tasks" : "Open archived tasks"}</Button>
      </div>
      {!loaded ? <p className="p-4">Forge reads the tasks</p> : !visible.length ? <p className="p-4">No tasks</p> : mode === "board" ? <div className="grid gap-3 p-3 md:grid-cols-3 xl:grid-cols-5">{TaskControlStatusSchema.options.map(value => <section key={value} aria-label={taskStatusLabels[value]}><h2 className="mb-2 text-xs font-medium">{taskStatusLabels[value]}</h2><ul className="divide-y">{visible.filter(task => task.status === value).map(task => <TaskRow key={task.id} task={task} />)}</ul></section>)}</div> : <ul className="divide-y" aria-label="Tasks">{visible.map(task => <TaskRow key={task.id} task={task} />)}</ul>}
    </>}
    {companyId ? <NewTaskDialog key={companyId} open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} onCreated={task => { setCreateOpen(false); navigate(withCompany(`/tasks/${task.id}`, companyId)); }} /> : null}
  </ApplicationFrame>;
}

function TaskRow({ task }: { task: Task }): ReactElement {
  return <li><a className="flex min-h-9 min-w-0 items-center gap-3 px-3 py-2 text-sm hover:bg-muted focus-visible:outline" href={withCompany(`/tasks/${task.id}`, task.companyId)}><span className="shrink-0 text-xs text-muted-foreground">{task.issueKey}</span><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="shrink-0 text-xs">{taskStatusLabels[task.status]}</span></a></li>;
}
