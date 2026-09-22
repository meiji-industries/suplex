import { useEffect, useState } from "react";
import type { Task } from "../../../tasks/contracts.js";
import { TaskActivityResponseSchema } from "../../../http/contracts/tasks.js";
import { isProfileAllowed } from "../../../projects/provider-policy.js";
import type { ApiProfile } from "../../shell/view-shared.js";
import { readJson } from "../../lib/api.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { Textarea } from "../../components/ui/textarea.js";
import { TaskRoleSelector } from "./task-role-selectors.js";
import type { TaskActivity } from "./task-work.js";

export function TaskCoordinator({ task, activity, onChange, onActivityChange }: { task: Task; activity: TaskActivity; onChange: (task: Task) => void; onActivityChange: (activity: TaskActivity) => void }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [handoff, setHandoff] = useState("");
  const [resume, setResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [intent, setIntent] = useState<{ sessionId: string; task: Task } | null>(null);
  const current = activity.sessions.find(session => session.kind === "root" && session.current);
  const eligible = !!current && !task.archivedAt && (task.status === "active" || task.status === "waiting_human");
  const question = intent?.task.status === "waiting_human" ? intent.task.humanQuestion : null;
  const canResume = question?.kind === "question" && !question.requiresCommandCleanup;
  const selected = profileId || intent?.task.rootProfile.profileId || "";
  const noChange = selected === intent?.task.rootProfile.profileId && !handoff.trim() && !resume;
  useEffect(() => {
    if (!open) return;
    let closed = false;
    void readJson<{ profiles: ApiProfile[] }>("/api/profiles").then(result => { if (!closed) setProfiles(result.profiles); }).catch(cause => { if (!closed) setError(cause instanceof Error ? cause.message : "Coordinator profiles are not available."); });
    return () => { closed = true; };
  }, [open]);
  const allowed = profiles.filter(profile => profile.role === "root" && !profile.archivedAt && isProfileAllowed(intent?.task.configuration.providerPolicy, profile));
  const readActivity = async (): Promise<TaskActivity> => TaskActivityResponseSchema.parse(await readJson(`/api/tasks/${task.id}/activity`));
  const openDialog = async () => {
    if (busy) return;
    setBusy(true); setError(""); setIntent(null);
    try {
      const [freshTask, freshActivity] = await Promise.all([readJson<Task>(`/api/tasks/${task.id}`), readActivity()]);
      onChange(freshTask); onActivityChange(freshActivity);
      const root = freshActivity.sessions.find(session => session.kind === "root" && session.current);
      if (!root) throw new Error("The current Coordinator is not available.");
      setIntent({ sessionId: root.id, task: freshTask });
      setProfileId(freshTask.rootProfile.profileId); setHandoff(""); setResume(false); setOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Task activity is not available."); setOpen(true); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!intent || busy || !selected || noChange) return;
    setBusy(true); setError("");
    try {
      const updated = await readJson<Task>(`/api/tasks/${task.id}/replace-coordinator`, { method: "POST", body: JSON.stringify({ sessionId: intent.sessionId, rootProfileId: selected, handoff, resume, ...(resume && question ? { questionId: question.id } : {}) }) });
      onChange(updated);
      await readActivity().then(onActivityChange, () => undefined);
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Forge could not save the Coordinator."); }
    finally { setBusy(false); }
  };
  return <div className="space-y-1.5"><dt className="text-muted-foreground">Coordinator</dt><dd>
    {eligible ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void openDialog()} aria-label="Select Coordinator"><EntityAvatar kind="agent" id={task.rootProfile.profileId} name="Coordinator" size="xs" /><span className="min-w-0 text-left"><span className="block truncate" title={`${task.rootProfile.model} · ${task.rootProfile.provider}`}>{task.rootProfile.model}</span><span className="block text-[11px] text-muted-foreground">{task.rootProfile.provider} · {task.rootProfile.reasoningLevel}</span></span></Button> : <span className="flex items-center gap-2"><EntityAvatar kind="agent" id={task.rootProfile.profileId} name="Coordinator" size="xs" /><span className="min-w-0"><span className="block truncate">{task.rootProfile.model}</span><span className="block text-[11px] text-muted-foreground">{task.rootProfile.provider} · {task.rootProfile.reasoningLevel}</span></span></span>}
  </dd><Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Select Coordinator</DialogTitle></DialogHeader>
    <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="text-xs text-muted-foreground">Forge starts a new conversation. Forge keeps the task work, history, and limits.</p>
      <TaskRoleSelector role="root" profiles={allowed} assignment={profileId} defaultProfileId={intent?.task.rootProfile.profileId} defaultChoiceLabel="Current Coordinator" busy={busy} onChange={setProfileId} />
      <div className="grid gap-1"><Label htmlFor={`coordinator-direction-${task.id}`}>Additional direction (optional)</Label><Textarea id={`coordinator-direction-${task.id}`} value={handoff} onChange={event => setHandoff(event.target.value)} disabled={busy} /></div>
      {question ? <div className="grid gap-2 text-xs"><p>{question.text}</p>{canResume ? <><p className="text-muted-foreground">Forge sends the unanswered question to the new Coordinator.</p><label className="flex items-center gap-2"><Checkbox checked={resume} disabled={busy} onCheckedChange={checked => setResume(checked === true)} />Resume the task with the new Coordinator</label></> : <p className="text-muted-foreground">The current decision stays pending. Answer it to resume the task.</p>}</div> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || !intent || noChange || !allowed.some(profile => profile.id === selected)}>{resume ? "Save and resume" : "Save Coordinator"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog></div>;
}
