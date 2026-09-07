import { useEffect, useState, type ReactElement } from "react";
import { ExternalLink, GitBranch, GitMerge, GitPullRequest } from "lucide-react";
import type { Task } from "../../task-contracts.js";
import { TaskActivityResponseSchema } from "../../http/contracts/tasks.js";
import { readJson } from "../lib/api.js";
import { adminDate, type ApiProject } from "../lib/view-shared.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { Input } from "../components/ui/input.js";
import { TaskQuestion } from "../components/app/task-question.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Markdown } from "../components/app/markdown.js";
import { EntityAvatar } from "../components/app/entity-avatar.js";
import { TaskStatus } from "../components/app/task-status.js";
import { TaskWork, type TaskActivity } from "../components/app/task-work.js";
import { taskDeliveryTargetOptions } from "../components/app/task-delivery-target.js";
import { LivePaneDock } from "../components/app/task-chat/live-pane-dock.js";
import { useTaskCosts } from "../lib/analytics.js";
import { CostValue } from "../components/app/cost-value.js";
import { WorkflowHistory, WorkflowStatus } from "../components/app/workflow-history.js";
import { ADVISOR_LABELS, workflowDefinition, type AdvisorRole } from "../../workflows.js";

export function TaskDetailsPage({ task, project, onChange }: { task: Task; project: ApiProject | undefined; onChange: (task: Task) => void }): ReactElement {
  const cost = useTaskCosts(task.companyId).get(task.id);
  const costTitle = cost ? undefined : "OpenCode estimates are not bills. Zero does not verify free usage.";
  const [activity, setActivity] = useState<TaskActivity>({ sessions: [], turns: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<Task["images"][number] | null>(null);
  const [edit, setEdit] = useState<{ title: string; description: string } | null>(null);
  const editable = task.status === "backlog" && !task.archivedAt;
  const saveDetails = async () => {
    if (!edit || busy) return;
    setBusy(true); setError("");
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(edit) })); setEdit(null); }
    catch (error) { setError(error instanceof Error ? error.message : "The task could not be saved"); }
    finally { setBusy(false); }
  };
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
  const openWorktree = async (app: "editor" | "terminal") => {
    try { const result = await readJson<{ ok: boolean; error?: string }>(`/api/tasks/${task.id}/worktree/open`, { method: "POST", body: JSON.stringify({ app }) }); if (!result.ok) setError(result.error ?? "The worktree could not be opened"); }
    catch (error) { setError(String(error)); }
  };

  return <article data-task-detail className="flex h-[calc(100dvh-var(--header-height))] min-h-0 min-w-0 flex-none flex-col overflow-hidden md:h-[calc(100dvh-var(--header-height)-1rem)]">
    <div data-task-body className="grid min-h-0 min-w-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_260px]">
      <div data-task-main className="flex min-w-0 flex-col">
        <header className="px-4 pb-3 pt-4 sm:px-6 lg:px-10"><div className="mx-auto max-w-4xl"><h2 className="text-xl font-semibold leading-8" aria-label={task.title}>{editable ? <button className="text-left hover:text-muted-foreground focus-visible:outline" type="button" aria-label="Edit task title" onClick={() => setEdit({ title: task.title, description: task.description })}>{task.title}</button> : task.title}</h2></div></header>
        <div data-task-content className="min-w-0 px-4 pb-6 pt-4 sm:px-6 lg:px-10"><div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {edit ? <form className="grid gap-2" aria-label="Task details" onSubmit={event => { event.preventDefault(); void saveDetails(); }}><Input aria-label="Task title" value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })} required /><Textarea aria-label="Task description" value={edit.description} onChange={event => setEdit({ ...edit, description: event.target.value })} required /><div className="flex gap-2"><Button type="submit" size="sm" disabled={busy}>Save task</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button></div></form> : <div className="space-y-2"><Markdown source={task.description} />{editable ? <Button size="xs" variant="ghost" onClick={() => setEdit({ title: task.title, description: task.description })}>Edit task description</Button> : null}</div>}
          {task.images.length ? <ul className="flex flex-wrap gap-2" aria-label="Task images">{task.images.map(item => <li key={item.artifactId}><button type="button" className="size-16 overflow-hidden rounded-md border bg-muted/30 focus-visible:outline" aria-label={`Open ${item.filename}`} onClick={() => setImage(item)}><img className="size-full object-cover" src={`/api/tasks/${task.id}/images/${item.artifactId}`} alt={item.filename} /></button></li>)}</ul> : null}
          {task.status !== "active" || task.pullRequest || task.humanQuestion ? <div data-task-current className="-mx-4 border-y px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10"><div className="mx-auto max-w-4xl space-y-3">
            {task.pullRequest ? <a data-active-pull-request href={task.pullRequest.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-md border p-3 hover:bg-muted/30">{task.pullRequest.state === "merged" ? <GitMerge className="size-5 shrink-0 text-violet-500" /> : <GitPullRequest className="size-5 shrink-0 text-emerald-500" />}<span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{task.title}</span><span className="text-xs text-muted-foreground">{task.configuration.repository} #{task.pullRequest.number}</span></span><Badge variant="secondary">{task.pullRequest.state === "merged" ? "Merged" : task.pullRequest.state === "closed" ? "Closed" : "Open"}</Badge><ExternalLink className="size-3.5 shrink-0 text-muted-foreground" /></a> : task.status === "active" ? null : <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{task.status === "backlog" ? "The task is ready to start." : task.status === "delivered" ? "The delivery target is complete." : task.status === "cancelled" ? "The task is cancelled." : "Coordinator needs your answer."}</p>{editable ? <Button size="sm" disabled={busy} onClick={() => void act("start")}>Start task</Button> : null}</div>}
            {task.humanQuestion ? <TaskQuestion key={task.humanQuestion.id} question={task.humanQuestion} busy={busy} onAnswer={answer => act("answer", { questionId: task.humanQuestion?.id, ...answer })} /> : null}
          </div></div> : null}
          {task.workflow !== "standard" ? <WorkflowHistory task={task} activity={activity} /> : null}
          <TaskWork task={task} activity={activity} />
        </div></div>
      </div>
      <aside aria-label="Task properties" className="min-w-0 border-t px-4 py-5 lg:border-l lg:border-t-0">
        <h3 className="mb-4 text-xs font-medium">Properties</h3>
        <dl className="grid grid-cols-1 gap-5 text-xs">
          <div className="space-y-1.5"><dt className="text-muted-foreground">Estimated cost (USD)</dt><dd title={costTitle}>{cost ? <CostValue value={cost.cost} subsidized={cost.subsidized} partial={cost.partial} /> : <span title={costTitle}>Not available</span>}{cost?.partial ? " · Partial usage" : ""}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Status</dt><dd className="flex items-center gap-2"><TaskStatus status={task.status} />{task.archivedAt ? <Badge variant="outline">Archived</Badge> : null}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Project</dt><dd className="break-words">{project?.name ?? task.configuration.repository}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Workflow</dt><dd data-task-workflow>{workflowDefinition(task.workflow).name}</dd>{task.workflow !== "standard" ? <dd><WorkflowStatus task={task} /></dd> : null}</div>
          {([["root", "Coordinator", task.rootProfile], ["worker", "Worker", task.workerProfile], ...workflowDefinition(task.workflow).advisorRoles.map(role => [role, ADVISOR_LABELS[role], task.advisorProfiles[role as AdvisorRole] ?? task.rootProfile] as const)] as const).map(([role, label, profile]) => <div key={role} className="space-y-1.5"><dt className="text-muted-foreground">{label}</dt><dd className="flex items-center gap-2"><EntityAvatar kind="agent" id={profile.profileId} name={label} size="xs" /><span className="min-w-0"><span className="block truncate" title={`${profile.provider}/${profile.model}`}>{profile.model}</span><span className="block text-[11px] text-muted-foreground">{profile.provider} · {profile.reasoningLevel}</span></span></dd></div>)}
          <div className="space-y-1.5"><dt className="text-muted-foreground">Delivery</dt><dd>{taskDeliveryTargetOptions.find(option => option.value === task.deliveryTarget)?.label}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Branch</dt><dd className="flex min-w-0 items-center gap-1.5"><GitBranch className="size-3.5 shrink-0" /><code className="truncate" title={task.configuration.branch}>{task.configuration.branch}</code></dd><dd className="text-muted-foreground">Base · {task.configuration.baseBranch}</dd></div>
          {task.worktree ? <div className="space-y-1.5"><dt className="text-muted-foreground">Worktree</dt><dd className="truncate font-mono text-[11px]" title={task.worktree.path}>{task.worktree.path.split("/").pop()}</dd><dd className="flex flex-wrap gap-1"><Button size="xs" variant="outline" onClick={() => void openWorktree("editor")}>Open editor</Button><Button size="xs" variant="outline" onClick={() => void openWorktree("terminal")}>Open terminal</Button></dd></div> : null}
          <div className="space-y-1.5"><dt className="text-muted-foreground">Run project tests</dt><dd>{task.configuration.runProjectTests ? "Enabled" : "Off"}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Browser evidence</dt><dd>{task.configuration.visualEvidence === "off" ? "Off" : task.configuration.visualEvidence === "capture" ? "Capture" : "Necessary"}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
        </dl>
      </aside>
    </div>
    <LivePaneDock taskId={task.id} activity={activity} />
    <Dialog open={image !== null} onOpenChange={open => { if (!open) setImage(null); }}><DialogContent><DialogHeader><DialogTitle>{image?.filename ?? "Image preview"}</DialogTitle></DialogHeader>{image ? <img className="max-h-[70dvh] w-full object-contain" src={`/api/tasks/${task.id}/images/${image.artifactId}`} alt={image.filename} /> : null}</DialogContent></Dialog>
  </article>;
}
