import { useEffect, useState } from "react";
import type { Task } from "../../../tasks/contracts.js";
import type { TaskActivity } from "./task-work.js";
import type { ApiProfile } from "../../shell/view-shared.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Label } from "../../components/ui/label.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { TaskRoleSelector } from "./task-role-selectors.js";

export function TaskWorker({ task, activity, onChange }: { task: Task; activity: TaskActivity; onChange: (task: Task) => void }) {
  const workers = activity.sessions.filter(session => session.kind === "worker" && !session.advisorRole);
  const worker = workers.find(session => session.current);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("Change the execution strategy.");
  const [handoff, setHandoff] = useState("");
  const [profileId, setProfileId] = useState("");
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let closed = false;
    void readJson<{ profiles: ApiProfile[] }>("/api/profiles").then(result => { if (!closed) setProfiles(result.profiles); }).catch(() => { if (!closed) setError("Worker profiles are not available. You can keep the current profile."); });
    return () => { closed = true; };
  }, [open]);
  if (!workers.length) return null;
  const eligible = !!worker && !task.archivedAt && ["active", "waiting_human"].includes(task.status);
  const replacements = workers.filter(session => session.replacement);
  const number = (id: string) => workers.findIndex(session => session.id === id) + 1;
  return <section aria-label="Worker" className="grid gap-2 border-b pb-3">
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold">Worker{worker ? ` ${number(worker.id)}` : ""}</span><span className="text-xs text-muted-foreground">{task.workerProfile.model}</span>{eligible ? <Button type="button" variant="outline" size="sm" onClick={() => { setOpen(!open); setError(""); }} aria-expanded={open}>Replace Worker</Button> : null}</div>
    {open && eligible ? <form className="grid gap-3" aria-label="Replace Worker" onSubmit={async event => {
      event.preventDefault();
      if (busy || !worker) return;
      setBusy(true); setError("");
      try {
        const updated = await readJson<Task>(`/api/tasks/${task.id}/replace-worker`, { method: "POST", body: JSON.stringify({ sessionId: worker.id, reason, handoff, ...(profileId ? { workerProfileId: profileId } : {}) }) });
        onChange(updated); setOpen(false); setHandoff("");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Forge could not replace the Worker."); }
      finally { setBusy(false); }
    }}>
      <p className="text-xs text-muted-foreground">Forge starts a fresh conversation and keeps the worktree, commits, assignment, and history. Task limits stay the same.</p>
      {task.status === "waiting_human" ? <p className="text-xs">The task stays paused until you answer its current decision.</p> : null}
      <div className="grid gap-1"><Label htmlFor={`replacement-reason-${task.id}`}>Reason</Label><Input id={`replacement-reason-${task.id}`} value={reason} onChange={event => setReason(event.target.value)} required disabled={busy} /></div>
      <div className="grid gap-1"><Label htmlFor={`replacement-handoff-${task.id}`}>Additional direction (optional)</Label><Textarea id={`replacement-handoff-${task.id}`} value={handoff} onChange={event => setHandoff(event.target.value)} disabled={busy} placeholder="Describe remaining work, verification evidence, and the next expected outcome." /></div>
      <div className="flex flex-wrap items-center gap-2"><TaskRoleSelector role="worker" profiles={profiles} assignment={profileId} defaultProfileId={task.workerProfile.profileId} defaultChoiceLabel="Current Worker profile" busy={busy} onChange={setProfileId} /><Button type="submit" size="sm" disabled={busy || !reason.trim()}>{busy ? "Please wait" : "Replace Worker"}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></div>
    </form> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {replacements.length ? <details><summary className="cursor-pointer text-xs">Worker replacements ({replacements.length})</summary><ul className="grid gap-2 pt-2 text-xs">{replacements.map(session => <li key={session.id}><span className="font-medium">Worker {number(session.replacement!.sessionId)} → Worker {number(session.id)}</span><p>{session.replacement!.reason}</p><details><summary className="cursor-pointer text-muted-foreground">Handoff</summary><p className="whitespace-pre-wrap">{session.replacement!.handoff}</p></details></li>)}</ul></details> : null}
  </section>;
}
