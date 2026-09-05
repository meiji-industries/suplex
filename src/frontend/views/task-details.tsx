import { useEffect, useState, type ReactElement } from "react";
import { z } from "zod";
import type { Task } from "../../task-contracts.js";
import { TaskActivityResponseSchema } from "../../http/contracts/tasks.js";
import { readJson, withCompany } from "../lib/api.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { Input } from "../components/ui/input.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Markdown } from "../components/app/markdown.js";
import { LivePaneTerminal } from "../components/app/task-chat/live-pane-terminal.js";

const labels = { backlog: "Backlog", active: "Active", waiting_human: "Answer necessary", cancelled: "Cancelled", delivered: "Delivered" };
const turnLabels = { pending_prompt: "Queued", prompted: "Sent to OpenCode", unknown: "Observation not available", completed: "Turn ended", cancelled: "Cancelled" };
type Activity = z.infer<typeof TaskActivityResponseSchema>;

export function TaskDetailsPage({ task, onChange }: { task: Task; onChange: (task: Task) => void }): ReactElement {
  const [activity, setActivity] = useState<Activity>({ sessions: [], turns: [] });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cleanupQuestion, setCleanupQuestion] = useState<string | null>(null);
  const [pane, setPane] = useState<"root" | "worker" | null>(null);
  const [edit, setEdit] = useState<{ title: string; description: string } | null>(null);
  const saveDetails = async () => {
    if (!edit || busy) return;
    setBusy(true); setError("");
    try {
      const result = await readJson<Task>(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(edit) });
      onChange(result); setEdit(null);
    } catch (error) { setError(error instanceof Error ? error.message : "The task could not be saved"); }
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
    setBusy(true); setError("");
    try {
      const result = await readJson<Task>(`/api/tasks/${task.id}/${action}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      onChange(result); setMessage("");
    } catch (error) { setError(error instanceof Error ? error.message : "The action failed"); }
    finally { setBusy(false); }
  };
  const openWorktree = async (app: "editor" | "terminal") => {
    try { const result = await readJson<{ ok: boolean; error?: string }>(`/api/tasks/${task.id}/worktree/open`, { method: "POST", body: JSON.stringify({ app }) }); if (!result.ok) setError(result.error ?? "The worktree could not be opened"); }
    catch (error) { setError(String(error)); }
  };
  return <div className="grid min-w-0 gap-4 p-3 sm:p-4">
    <div className="flex flex-wrap items-center gap-2 text-xs"><a href={withCompany("/tasks", task.companyId)}>Open tasks</a><span>{labels[task.status]}</span>{task.archivedAt ? <span>Archived</span> : null}</div>
    <h2 className="text-base font-medium" aria-label={task.title}>{task.status === "backlog" && !task.archivedAt ? <button type="button" aria-label="Edit task title" onClick={() => setEdit({ title: task.title, description: task.description })}>{task.title}</button> : task.title}</h2>
    {edit ? <form className="grid gap-2" aria-label="Task details" onSubmit={event => { event.preventDefault(); void saveDetails(); }}><Input aria-label="Task title" value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })} required /><Textarea aria-label="Task description" value={edit.description} onChange={event => setEdit({ ...edit, description: event.target.value })} required /><div className="flex gap-2"><Button type="submit" disabled={busy}>Save task</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button></div></form> : null}
    <div className="flex flex-wrap gap-2">
      {task.status === "backlog" && !task.archivedAt ? <Button size="sm" disabled={busy} onClick={() => void act("start")}>Start task</Button> : null}
      {!["cancelled", "delivered"].includes(task.status) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("cancel")}>Cancel task</Button> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("refresh")}>Check current state</Button>
      {["backlog", "cancelled", "delivered"].includes(task.status) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(task.archivedAt ? "unarchive" : "archive")}>{task.archivedAt ? "Open from archive" : "Keep in archive"}</Button> : null}
    </div>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {task.humanQuestion ? <section className="grid gap-2 border-b pb-3" aria-label="Question"><h3 className="text-sm font-medium">Answer necessary</h3><Markdown source={task.humanQuestion.text} /><form className="grid gap-2" onSubmit={event => { event.preventDefault(); void act("answer", { questionId: task.humanQuestion?.id, answer: message, confirmCommandsStopped: cleanupQuestion === task.humanQuestion?.id }); }}><Textarea aria-label="Answer" value={message} onChange={event => setMessage(event.target.value)} required />{task.humanQuestion.requiresCommandCleanup ? <label className="flex items-center gap-2 text-sm"><Checkbox checked={cleanupQuestion === task.humanQuestion.id} onCheckedChange={checked => setCleanupQuestion(checked ? task.humanQuestion!.id : null)} />All commands from this session have stopped</label> : null}<div><Button type="submit" disabled={busy || !message.trim() || task.humanQuestion.requiresCommandCleanup && cleanupQuestion !== task.humanQuestion.id}>Answer and continue</Button></div></form></section> : null}
    <Markdown source={task.description} />
    {task.status === "backlog" && !task.archivedAt ? <div><Button size="sm" variant="ghost" onClick={() => setEdit({ title: task.title, description: task.description })}>Edit task description</Button></div> : null}
    {task.images.length ? <ul className="flex flex-wrap gap-3" aria-label="Task images">{task.images.map(image => <li key={image.artifactId}><a href={`/api/tasks/${task.id}/images/${image.artifactId}`} target="_blank" rel="noreferrer"><img className="max-h-40 max-w-full" src={`/api/tasks/${task.id}/images/${image.artifactId}`} alt={image.filename} /></a></li>)}</ul> : null}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs"><dt>Root</dt><dd className="break-all">{task.rootProfile.provider}/{task.rootProfile.model} · {task.rootProfile.reasoningLevel}</dd><dt>Worker</dt><dd className="break-all">{task.workerProfile.provider}/{task.workerProfile.model} · {task.workerProfile.reasoningLevel}</dd><dt>Branch</dt><dd className="break-all">{task.configuration.branch}</dd><dt>Delivery target</dt><dd>{task.deliveryTarget.replaceAll("_", " ")}</dd>{task.pullRequest ? <><dt>Pull request</dt><dd><a href={task.pullRequest.url} target="_blank" rel="noreferrer">#{task.pullRequest.number} · {task.pullRequest.state}</a></dd></> : null}</dl>
    {task.worktree ? <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 break-all text-xs">{task.worktree.path}</code><Button size="sm" variant="outline" onClick={() => void openWorktree("editor")}>Open editor</Button><Button size="sm" variant="outline" onClick={() => void openWorktree("terminal")}>Open terminal</Button></div> : null}
    {task.status === "active" ? <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void act("note", { note: message }); }}><Textarea aria-label="Note to Root" value={message} onChange={event => setMessage(event.target.value)} placeholder="Send a note to Root" /><div><Button type="submit" disabled={busy || !message.trim()}>Send note</Button></div></form> : null}
    <section className="grid min-w-0 gap-2" aria-label="Sessions"><h3 className="text-sm font-medium">Sessions</h3>{activity.sessions.map(session => <div key={session.id} className="flex flex-wrap items-center gap-2 text-xs"><span>{session.kind === "root" ? "Root" : "Worker"} {session.generation}</span><code className="min-w-0 break-all">{session.nativeSessionId ?? "Not started"}</code>{session.paneId && session.current ? <Button size="sm" variant="outline" onClick={() => setPane(session.kind)}>Open display</Button> : null}</div>)}{pane ? <div className="h-96 min-w-0"><LivePaneTerminal taskId={task.id} role={pane} paneId={activity.sessions.find(session => session.kind === pane && session.current)?.paneId ?? null} /></div> : null}</section>
    <section className="grid min-w-0 gap-2" aria-label="Task activity"><h3 className="text-sm font-medium">Task activity</h3>{activity.turns.map(turn => {
      const result = z.string().transform((value, context) => { try { return JSON.parse(value); } catch { context.addIssue({ code: "custom", message: "Invalid result" }); return z.NEVER; } }).pipe(z.object({ text: z.string().optional() })).safeParse(turn.result);
      return <details key={turn.id} className="min-w-0 border-b py-2"><summary className="cursor-pointer text-xs">{activity.sessions.find(session => session.id === turn.sessionId)?.kind ?? "Session"} · {turnLabels[turn.status]}</summary><div className="grid gap-3 pt-2"><Markdown source={turn.prompt} />{result.success && result.data.text ? <Markdown source={result.data.text} /> : null}</div></details>;
    })}</section>
  </div>;
}
