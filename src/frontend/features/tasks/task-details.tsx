import { useEffect, useState, type ReactElement } from "react";
import { ChevronRight, ClipboardCopy, X } from "lucide-react";
import { Collapsible } from "../../components/ui/collapsible.js";
import type { Task } from "../../../tasks/contracts.js";
import { TaskActivityResponseSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";
import { adminDate, type ApiProject } from "../../shell/view-shared.js";
import { Button } from "../../components/ui/button.js";
import { BlockedByPickerDialog } from "./blocked-by-picker.js";
import { IssuePicker } from "./issue-picker.js";
import { TaskQuestion } from "./task-question.js";
import { NewTaskDialog } from "./new-task-dialog.js";
import { editTaskDraft, type NewTaskDraft } from "./lib/duplicate-task-prefill.js";
import { Badge } from "../../components/ui/badge.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Markdown } from "../../components/app/markdown.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { TaskStatus, TaskTitleLink } from "./task-status.js";
import { TaskWork, type TaskActivity } from "./task-work.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { LivePaneDock } from "./task-chat/live-pane-dock.js";
import { useTaskCosts } from "../analytics/lib/analytics.js";
import { CostValue } from "../../components/app/cost-value.js";
import { Progress, ProgressLabel, ProgressValue } from "../../components/ui/progress.js";
import { WorkflowHistory, WorkflowStatus } from "./workflow-history.js";
import { TaskPullRequestCard } from "./pull-request-card.js";
import { TaskWorktreeMenu } from "./task-worktree-menu.js";
import { ADVISOR_LABELS, workflowDefinition, type AdvisorRole } from "../../../coordination/workflows.js";

function CopyValue({ label, value, children }: { label: string; value: string; children: ReactElement }): ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1_500); return () => clearTimeout(timer); }, [copied]);
  return <span className="flex min-w-0 items-center gap-1.5">
    <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={copied ? `Copied ${label}` : `Copy ${label}`} title={copied ? "Copied" : "Copy"} onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false)); }}><ClipboardCopy className="size-3.5" /></button>
    {children}
  </span>;
}

/** The Blocked by prerequisites of a task. Each change saves the complete prerequisite set through the dependency route, so removing one keeps the others. */
/** Each incomplete Blocked by task with the exact reason the backlog task waits for it. */
export function TaskQueueWaits({ task }: { task: Pick<Task, "companyId" | "queue"> }): ReactElement {
  return <ul data-task-queue-waits aria-label="Waiting for" className="space-y-1 text-xs">{task.queue.waitingOn.map(wait => <li key={wait.id} data-task-queue-wait={wait.id} data-reason={wait.reason} className="flex min-w-0 flex-wrap items-center gap-x-1"><TaskTitleLink task={wait} companyId={task.companyId} /><span className="text-muted-foreground">{wait.summary.startsWith(wait.title) ? wait.summary.slice(wait.title.length).trim() : wait.summary}</span></li>)}</ul>;
}

/** Start queues a task: Forge starts it by itself when every Blocked by task is complete. */
export function backlogText(queue: Task["queue"]): string {
  if (queue.state === "queued") return queue.waitingOn.length ? "Queued. This task starts by itself when its Blocked by tasks are complete." : "Queued. Forge starts this task now.";
  return queue.waitingOn.length ? "Backlog. Queue this task to start it by itself when its Blocked by tasks are complete." : "The task is ready to start.";
}

export function TaskBlockedByProperty({ task, onChange }: { task: Pick<Task, "id" | "companyId" | "projectId" | "status" | "blockedBy">; onChange: (task: Task) => void }): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ids = task.blockedBy.map(prerequisite => prerequisite.id);
  const submit = async (dependsOn: string[]) => {
    if (busy) return;
    setBusy(true); setError("");
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}/dependencies`, { method: "PUT", body: JSON.stringify({ dependsOn }) })); }
    catch (error) { setError(error instanceof Error ? error.message : "The Blocked by tasks could not be saved"); }
    finally { setBusy(false); }
  };
  const openPicker = () => { setError(""); setPickerOpen(true); };
  return <div className="space-y-1.5"><dt className="text-muted-foreground">Blocked by</dt><dd className="flex min-w-0 flex-col items-start gap-1">{task.blockedBy.map(prerequisite => <span key={prerequisite.id} data-blocked-by-task={prerequisite.id} className="flex w-full min-w-0 items-center gap-1"><TaskTitleLink task={prerequisite} companyId={task.companyId} className="min-w-0 flex-1" /><Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${prerequisite.title} from Blocked by`} disabled={busy} onClick={() => void submit(ids.filter(id => id !== prerequisite.id))}><X /></Button></span>)}<Button type="button" size="xs" variant="ghost" aria-label={ids.length ? "Add Blocked by task" : undefined} disabled={busy} onClick={openPicker}>{ids.length ? "Add" : "None"}</Button></dd>{error ? <dd role="alert" className="text-destructive">{error}</dd> : null}<BlockedByPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} companyId={task.companyId} projectId={task.projectId} excludeTaskIds={[task.id, ...ids]} onSelect={selected => void submit([...ids, selected.id])} onError={setError} /></div>;
}

export function TaskDetailsPage({ task, project, onChange }: { task: Task; project: ApiProject | undefined; onChange: (task: Task) => void }): ReactElement {
  const cost = useTaskCosts(task.companyId).get(task.id);
  const costTitle = cost ? undefined : "OpenCode estimates are not bills. Zero does not verify free usage.";
  const [activity, setActivity] = useState<TaskActivity>({ sessions: [], turns: [], shellPaneId: null });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<Task["images"][number] | null>(null);
  const [edit, setEdit] = useState<NewTaskDraft | null>(null);
  const editable = task.status === "backlog" && !task.archivedAt;
  useEffect(() => {
    let closed = false;
    const load = async () => { try { const result = TaskActivityResponseSchema.parse(await readJson(`/api/tasks/${task.id}/activity`)); if (!closed) setActivity(result); } catch (error) { if (!closed) setError(error instanceof Error ? error.message : "Task activity is not available"); } };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { closed = true; clearInterval(timer); };
  }, [task.id]);
  const act = async (action: string, body?: unknown) => {
    if (busy) return;
    setBusy(true); setError("");
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}/${action}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) })); }
    catch (error) { setError(error instanceof Error ? error.message : "The action failed"); }
    finally { setBusy(false); }
  };
  return <article data-task-detail className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div data-task-body className="grid min-h-0 min-w-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_260px]">
      <div data-task-main className="flex min-w-0 flex-col">
        <header className="px-4 pb-3 pt-4 sm:px-6 lg:px-10"><div className="mx-auto flex max-w-4xl min-w-0 items-start justify-between gap-3"><h2 className="min-w-0 flex-1 text-xl font-semibold leading-8" aria-label={task.title}>{task.title}</h2>{task.worktree ? <TaskWorktreeMenu taskId={task.id} path={task.worktree.path} onError={setError} /> : null}</div></header>
        <div data-task-content className="min-w-0 px-4 pb-6 pt-4 sm:px-6 lg:px-10"><div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <Markdown source={task.description} />
          {task.images.length ? <ul className="flex flex-wrap gap-2" aria-label="Task images">{task.images.map(item => <li key={item.artifactId}><button type="button" className="size-16 overflow-hidden rounded-md border bg-muted/30 focus-visible:outline" aria-label={`Open ${item.filename}`} onClick={() => setImage(item)}><img className="size-full object-cover" src={`/api/tasks/${task.id}/images/${item.artifactId}`} alt={item.filename} /></button></li>)}</ul> : null}
          {task.artifacts?.length ? <section aria-label="Delivery evidence"><h3>Delivery evidence</h3><ul className="space-y-1">{task.artifacts.map(item => <li key={item.artifactId}><a href={`/api/tasks/${task.id}/artifacts/${item.artifactId}`} target="_blank" rel="noreferrer">{item.filename}</a><span className="ml-2 text-xs text-muted-foreground">{item.byteSize.toLocaleString()} bytes</span></li>)}</ul></section> : null}
          {task.status !== "active" || task.pullRequest || task.humanQuestion || ["pull_request_ready", "merged"].includes(task.deliveryTarget) ? <div data-task-current className="-mx-4 border-y px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10"><div className="mx-auto max-w-4xl space-y-3">
            {task.pullRequest || ["active", "delivered"].includes(task.status) && ["pull_request_draft", "pull_request_ready", "merged"].includes(task.deliveryTarget) ? <TaskPullRequestCard task={task} onChange={onChange} /> : task.status === "active" ? null : <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{task.status === "backlog" ? backlogText(task.queue) : task.status === "delivered" ? "The delivery target is complete." : task.status === "cancelled" ? "The task is cancelled." : "Coordinator needs your answer."}</p>{editable ? <span className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setEdit(editTaskDraft(task))}>Edit task</Button>{task.queue.state === "queued" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("disarm")}>Disarm</Button> : <Button size="sm" disabled={busy} onClick={() => void act("start")}>{task.queue.waitingOn.length ? "Queue task" : "Start task"}</Button>}</span> : null}</div>}
            {task.status === "backlog" && task.queue.waitingOn.length ? <TaskQueueWaits task={task} /> : null}
            {task.humanQuestion ? <TaskQuestion key={task.humanQuestion.id} question={task.humanQuestion} busy={busy} onAnswer={answer => act("answer", { questionId: task.humanQuestion?.id, ...answer })} onLimitDecision={limitDecision => act("answer", { questionId: task.humanQuestion?.id, limitDecision })} /> : null}
          </div></div> : null}
          {task.workflow !== "standard" ? <WorkflowHistory task={task} activity={activity} /> : null}
          <TaskWork task={task} activity={activity} onChange={onChange} />
        </div></div>
      </div>
      <aside aria-label="Task properties" className="min-w-0 border-t px-4 py-5 lg:border-l lg:border-t-0">
        <dl className="grid grid-cols-1 gap-5 text-xs">
          <div className="space-y-1.5"><dt className="text-muted-foreground">Status</dt><dd className="flex items-center gap-2"><TaskStatus status={task.status} pullRequestState={task.pullRequest?.state} queued={task.queue.state === "queued"} />{task.archivedAt ? <Badge variant="outline">Archived</Badge> : null}</dd></div>
          <div className="space-y-3">
            <Progress className="gap-y-1.5" title={costTitle} aria-label="Estimated cost" value={task.limits.budgetUsd ? Math.min(100, ((cost?.cost ?? 0) / task.limits.budgetUsd) * 100) : null}>
              <ProgressLabel className="text-xs font-normal text-muted-foreground">Cost</ProgressLabel>
              <ProgressValue className="text-xs">{() => <>{cost ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} /> : "Not available"}{task.limits.budgetUsd ? ` of $${task.limits.budgetUsd.toFixed(2)}` : ""}</>}</ProgressValue>
            </Progress>
            <Progress className="gap-y-1.5" aria-label="Turns" value={task.limits.maxTurns ? Math.min(100, (task.limits.admittedTurns / task.limits.maxTurns) * 100) : null}>
              <ProgressLabel className="text-xs font-normal text-muted-foreground">Turns</ProgressLabel>
              <ProgressValue className="text-xs">{() => task.limits.maxTurns ? `${task.limits.admittedTurns} of ${task.limits.maxTurns}` : `${task.limits.admittedTurns}`}</ProgressValue>
            </Progress>
          </div>
          <TaskBlockedByProperty task={task} onChange={onChange} />
          <div className="space-y-1.5"><dt className="text-muted-foreground">Issue</dt><dd><IssuePicker projectId={task.projectId} issue={task.issue} onChange={async issue => onChange(await readJson<Task>(`/api/tasks/${task.id}/issue`, { method: "PATCH", body: JSON.stringify({ issue }) }))} /></dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Project</dt><dd className="flex min-w-0 items-center gap-2">{project ? <EntityAvatar kind="project" id={project.id} name={project.name} size="xs" /> : null}<span className="truncate">{project?.name ?? task.configuration.repository}</span></dd></div>
          {([["root", "Coordinator", task.rootProfile], ["worker", "Worker", task.workerProfile], ...workflowDefinition(task.workflow).advisorRoles.map(role => [role, ADVISOR_LABELS[role], task.advisorProfiles[role as AdvisorRole] ?? task.rootProfile] as const)] as const).map(([role, label, profile]) => <div key={role} className="space-y-1.5"><dt className="text-muted-foreground">{label}</dt><dd className="flex items-center gap-2"><EntityAvatar kind="agent" id={profile.profileId} name={label} size="xs" /><span className="min-w-0"><span className="block truncate" title={`${profile.model} · ${profile.provider}`}>{profile.model}</span><span className="block text-[11px] text-muted-foreground">{profile.provider} · {profile.reasoningLevel}</span></span></dd></div>)}
          <div className="space-y-1.5"><dt className="text-muted-foreground">Branch</dt><dd><CopyValue label="branch" value={task.configuration.branch}><code className="truncate" title={task.configuration.branch}>{task.configuration.branch}</code></CopyValue></dd></div>
          {task.worktree ? <div className="space-y-1.5"><dt className="text-muted-foreground">Worktree</dt><dd><CopyValue label="worktree path" value={task.worktree.path}><span className="truncate font-mono text-[11px]" title={task.worktree.path}>{task.worktree.path.split("/").pop()}</span></CopyValue></dd></div> : null}
          <Collapsible.Root className="space-y-3">
            <Collapsible.Trigger className="group flex items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />Properties</Collapsible.Trigger>
            <Collapsible.Panel className="grid grid-cols-1 gap-5">
              <div className="space-y-1.5"><dt className="text-muted-foreground">Workflow</dt><dd data-task-workflow>{workflowDefinition(task.workflow).name}</dd>{task.workflow !== "standard" ? <dd><WorkflowStatus task={task} /></dd> : null}</div>
              <div className="space-y-1.5"><dt className="text-muted-foreground">Delivery</dt><dd>{taskDeliveryTargetOptions.find(option => option.value === task.deliveryTarget)?.label}</dd></div>
              <div className="space-y-1.5"><dt className="text-muted-foreground">Run project tests</dt><dd>{task.configuration.runProjectTests ? "Enabled" : "Off"}</dd></div>
              <div className="space-y-1.5"><dt className="text-muted-foreground">Browser evidence</dt><dd>{task.configuration.visualEvidence === "off" ? "Off" : task.configuration.visualEvidence === "capture" ? "Capture" : "Necessary"}</dd></div>
              <div className="space-y-1.5"><dt className="text-muted-foreground">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
              <div className="space-y-1.5"><dt className="text-muted-foreground">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
            </Collapsible.Panel>
          </Collapsible.Root>
        </dl>
      </aside>
    </div>
    {edit ? <NewTaskDialog open editTask={task} initialDraft={edit} companyId={task.companyId} onOpenChange={open => { if (!open) setEdit(null); }} onCreated={saved => { setEdit(null); onChange(saved); }} /> : null}
    <LivePaneDock taskId={task.id} activity={activity} />
    <Dialog open={image !== null} onOpenChange={open => { if (!open) setImage(null); }}><DialogContent><DialogHeader><DialogTitle>{image?.filename ?? "Image preview"}</DialogTitle></DialogHeader>{image ? <img className="max-h-[70dvh] w-full object-contain" src={`/api/tasks/${task.id}/images/${image.artifactId}`} alt={image.filename} /> : null}</DialogContent></Dialog>
  </article>;
}
