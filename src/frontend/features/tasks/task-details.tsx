import { useEffect, useState, type ReactElement } from "react";
import { GitBranch } from "lucide-react";
import type { Task } from "../../../tasks/contracts.js";
import { TaskActivityResponseSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";
import { adminDate, type ApiProject } from "../../shell/view-shared.js";
import { Button } from "../../components/ui/button.js";
import { BlockedByPickerDialog } from "./blocked-by-picker.js";
import { TaskQuestion } from "./task-question.js";
import { NewTaskDialog } from "./new-task-dialog.js";
import { editTaskDraft, type NewTaskDraft } from "./lib/duplicate-task-prefill.js";
import { Badge } from "../../components/ui/badge.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Markdown } from "../../components/app/markdown.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { TaskStatus } from "./task-status.js";
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

export function TaskBlockedByProperty({ task, save }: { task: Pick<Task, "id" | "companyId" | "projectId" | "status" | "blockedBy">; save: (blockedByTaskId: string | null) => Promise<void> }): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (blockedByTaskId: string | null) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await save(blockedByTaskId); }
    catch (error) { setError(error instanceof Error ? error.message : "The Blocked by reference could not be saved"); }
    finally { setBusy(false); }
  };
  const openPicker = () => { setError(""); setPickerOpen(true); };
  return <div className="space-y-1.5"><dt className="text-muted-foreground">Blocked by reference</dt><dd>{task.blockedBy ? <span className="flex flex-wrap items-center gap-2"><a className="underline-offset-2 hover:underline" href={`/tasks/${task.blockedBy.id}?company=${task.companyId}`} title={`${task.blockedBy.title} · ${task.blockedBy.status}`}>{task.blockedBy.title}</a><TaskStatus status={task.blockedBy.status} /><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={openPicker}>Change reference</Button><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void submit(null)}>Clear reference</Button></span> : <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={openPicker}>Add Blocked by reference</Button>}</dd>{error ? <dd role="alert" className="text-destructive">{error}</dd> : null}<BlockedByPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} companyId={task.companyId} projectId={task.projectId} excludeTaskId={task.id} onSelect={selected => void submit(selected.id)} onError={setError} /></div>;
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
          {task.status !== "active" || task.pullRequest || task.humanQuestion ? <div data-task-current className="-mx-4 border-y px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10"><div className="mx-auto max-w-4xl space-y-3">
            {task.pullRequest ? <TaskPullRequestCard task={task} /> : task.status === "active" ? null : <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{task.status === "backlog" ? task.startWhenBlockedByDelivered && task.blockedBy ? `This task waits for its Blocked by reference: ${task.blockedBy.title}.` : "The task is ready to start." : task.status === "delivered" ? "The delivery target is complete." : task.status === "cancelled" ? "The task is cancelled." : "Coordinator needs your answer."}</p>{editable ? <span className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setEdit(editTaskDraft(task))}>Edit task</Button><Button size="sm" disabled={busy} onClick={() => void act("start")}>Start task</Button></span> : null}</div>}
            {task.humanQuestion ? <TaskQuestion key={task.humanQuestion.id} question={task.humanQuestion} busy={busy} onAnswer={answer => act("answer", { questionId: task.humanQuestion?.id, ...answer })} onLimitDecision={limitDecision => act("answer", { questionId: task.humanQuestion?.id, limitDecision })} /> : null}
          </div></div> : null}
          {task.workflow !== "standard" ? <WorkflowHistory task={task} activity={activity} /> : null}
          <TaskWork task={task} activity={activity} onChange={onChange} />
        </div></div>
      </div>
      <aside aria-label="Task properties" className="min-w-0 border-t px-4 py-5 lg:border-l lg:border-t-0">
        <dl className="grid grid-cols-1 gap-5 text-xs">
          <div className="space-y-1.5"><dt className="text-muted-foreground">Status</dt><dd className="flex items-center gap-2"><TaskStatus status={task.status} pullRequestState={task.pullRequest?.state} />{task.archivedAt ? <Badge variant="outline">Archived</Badge> : null}</dd></div>
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
          <TaskBlockedByProperty task={task} save={async blockedByTaskId => onChange(await readJson<Task>(`/api/tasks/${task.id}/blocked-by`, { method: "PATCH", body: JSON.stringify({ blockedByTaskId }) }))} />
          <div className="space-y-1.5"><dt className="text-muted-foreground">Project</dt><dd className="break-words">{project?.name ?? task.configuration.repository}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Workflow</dt><dd data-task-workflow>{workflowDefinition(task.workflow).name}</dd>{task.workflow !== "standard" ? <dd><WorkflowStatus task={task} /></dd> : null}</div>
          {([["root", "Coordinator", task.rootProfile], ["worker", "Worker", task.workerProfile], ...workflowDefinition(task.workflow).advisorRoles.map(role => [role, ADVISOR_LABELS[role], task.advisorProfiles[role as AdvisorRole] ?? task.rootProfile] as const)] as const).map(([role, label, profile]) => <div key={role} className="space-y-1.5"><dt className="text-muted-foreground">{label}</dt><dd className="flex items-center gap-2"><EntityAvatar kind="agent" id={profile.profileId} name={label} size="xs" /><span className="min-w-0"><span className="block truncate" title={`${profile.model} · ${profile.provider}`}>{profile.model}</span><span className="block text-[11px] text-muted-foreground">{profile.provider} · {profile.reasoningLevel}</span></span></dd></div>)}
          <div className="space-y-1.5"><dt className="text-muted-foreground">Delivery</dt><dd>{taskDeliveryTargetOptions.find(option => option.value === task.deliveryTarget)?.label}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Branch</dt><dd className="flex min-w-0 items-center gap-1.5"><GitBranch className="size-3.5 shrink-0" /><code className="truncate" title={task.configuration.branch}>{task.configuration.branch}</code></dd><dd className="text-muted-foreground">Base · {task.configuration.baseBranch}</dd></div>
          {task.worktree ? <div className="space-y-1.5"><dt className="text-muted-foreground">Worktree</dt><dd className="truncate font-mono text-[11px]" title={task.worktree.path}>{task.worktree.path.split("/").pop()}</dd></div> : null}
          <div className="space-y-1.5"><dt className="text-muted-foreground">Run project tests</dt><dd>{task.configuration.runProjectTests ? "Enabled" : "Off"}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Browser evidence</dt><dd>{task.configuration.visualEvidence === "off" ? "Off" : task.configuration.visualEvidence === "capture" ? "Capture" : "Necessary"}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
        </dl>
      </aside>
    </div>
    {edit ? <NewTaskDialog open editTask={task} initialDraft={edit} companyId={task.companyId} onOpenChange={open => { if (!open) setEdit(null); }} onCreated={saved => { setEdit(null); onChange(saved); }} /> : null}
    <LivePaneDock taskId={task.id} activity={activity} />
    <Dialog open={image !== null} onOpenChange={open => { if (!open) setImage(null); }}><DialogContent><DialogHeader><DialogTitle>{image?.filename ?? "Image preview"}</DialogTitle></DialogHeader>{image ? <img className="max-h-[70dvh] w-full object-contain" src={`/api/tasks/${task.id}/images/${image.artifactId}`} alt={image.filename} /> : null}</DialogContent></Dialog>
  </article>;
}
