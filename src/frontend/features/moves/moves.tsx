import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { Archive, ChevronDown, ChevronRight, Ellipsis, Pencil, Play, RotateCcw, Sparkles, Square, SquareTerminal, Trash2, Zap } from "lucide-react";

import { EmptyState } from "../../components/app/empty-state.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Empty, EmptyContent, EmptyHeader } from "../../components/ui/empty.js";
import { LoadingState } from "../../components/app/loading-state.js";
import { ProjectLabel } from "../../components/app/project-label.js";
import { ProjectSelect } from "../../components/app/project-select.js";
import { DataList, DataListRow, FilterInput, ListToolbar, ViewTabs } from "../../components/app/data-list.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import type { MoveOutcome } from "../../contracts/generated/MoveOutcome.js";
import type { MoveResponse } from "../../contracts/generated/MoveResponse.js";
import type { MoveRunResponse } from "../../contracts/generated/MoveRunResponse.js";
import type { Task } from "../../contracts/tasks.js";
import { withCompany } from "../../lib/api.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { navigate } from "../../shell/navigation-state.js";
import { relativeTime, type ApiProject } from "../../shell/view-shared.js";
import { listProjects } from "../projects/lib/project-api.js";
import { useTaskData } from "../tasks/task-data.js";
import { TaskStatusIcon, TaskTitleLink } from "../tasks/task-status.js";
import { archiveMoveRun, endMoveRun, listMoveRuns, listMoves, startMove } from "./lib/move-api.js";
import { DeleteMoveDialog, MoveDialog, runnerLabels } from "./move-dialog.js";
import { MovesIllustration } from "./moves-illustration.js";
import { MoveRunView } from "./move-run.js";
import { runsInTerminal } from "./lib/move-runs.js";
import { RecommendMoves } from "./recommend-moves.js";
import { RunBadge } from "./run-badge.js";
import { asksForInputs, StartMoveDialog } from "./start-move-dialog.js";

const moveViews = [["all", "All"], ["live", "Live"], ["ended", "Ended"]] as const;
/** Move, project, runner, status, last run, and Start columns of the wide move list. */
const moveColumns = "lg:grid-cols-[minmax(12rem,1fr)_fit-content(12rem)_repeat(4,max-content)]";
const outcomeLabels = { created: "Started", excluded: "Excluded", has_task: "Has a task", failed: "Failed" } as const;

/** Opens the row target. A click on a control in the row keeps the control behavior. */
const rowClick = (open: () => void) => (event: MouseEvent<HTMLTableRowElement>): void => {
  if (!(event.target as HTMLElement).closest("a, button, input, label")) open();
};

export function MovesView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id;
  const [, moveId, runId] = /^\/moves\/([^/]+)(?:\/runs\/([^/]+))?$/.exec(window.location.pathname) ?? [];
  const [moves, setMoves] = useState<MoveResponse[] | null>(null);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [runs, setRuns] = useState<MoveRunResponse[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ move: MoveResponse | null } | null>(null);
  const [starting, setStarting] = useState<{ move: MoveResponse; prefill: MoveRunResponse | null } | null>(null);
  const launching = useRef(false);
  const [deleting, setDeleting] = useState<MoveResponse | null>(null);
  const [recommending, setRecommending] = useState(false);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [view, setView] = useState<(typeof moveViews)[number][0]>("all");
  const tasks = useTaskData().data ?? [];
  const reload = useCallback(async () => {
    if (!companyId) return;
    try {
      const [nextMoves, nextProjects, nextRuns] = await Promise.all([listMoves(companyId), listProjects(companyId), moveId ? listMoveRuns(moveId) : Promise.resolve(null)]);
      setMoves(nextMoves); setProjects(nextProjects); setRuns(nextRuns); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Moves are not available"); }
  }, [companyId, moveId]);
  useEffect(() => { setRuns(null); void reload(); }, [reload, runId]);
  const visible = (moves ?? []).filter(move => (view === "all" || (view === "live") === Boolean(move.lastRun?.live) && Boolean(move.lastRun)) && (projectId === "all" || move.projectId === projectId) && move.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = moveId ? moves?.find(move => move.id === moveId) : undefined;
  const project = (id: string): ApiProject | undefined => projects.find(item => item.id === id);
  const change = (operation: Promise<void>): void => {
    operation.then(reload, (cause: unknown) => setError(cause instanceof Error ? cause.message : "Suplex could not change the run"));
  };
  // A move without inputs needs no form: it starts now, or after its confirmation.
  const begin = (move: MoveResponse, prefill: MoveRunResponse | null): void => {
    if (asksForInputs(move) || move.confirm) { setStarting({ move, prefill }); return; }
    if (launching.current) return;
    launching.current = true;
    startMove(move.id, { inputs: {}, excludedPullRequests: [], idempotencyKey: crypto.randomUUID() })
      .then(started, (cause: unknown) => setError(cause instanceof Error ? cause.message : "Suplex could not start the move."))
      .finally(() => { launching.current = false; });
  };
  const started = (run: MoveRunResponse): void => {
    setStarting(null);
    const taskId = run.runner === "task" ? run.outcomes[0]?.taskId : undefined;
    if (runsInTerminal(run.runner)) navigate(withCompany(`/moves/${run.moveId}/runs/${run.id}`, companyId));
    else if (taskId) navigate(withCompany(`/tasks/${taskId}`, companyId));
    else if (moveId === run.moveId && !runId) void reload();
    else navigate(withCompany(`/moves/${run.moveId}`, companyId));
  };
  const headerPrimary = selected
    ? <><Button variant="ghost" size="sm" onClick={() => setEditing({ move: selected })}><Pencil />Edit</Button><Button size="sm" onClick={() => begin(selected, null)}><Play />Start</Button></>
    : moveId ? undefined : <>{moves?.length && projects.length ? <Button variant="ghost" size="sm" aria-label="Recommend moves" title="Recommend moves" onClick={() => setRecommending(true)}><Sparkles /><span className="hidden sm:inline">Recommend moves</span></Button> : null}<NewButton disabled={!projects.length} onClick={() => setEditing({ move: null })}>New move</NewButton></>;
  const recommendFor = projectId !== "all" ? projectId : projects[0]?.id ?? "";
  const imported = (): void => { setRecommending(false); void reload(); };
  return <ApplicationFrame title={selected?.name ?? "Moves"} headerPrimary={headerPrimary} viewportBound={Boolean(selected && runId)}>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!moves ? <LoadingState /> : moveId ? selected ? runId ? <MoveRunView key={runId} move={selected} runId={runId} project={project(selected.projectId)} onClose={() => { navigate(withCompany(`/moves/${selected.id}`, selected.companyId)); }} onStartAgain={run => begin(selected, run)} /> : <RunHistory runs={runs} tasks={tasks} companyId={selected.companyId} onStart={() => begin(selected, null)} onStartAgain={run => begin(selected, run)} onStop={run => change(endMoveRun(run.id))} onArchive={run => change(archiveMoveRun(run.id))} /> : <EmptyState icon={Zap} title="Move not found" /> : moves.length ? <div className="flex min-w-0 flex-1 flex-col">
      <ListToolbar filters={<><FilterInput label="Filter moves" value={query} onChange={setQuery} /><ProjectSelect label="Filter by project" allLabel="All projects" projects={projects} value={projectId} onChange={setProjectId} /></>}>
        <ViewTabs value={view} options={moveViews} onChange={setView} />
      </ListToolbar>
      {visible.length ? <DataList columns={moveColumns} label="Moves" header={<><span>Move</span><span>Project</span><span>Runs</span><span>Status</span><span className="text-right">Last run</span><span /></>}>
        {visible.map(move => <MoveRow key={move.id} move={move} project={project(move.projectId)} tasks={tasks} onStart={() => begin(move, null)} onDelete={() => setDeleting(move)} />)}
      </DataList> : <EmptyState icon={Zap} title="No matching moves" description="Change the filters to find your moves." action={<Button variant="outline" onClick={() => { setQuery(""); setProjectId("all"); setView("all"); }}>Clear filters</Button>} />}
    </div> : <Empty><MovesIllustration /><EmptyHeader><h2 className="whitespace-nowrap text-center text-xl font-extralight tracking-tight sm:text-3xl">You write the move. <span className="text-primary">Suplex runs it.</span></h2></EmptyHeader><EmptyContent><NewButton disabled={!projects.length} onClick={() => setEditing({ move: null })}>New move</NewButton></EmptyContent>{companyId && recommendFor ? <div className="w-full max-w-4xl text-left"><RecommendMoves companyId={companyId} projects={projects} moves={moves} initialProjectId={recommendFor} onImported={imported} /></div> : null}</Empty>}
    {companyId && recommendFor ? <Dialog open={recommending} onOpenChange={setRecommending}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>Recommend moves</DialogTitle><DialogDescription>Your default agent reads the project and proposes moves for the commands it defines.</DialogDescription></DialogHeader>{recommending ? <RecommendMoves companyId={companyId} projects={projects} moves={moves ?? []} initialProjectId={recommendFor} onImported={imported} /> : null}</DialogContent></Dialog> : null}
    {companyId ? <MoveDialog companyId={companyId} projects={projects} move={editing?.move ?? null} open={Boolean(editing)} onOpenChange={open => { if (!open) setEditing(null); }} onSaved={move => { setEditing(null); void reload(); if (!moveId) navigate(withCompany(`/moves/${move.id}`, move.companyId)); }} onDeleted={() => { setEditing(null); navigate(withCompany("/moves", companyId)); }} /> : null}
    <DeleteMoveDialog move={deleting} open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null); }} onDeleted={() => void reload()} />
    {starting ? <StartMoveDialog move={starting.move} prefill={starting.prefill} open onOpenChange={open => { if (!open) setStarting(null); }} onStarted={started} /> : null}
  </ApplicationFrame>;
}

function MoveRow({ move, project, tasks, onStart, onDelete }: { move: MoveResponse; project: ApiProject | undefined; tasks: Task[]; onStart: () => void; onDelete: () => void }): ReactElement {
  const lastRun = move.lastRun;
  return <DataListRow data-move-row>
    <a className="col-span-full row-start-1 grid min-w-0 grid-cols-subgrid items-center focus-visible:outline-2 focus-visible:outline-ring" href={withCompany(`/moves/${move.id}`, move.companyId)}>
      <span className="flex min-w-0 items-center gap-2.5"><Zap aria-hidden="true" className={`size-3.5 shrink-0 ${lastRun?.live ? "text-primary motion-safe:animate-pulse" : "text-muted-foreground"}`} /><span className="truncate text-base text-foreground not-dark:font-medium">{move.name}</span></span>
      <span className="hidden min-w-0 items-center gap-2 text-muted-foreground lg:flex"><ProjectLabel project={project} fallback="Not available" /></span>
      <span className="hidden text-muted-foreground lg:block">{runnerLabels[move.runner]}</span>
      <span className="hidden lg:flex">{lastRun ? <RunStatus run={lastRun} tasks={tasks} /> : <span className="text-muted-foreground">—</span>}</span>
      <span className="hidden text-right lg:block">{lastRun ? <time className="font-mono text-xs tabular-nums text-muted-foreground" dateTime={lastRun.startedAt}>{relativeTime(lastRun.startedAt)}</time> : null}</span>
      <span className="hidden lg:block" />
      <span className="col-span-2 flex min-w-0 items-center gap-2 pl-6 text-xs text-muted-foreground lg:hidden"><span className="flex min-w-0 items-center gap-1.5"><ProjectLabel project={project} fallback="Not available" /></span>{lastRun ? <time className="shrink-0 font-mono tabular-nums" dateTime={lastRun.startedAt}>· {relativeTime(lastRun.startedAt)}</time> : null}</span>
    </a>
    <span className="relative z-10 col-start-2 row-start-1 flex items-center gap-1 lg:col-start-6">
      <Button variant="ghost" size="sm" onClick={onStart}><Play />Start</Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${move.name} actions`} title="More actions" />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2 />Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </span>
  </DataListRow>;
}

function taskFor(outcome: MoveOutcome, tasks: Task[]): Task | undefined {
  return outcome.taskId ? tasks.find(task => task.id === outcome.taskId) : undefined;
}

/** Status comes from each started task. A failed start shows as failed. */
function RunStatus({ run, tasks }: { run: MoveRunResponse; tasks: Task[] }): ReactElement {
  if (runsInTerminal(run.runner)) return <RunBadge live={run.live} />;
  const failed = run.outcomes.filter(outcome => outcome.kind === "failed").length;
  const started = run.outcomes.map(outcome => taskFor(outcome, tasks)).filter(task => task !== undefined);
  return <span className="flex items-center gap-1">
    {started.slice(0, 8).map(task => <TaskStatusIcon key={task.id} status={task.status} pullRequestState={task.pullRequest?.state} />)}
    {started.length > 8 ? <span className="text-xs text-muted-foreground">+{started.length - 8}</span> : null}
    {failed ? <Badge variant="destructive">{failed} failed</Badge> : null}
  </span>;
}

function RunHistory({ runs, tasks, companyId, onStart, onStartAgain, onStop, onArchive }: { runs: MoveRunResponse[] | null; tasks: Task[]; companyId: string; onStart: () => void; onStartAgain: (run: MoveRunResponse) => void; onStop: (run: MoveRunResponse) => void; onArchive: (run: MoveRunResponse) => void }): ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  if (!runs) return <LoadingState />;
  if (!runs.length) return <EmptyState icon={Zap} title="No runs" action={<Button onClick={onStart}><Play />Run now</Button>} />;
  return <Table>
    <TableHeader><TableRow><TableHead /><TableHead>Status</TableHead><TableHead className="hidden md:table-cell">Inputs</TableHead><TableHead>Tasks</TableHead><TableHead>Started</TableHead><TableHead className="hidden md:table-cell">By</TableHead><TableHead /></TableRow></TableHeader>
    <TableBody>{runs.map(run => {
      const expanded = open === run.id;
      const single = run.outcomes.length === 1 ? run.outcomes[0] : undefined;
      const singleTask = single ? taskFor(single, tasks) : undefined;
      const openRow = runsInTerminal(run.runner) ? () => navigate(withCompany(`/moves/${run.moveId}/runs/${run.id}`, companyId))
        : run.outcomes.length > 1 ? () => setOpen(expanded ? null : run.id)
        : singleTask ? () => navigate(withCompany(`/tasks/${singleTask.id}`, companyId)) : undefined;
      return <Fragment key={run.id}>
        <TableRow className={openRow ? "cursor-pointer" : undefined} onClick={openRow ? rowClick(openRow) : undefined}>
          <TableCell>{run.outcomes.length > 1 ? <Button variant="ghost" size="icon-xs" aria-label={expanded ? "Hide the pull requests" : "Show the pull requests"} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : run.id)}>{expanded ? <ChevronDown /> : <ChevronRight />}</Button> : null}</TableCell>
          <TableCell><RunStatus run={run} tasks={tasks} /></TableCell>
          <TableCell className="hidden md:table-cell"><span className="flex flex-wrap gap-1">{Object.entries(run.inputs).map(([name, value]) => <Badge key={name} variant="outline">{name} {value || "∅"}</Badge>)}{run.excludedPullRequests.map(number => <Badge key={number} variant="secondary">−#{number}</Badge>)}</span></TableCell>
          <TableCell>{runsInTerminal(run.runner) ? <a className="flex items-center gap-1.5 underline-offset-2 hover:underline" href={withCompany(`/moves/${run.moveId}/runs/${run.id}`, companyId)}><SquareTerminal className="size-3.5 text-muted-foreground" />Terminal</a> : singleTask ? <TaskTitleLink task={singleTask} companyId={companyId} /> : single ? <span className="whitespace-normal text-muted-foreground">{single.reason ?? single.title}</span> : <span className="text-muted-foreground">{run.outcomes.filter(outcome => outcome.kind === "created").length} of {run.outcomes.length}</span>}</TableCell>
          <TableCell><time className="text-xs text-muted-foreground" dateTime={run.startedAt}>{relativeTime(run.startedAt)}</time></TableCell>
          <TableCell className="hidden text-muted-foreground md:table-cell">{run.startedBy ? <span className="flex items-center gap-2">{run.startedById ? <EntityAvatar kind="user" id={run.startedById} name={run.startedBy} size="xs" /> : null}{run.startedBy}</span> : "—"}</TableCell>
          <TableCell className="text-right"><span className="inline-flex">
            {run.live ? <Button variant="ghost" size="icon-sm" aria-label="Stop" title="Stop" onClick={() => onStop(run)}><Square /></Button> : <Button variant="ghost" size="icon-sm" aria-label="Archive" title="Archive" onClick={() => onArchive(run)}><Archive /></Button>}
            <Button variant="ghost" size="icon-sm" aria-label="Start again" title="Start again" onClick={() => onStartAgain(run)}><RotateCcw /></Button>
          </span></TableCell>
        </TableRow>
        {expanded ? run.outcomes.map(outcome => {
          const task = taskFor(outcome, tasks);
          return <TableRow key={`${run.id}:${outcome.pullRequest ?? outcome.title}`} className={task ? "cursor-pointer" : undefined} onClick={task ? rowClick(() => navigate(withCompany(`/tasks/${task.id}`, companyId))) : undefined}>
            <TableCell />
            <TableCell>{outcome.kind === "created" ? null : <Badge variant={outcome.kind === "failed" ? "destructive" : "outline"}>{outcomeLabels[outcome.kind]}</Badge>}</TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">{outcome.pullRequest ? `#${outcome.pullRequest}` : null}</TableCell>
            <TableCell colSpan={4}>{task ? <TaskTitleLink task={task} companyId={companyId} /> : <span className="whitespace-normal text-muted-foreground">{outcome.reason ? `${outcome.title}: ${outcome.reason}` : outcome.title}</span>}</TableCell>
          </TableRow>;
        }) : null}
      </Fragment>;
    })}</TableBody>
  </Table>;
}
