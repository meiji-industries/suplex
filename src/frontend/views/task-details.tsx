import { useEffect, useState, type ReactElement } from "react";
import { Archive, ArchiveRestore, ArrowLeft, Ellipsis, ExternalLink, GitBranch, GitMerge, GitPullRequest, RefreshCw, Square } from "lucide-react";
import type { Task } from "../../task-contracts.js";
import { TaskActivityResponseSchema } from "../../http/contracts/tasks.js";
import { readJson, withCompany } from "../lib/api.js";
import { adminDate, type ApiProject } from "../lib/view-shared.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { Input } from "../components/ui/input.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Markdown } from "../components/app/markdown.js";
import { ProfileAvatar } from "../components/app/profile-avatar.js";
import { TaskStatus } from "../components/app/task-status.js";
import { TaskWork, type TaskActivity } from "../components/app/task-work.js";
import { taskDeliveryTargetOptions } from "../components/app/task-delivery-target.js";

export function TaskDetailsPage({ task, project, returnTo = "/tasks", onChange }: { task: Task; project: ApiProject | undefined; returnTo?: string; onChange: (task: Task) => void }): ReactElement {
  const [activity, setActivity] = useState<TaskActivity>({ sessions: [], turns: [] });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cleanupQuestion, setCleanupQuestion] = useState<string | null>(null);
  const [image, setImage] = useState<Task["images"][number] | null>(null);
  const [edit, setEdit] = useState<{ title: string; description: string } | null>(null);
  const editable = task.status === "backlog" && !task.archivedAt;
  const terminal = task.status === "cancelled" || task.status === "delivered";
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
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}/${action}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) })); setMessage(""); }
    catch (error) { setError(error instanceof Error ? error.message : "The action failed"); }
    finally { setBusy(false); }
  };
  const openWorktree = async (app: "editor" | "terminal") => {
    try { const result = await readJson<{ ok: boolean; error?: string }>(`/api/tasks/${task.id}/worktree/open`, { method: "POST", body: JSON.stringify({ app }) }); if (!result.ok) setError(result.error ?? "The worktree could not be opened"); }
    catch (error) { setError(String(error)); }
  };
  const composer = task.status === "active" ? <form className="grid gap-2 border-t pt-4" onSubmit={event => { event.preventDefault(); void act("note", { note: message }); }}><Textarea aria-label="Note to Root" value={message} onChange={event => setMessage(event.target.value)} placeholder="Send a note to Root" /><div className="flex justify-end"><Button size="sm" type="submit" disabled={busy || !message.trim()}>Send note</Button></div></form> : null;

  return <article data-task-detail className="min-w-0">
    <div className="flex h-10 items-center justify-between border-b px-4 text-xs sm:px-6">
      <a className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground" href={withCompany(returnTo, task.companyId)}><ArrowLeft className="size-3.5" />{returnTo === "/board" ? "Open board" : "Open tasks"}</a>
      <div className="flex items-center gap-2"><TaskStatus status={task.status} />{task.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
        <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Task options" />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy} onClick={() => void act("refresh")}><RefreshCw />Check current state</DropdownMenuItem>
          {!terminal ? <DropdownMenuItem disabled={busy} onClick={() => void act("cancel")}><Square />Cancel task</DropdownMenuItem> : null}
          {terminal || task.status === "backlog" ? <DropdownMenuItem disabled={busy} onClick={() => void act(task.archivedAt ? "unarchive" : "archive")}>{task.archivedAt ? <ArchiveRestore /> : <Archive />}{task.archivedAt ? "Open from archive" : "Keep in archive"}</DropdownMenuItem> : null}
        </DropdownMenuContent></DropdownMenu>
      </div>
    </div>
    <div data-task-body className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0">
        <header className="px-4 pb-3 pt-4 sm:px-6 lg:px-10"><div className="mx-auto max-w-4xl"><h2 className="text-xl font-semibold leading-8" aria-label={task.title}>{editable ? <button className="text-left hover:text-muted-foreground focus-visible:outline" type="button" aria-label="Edit task title" onClick={() => setEdit({ title: task.title, description: task.description })}>{task.title}</button> : task.title}</h2></div></header>
        <div data-task-content className="min-w-0 px-4 pb-6 pt-4 sm:px-6 lg:px-10"><div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {edit ? <form className="grid gap-2" aria-label="Task details" onSubmit={event => { event.preventDefault(); void saveDetails(); }}><Input aria-label="Task title" value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })} required /><Textarea aria-label="Task description" value={edit.description} onChange={event => setEdit({ ...edit, description: event.target.value })} required /><div className="flex gap-2"><Button type="submit" size="sm" disabled={busy}>Save task</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button></div></form> : <div className="space-y-2"><Markdown source={task.description} />{editable ? <Button size="xs" variant="ghost" onClick={() => setEdit({ title: task.title, description: task.description })}>Edit task description</Button> : null}</div>}
          {task.images.length ? <ul className="flex flex-wrap gap-2" aria-label="Task images">{task.images.map(item => <li key={item.artifactId}><button type="button" className="size-16 overflow-hidden rounded-md border bg-muted/30 focus-visible:outline" aria-label={`Open ${item.filename}`} onClick={() => setImage(item)}><img className="size-full object-cover" src={`/api/tasks/${task.id}/images/${item.artifactId}`} alt={item.filename} /></button></li>)}</ul> : null}
          <div data-task-current className="-mx-4 border-y px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10"><div className="mx-auto max-w-4xl space-y-3">
            {task.pullRequest ? <a data-active-pull-request href={task.pullRequest.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-md border p-3 hover:bg-muted/30">{task.pullRequest.state === "merged" ? <GitMerge className="size-5 shrink-0 text-violet-500" /> : <GitPullRequest className="size-5 shrink-0 text-emerald-500" />}<span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{task.title}</span><span className="text-xs text-muted-foreground">{task.configuration.repository} #{task.pullRequest.number}</span></span><Badge variant="secondary">{task.pullRequest.state === "merged" ? "Merged" : task.pullRequest.state === "closed" ? "Closed" : "Open"}</Badge><ExternalLink className="size-3.5 shrink-0 text-muted-foreground" /></a> : <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{task.status === "backlog" ? "The task is ready to start." : task.status === "active" ? "Root owns the task. Agent replies appear below." : task.status === "delivered" ? "The delivery target is complete." : task.status === "cancelled" ? "The task is cancelled." : "Root needs your answer."}</p>{editable ? <Button size="sm" disabled={busy} onClick={() => void act("start")}>Start task</Button> : null}</div>}
            {task.humanQuestion ? <section className="grid gap-3" aria-label="Question"><h3 className="text-sm font-medium">Answer necessary</h3><Markdown source={task.humanQuestion.text} /><form className="grid gap-2" onSubmit={event => { event.preventDefault(); void act("answer", { questionId: task.humanQuestion?.id, answer: message, confirmCommandsStopped: cleanupQuestion === task.humanQuestion?.id }); }}><Textarea aria-label="Answer" value={message} onChange={event => setMessage(event.target.value)} required />{task.humanQuestion.requiresCommandCleanup ? <label className="flex items-center gap-2 text-xs"><Checkbox checked={cleanupQuestion === task.humanQuestion.id} onCheckedChange={checked => setCleanupQuestion(checked ? task.humanQuestion!.id : null)} />All commands from this session have stopped</label> : null}<div><Button size="sm" type="submit" disabled={busy || !message.trim() || task.humanQuestion.requiresCommandCleanup && cleanupQuestion !== task.humanQuestion.id}>Answer and continue</Button></div></form></section> : null}
          </div></div>
          <TaskWork task={task} activity={activity} composer={composer} />
        </div></div>
      </div>
      <aside aria-label="Task properties" className="min-w-0 border-t px-4 py-5 lg:min-h-[calc(100dvh-6rem)] lg:border-l lg:border-t-0">
        <h3 className="mb-4 text-xs font-medium">Properties</h3>
        <dl className="grid grid-cols-1 gap-5 text-xs">
          <div className="space-y-1.5"><dt className="text-muted-foreground">Status</dt><dd><TaskStatus status={task.status} /></dd></div>
          <div className="space-y-1.5"><dt className="text-muted-foreground">Project</dt><dd className="break-words">{project?.name ?? task.configuration.repository}</dd></div>
          {(["root", "worker"] as const).map(role => { const profile = role === "root" ? task.rootProfile : task.workerProfile; const label = role === "root" ? "Root" : "Worker"; return <div key={role} className="space-y-1.5"><dt className="text-muted-foreground">{label}</dt><dd className="flex items-center gap-2"><ProfileAvatar name={label} seed={profile.profileId} size="xs" /><span className="min-w-0"><span className="block truncate" title={`${profile.provider}/${profile.model}`}>{profile.model}</span><span className="block text-[11px] text-muted-foreground">{profile.provider} · {profile.reasoningLevel}</span></span></dd></div>; })}
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
    <Dialog open={image !== null} onOpenChange={open => { if (!open) setImage(null); }}><DialogContent><DialogHeader><DialogTitle>{image?.filename ?? "Image preview"}</DialogTitle></DialogHeader>{image ? <img className="max-h-[70dvh] w-full object-contain" src={`/api/tasks/${task.id}/images/${image.artifactId}`} alt={image.filename} /> : null}</DialogContent></Dialog>
  </article>;
}
