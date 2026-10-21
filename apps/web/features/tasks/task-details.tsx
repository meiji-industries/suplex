import { setTaskDependencies, setTaskIssue, runTaskAction, type TaskAction } from "./lib/task-api.js";
import { useEffect, useState, type ReactElement } from "react";
import { ArrowLeft, ChevronRight, ClipboardCopy, Info, X } from "lucide-react";
import { Collapsible } from "../../components/ui/collapsible.js";
import type { Task } from "../../contracts/tasks.js";
import { useTaskActivity } from "./lib/task-queries.js";
import { adminDate, type ApiProject } from "../../shell/view-shared.js";
import { Button } from "../../components/ui/button.js";
import { BlockedByPickerDialog } from "./blocked-by-picker.js";
import { IssuePicker } from "./issue-picker.js";
import { TaskQuestion } from "./task-question.js";
import { TaskAgent, type TaskAgentRole } from "./task-agent.js";
import { NewTaskDialog } from "./new-task-dialog.js";
import { editTaskDraft, type NewTaskDraft } from "./lib/duplicate-task-prefill.js";
import { Badge } from "../../components/ui/badge.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Markdown } from "../../components/app/markdown.js";
import { ProjectLabel } from "../../components/app/project-label.js";
import { TaskStatus, TaskTitleLink } from "./task-status.js";
import { TaskWork, type TaskActivity } from "./task-work.js";
import { TaskDeliveryProperty } from "./task-delivery-property.js";
import { LivePaneDock } from "./task-chat/live-pane-dock.js";
import { useTaskCosts } from "../analytics/lib/analytics.js";
import { CostValue } from "../../components/app/cost-value.js";
import { Progress, ProgressLabel, ProgressValue } from "../../components/ui/progress.js";
import { WorkflowHistory, WorkflowStatus } from "./workflow-history.js";
import { TaskPullRequestCard } from "./pull-request-card.js";
import { showWorktreeMenu, TaskWorktreeMenu } from "./task-worktree-menu.js";
import { workflowDefinition } from "./workflow-presentation.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { TaskHealthBadges, type TaskHealth } from "./task-health.js";

const emptyActivity: TaskActivity = { setup: { state: "none", exitStatus: null }, sessions: [], turns: [], actions: [], shellPaneId: null };

function CopyValue({ label, value, children }: { label: string; value: string; children: ReactElement }): ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1_500); return () => clearTimeout(timer); }, [copied]);
  return <span className="flex min-w-0 items-center gap-1.5">
    <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={copied ? `Copied ${label}` : `Copy ${label}`} title={copied ? "Copied" : "Copy"} onClick={() => { void copyToClipboard(value, `Copied the ${label} to clipboard`).then(setCopied); }}><ClipboardCopy className="size-3.5" /></button>
    {children}
  </span>;
}

/** The Blocked by prerequisites of a task. Each change saves the complete prerequisite set through the dependency route, so removing one keeps the others. */
/** Each incomplete Blocked by task with the exact reason the backlog task waits for it. */
export function TaskQueueWaits({ task }: { task: Pick<Task, "companyId" | "queue"> }): ReactElement {
  return <ul data-task-queue-waits aria-label="Waiting for" className="space-y-1 text-xs">{task.queue.waitingOn.map(wait => <li key={wait.id} data-task-queue-wait={wait.id} data-reason={wait.reason} className="flex min-w-0 flex-wrap items-center gap-x-1">{wait.kind === "pull_request" && wait.url ? <a href={wait.url}>#{wait.number}</a> : <TaskTitleLink task={wait} companyId={task.companyId} />}<span className="text-muted-foreground">{wait.summary.startsWith(wait.title) ? wait.summary.slice(wait.title.length).trim() : wait.summary}</span></li>)}</ul>;
}

/** Start queues a task: Suplex starts it by itself when every Blocked by task is complete. */
export function backlogText(task: Pick<Task, "status" | "queue">): string {
  if (task.status === "queued") {
    if (task.queue.waitingOn.length) return task.queue.projectConcurrencyLimited ? "Queued. Prerequisites incomplete and project concurrency limit reached." : "Queued. Suplex starts this task when its prerequisites are complete.";
    if (task.queue.planConcurrencyLimited) return "Queued. Free runs 3 tasks at a time. Suplex starts this task when a running task stops, or select Pro in Settings > Billing.";
    return task.queue.projectConcurrencyLimited ? "Queued. Project concurrency limit reached." : "Queued. Suplex will start this task.";
  }
  return task.queue.waitingOn.length ? "Backlog. Start this task to queue it after its prerequisites." : "The task is ready to start.";
}

/** Queue or backlog status, the prerequisite waits, and the queue actions of an editable task. */
export function TaskQueueStatus({ task, editable, busy, onEdit, onAction }: { task: Pick<Task, "companyId" | "status" | "queue">; editable: boolean; busy: boolean; onEdit: () => void; onAction: (action: TaskAction) => void }): ReactElement {
  const queued = task.status === "queued";
  return <Alert data-task-queue-status><Info /><AlertDescription><div className="flex flex-col gap-2">
    <div>{backlogText(task)}</div>
    {task.queue.waitingOn.length ? <TaskQueueWaits task={task} /> : null}
    {editable ? <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>Edit task</Button>{queued ? <><Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("move-to-front")}>Move to front</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("disarm")}>Send to backlog</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("force-start")}>Start anyway</Button></> : <Button size="sm" disabled={busy} onClick={() => onAction("start")}>{task.queue.waitingOn.length ? "Queue task" : "Start task"}</Button>}</div> : null}
  </div></AlertDescription></Alert>;
}

export function TaskBlockedByProperty({ task, onChange }: { task: Pick<Task, "id" | "companyId" | "projectId" | "status" | "blockedBy">; onChange: (task: Task) => void }): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const taskBlockers = task.blockedBy.filter(prerequisite => prerequisite.kind !== "pull_request");
  const pullRequests = task.blockedBy.filter(prerequisite => prerequisite.kind === "pull_request" && prerequisite.number !== undefined);
  const ids = taskBlockers.map(prerequisite => prerequisite.id);
  const submit = async (dependsOn: string[], pullRequestNumbers = pullRequests.map(prerequisite => prerequisite.number!)) => {
    if (busy) return;
    setBusy(true); setError("");
    try { onChange(await setTaskDependencies(task.id, dependsOn, pullRequestNumbers)); }
    catch (error) { setError(error instanceof Error ? error.message : "The Blocked by tasks could not be saved"); }
    finally { setBusy(false); }
  };
  const openPicker = () => { setError(""); setPickerOpen(true); };
  return <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Blocked by</dt><dd className="flex min-w-0 flex-col items-start gap-1">{taskBlockers.map(prerequisite => <span key={prerequisite.id} data-blocked-by-task={prerequisite.id} className="flex w-full min-w-0 items-center gap-1"><TaskTitleLink task={prerequisite} companyId={task.companyId} className="min-w-0 flex-1" /><Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${prerequisite.title} from Blocked by`} disabled={busy} onClick={() => void submit(ids.filter(id => id !== prerequisite.id))}><X /></Button></span>)}{pullRequests.map(prerequisite => <span key={prerequisite.id} data-blocked-by-pull-request={prerequisite.number} className="flex w-full min-w-0 items-center gap-1"><a className="min-w-0 flex-1" href={prerequisite.url}>#{prerequisite.number} {prerequisite.title} ({prerequisite.state})</a><Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove pull request #${prerequisite.number} from Blocked by`} disabled={busy} onClick={() => void submit(ids, pullRequests.filter(other => other.number !== prerequisite.number).map(other => other.number!))}><X /></Button></span>)}<Button type="button" size="xs" variant="ghost" aria-label={task.blockedBy.length ? "Add Blocked by task" : undefined} disabled={busy} onClick={openPicker}>{task.blockedBy.length ? "Add" : "None"}</Button></dd>{error ? <dd role="alert" className="text-destructive">{error}</dd> : null}<BlockedByPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} companyId={task.companyId} projectId={task.projectId} excludeTaskIds={[task.id, ...ids]} excludePullRequestNumbers={pullRequests.map(prerequisite => prerequisite.number!)} onSelect={selected => void (selected.kind === "task" ? submit([...ids, selected.task.id]) : submit(ids, [...pullRequests.map(prerequisite => prerequisite.number!), selected.pullRequest.number]))} onError={setError} /></div>;
}

/** `health` shows why an active task does not advance. It is a display observation only. */
export function TaskDetailsPage({ task, project, onChange, backHref, titleActions, health }: { task: Task; project: ApiProject | undefined; onChange: (task: Task) => void; backHref?: string; titleActions?: ReactElement; health?: TaskHealth | undefined }): ReactElement {
  const cost = useTaskCosts(task.companyId).get(task.id);
  const costTitle = cost ? undefined : "OpenCode estimates are not bills. Zero does not verify free usage.";
  const activityQuery = useTaskActivity(task.id);
  const activity = activityQuery.data ?? emptyActivity;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<Task["images"][number] | null>(null);
  const [edit, setEdit] = useState<NewTaskDraft | null>(null);
  const blockedBy = <TaskBlockedByProperty task={task} onChange={onChange} />;
  const issue = <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Issue</dt><dd><IssuePicker projectId={task.projectId} issue={task.issue} onChange={async issue => onChange(await setTaskIssue(task.id, issue))} /></dd></div>;
  const editable = ["backlog", "queued"].includes(task.status) && !task.archivedAt;
  const readError = error || activityQuery.error?.message || "";
  const act = async (action: TaskAction, body?: unknown) => {
    if (busy) return;
    setBusy(true); setError("");
    try { onChange(await runTaskAction(task.id, action, body)); }
    catch (error) { setError(error instanceof Error ? error.message : "The action failed"); }
    finally { setBusy(false); }
  };
  return <article data-task-detail className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div data-task-body className="grid min-h-0 min-w-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_260px]">
      <div data-task-main className="flex min-w-0 flex-col">
        <header data-task-detail-header className="px-4 pb-3 sm:px-6 lg:px-10 pt-5.5"><div className="mx-auto flex max-w-4xl min-w-0 items-center gap-2">{backHref ? <span className="flex shrink-0 -ml-[5px]">{/* Offset the button padding so the arrow sits on the column edge. */}<Button variant="ghost" size="icon-sm" nativeButton={false} aria-label="Back to tasks" title="Back to tasks" render={<a href={backHref} />}><ArrowLeft className="size-[19px] w-[22px] h-[22px] [stroke-width:1.0909]" /></Button></span> : null}<h2 className="min-w-0 truncate font-semibold leading-8 text-2xl" aria-label={task.title} title={task.title}>{task.title}</h2><div className="ml-auto flex shrink-0 items-center gap-1 mr-[0px]">{task.worktree && showWorktreeMenu() ? <TaskWorktreeMenu taskId={task.id} path={task.worktree.path} onError={setError} /> : null}{titleActions}</div></div><TaskHealthBadges health={health} className="mx-auto mt-2 max-w-4xl" /></header>
        <div data-task-content className="min-w-0 px-4 pb-6 pt-4 sm:px-6 lg:px-10"><div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
          {readError ? <Alert variant="destructive"><AlertDescription>{readError}</AlertDescription></Alert> : null}
          <Markdown source={task.description} />
          {task.images.length ? <ul className="flex flex-wrap gap-2" aria-label="Task images">{task.images.map(item => <li key={item.artifactId}><button type="button" className="size-16 overflow-hidden rounded-field border bg-muted/30 focus-visible:outline" aria-label={`Open ${item.filename}`} onClick={() => setImage(item)}><img className="size-full object-cover" src={`/api/tasks/${task.id}/images/${item.artifactId}`} alt={item.filename} /></button></li>)}</ul> : null}
          {task.workflow !== "standard" ? <WorkflowHistory task={task} activity={activity} /> : null}
          <TaskWork task={task} activity={activity} onChange={onChange} current={task.status !== "active" || task.pullRequest || task.humanQuestion ? <div data-task-current className="-mx-4 px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10"><div className="mx-auto max-w-4xl space-y-3">
            {task.pullRequest || task.status === "delivered" && ["pull_request_draft", "pull_request_ready", "merged"].includes(task.deliveryTarget) ? <TaskPullRequestCard task={task} onChange={onChange} /> : task.status === "active" ? null : ["backlog", "queued"].includes(task.status) ? <TaskQueueStatus task={task} editable={editable} busy={busy} onEdit={() => setEdit(editTaskDraft(task))} onAction={action => void act(action)} /> : <p className="text-xs text-muted-foreground">{task.status === "delivered" ? "The delivery target is complete." : task.status === "cancelled" ? "The task is cancelled." : "Coordinator needs your answer."}</p>}
            {task.pullRequest && ["backlog", "queued"].includes(task.status) && task.queue.waitingOn.length ? <TaskQueueWaits task={task} /> : null}
            {task.humanQuestion ? <TaskQuestion key={task.humanQuestion.id} question={task.humanQuestion} busy={busy} onAnswer={answer => act("answer", { questionId: task.humanQuestion?.id, ...answer })} onLimitDecision={limitDecision => act("answer", { questionId: task.humanQuestion?.id, limitDecision })} /> : null}
          </div></div> : null} />
        </div></div>
      </div>
      <aside aria-label="Task properties" className="min-w-0 border-t px-4 py-5 lg:border-l lg:border-t-0">
        <dl className="grid grid-cols-1 gap-5 text-xs">
          <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Status</dt><dd className="flex items-center gap-2"><TaskStatus status={task.status} pullRequestState={task.pullRequest?.state} />{task.archivedAt ? <Badge variant="outline">Archived</Badge> : null}</dd></div>
          <div aria-hidden="true" className="-mx-4 border-t" /><div className="space-y-3">
            <Progress className="gap-y-1.5" title={costTitle} aria-label="Estimated cost" value={task.limits.budgetUsd ? Math.min(100, ((cost?.cost ?? 0) / task.limits.budgetUsd) * 100) : null}>
              <ProgressLabel className="font-normal text-muted-foreground text-sm dark:text-[#d1d1d1]">Cost</ProgressLabel>
              <ProgressValue className="text-xs">{() => <>{cost ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} /> : "Not available"}{task.limits.budgetUsd ? ` of $${task.limits.budgetUsd.toFixed(2)}` : ""}</>}</ProgressValue>
            </Progress>
            <Progress className="gap-y-1.5" aria-label="Turns" value={task.limits.maxTurns ? Math.min(100, (task.limits.admittedTurns / task.limits.maxTurns) * 100) : null}>
              <ProgressLabel className="font-normal text-muted-foreground text-sm dark:text-[#d1d1d1]">Turns</ProgressLabel>
              <ProgressValue className="text-xs">{() => task.limits.maxTurns ? `${task.limits.admittedTurns} of ${task.limits.maxTurns}` : `${task.limits.admittedTurns}`}</ProgressValue>
            </Progress>
          </div><div aria-hidden="true" className="-mx-4 border-t" />
          {task.blockedBy.length ? blockedBy : null}
          {task.issue ? issue : null}
          <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Project</dt><dd className="flex min-w-0 items-center gap-2"><ProjectLabel project={project} fallback={task.configuration.repository} /></dd></div><div aria-hidden="true" className="-mx-4 border-t" />
          <div className="grid grid-cols-1 gap-5">{(["root", "worker", ...workflowDefinition(task.workflow).advisorRoles] satisfies TaskAgentRole[]).map(role => <TaskAgent key={role} task={task} role={role} onChange={onChange} onActivityChange={activityQuery.refresh} />)}</div><div aria-hidden="true" className="-mx-4 border-t" />
          <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Branch</dt><dd><CopyValue label="branch" value={task.configuration.branch}><code className="truncate" title={task.configuration.branch}>{task.configuration.branch}</code></CopyValue></dd></div>
          {task.worktree ? <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Worktree</dt><dd><CopyValue label="worktree path" value={task.worktree.path}><span className="truncate font-mono text-xs" title={task.worktree.path}>{task.worktree.path.split("/").pop()}</span></CopyValue></dd></div> : null}
          <div aria-hidden="true" className="-mx-4 border-t" /><Collapsible.Root className="space-y-3">
            <Collapsible.Trigger className="group flex items-center gap-1 text-muted-foreground hover:text-foreground text-sm dark:text-[#d1d1d1]"><ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />Properties</Collapsible.Trigger>
            <Collapsible.Panel className="grid grid-cols-1 gap-5">
              {task.blockedBy.length ? null : blockedBy}
              {task.issue ? null : issue}
              <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Workflow</dt><dd data-task-workflow>{workflowDefinition(task.workflow).name}</dd>{task.workflow !== "standard" ? <dd><WorkflowStatus task={task} /></dd> : null}</div>
              <TaskDeliveryProperty task={task} onChange={onChange} />
              <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Run project tests</dt><dd>{task.configuration.runProjectTests ? "Enabled" : "Off"}</dd></div>
              <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Browser evidence</dt><dd>{task.configuration.visualEvidence === "off" ? "Off" : task.configuration.visualEvidence === "capture" ? "Capture" : "Necessary"}</dd></div>
              <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
              <div className="space-y-1.5"><dt className="text-muted-foreground text-sm dark:text-[#d1d1d1]">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
            </Collapsible.Panel>
          </Collapsible.Root>
        </dl>
      </aside>
    </div>
    {edit ? <NewTaskDialog open editTask={task} initialDraft={edit} companyId={task.companyId} onOpenChange={open => { if (!open) setEdit(null); }} onCreated={saved => { setEdit(null); onChange(saved); }} /> : null}
    <LivePaneDock taskId={task.id} activity={activity} />
    <Dialog open={image !== null} onOpenChange={open => { if (!open) setImage(null); }}><DialogContent className="w-auto max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]"><DialogHeader><DialogTitle>{image?.filename ?? "Image preview"}</DialogTitle></DialogHeader>{image ? <img className="mx-auto h-auto max-h-[calc(100dvh-12rem)] w-auto max-w-full object-contain" src={`/api/tasks/${task.id}/images/${image.artifactId}`} alt={image.filename} /> : null}</DialogContent></Dialog>
  </article>;
}
