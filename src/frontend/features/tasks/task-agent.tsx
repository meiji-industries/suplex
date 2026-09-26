import { ProjectProviderPolicySchema } from "../../contracts/provider-policy.js";
import { getTask, selectTaskAgent } from "./lib/task-api.js";
import { useEffect, useState } from "react";
import type { Task } from "../../contracts/tasks.js";
import type { TaskAgentSelectionRequest } from "../../contracts/agent-selection.js";
import { ADVISOR_LABELS } from "./workflow-presentation.js";
import { TaskActivityResponseSchema } from "../../contracts/task-responses.js";
import { isProfileAllowed } from "../projects/lib/provider-policy.js";
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

export type TaskAgentRole = TaskAgentSelectionRequest["role"];
export const taskAgentLabel = (role: TaskAgentRole): string => role === "root" ? "Coordinator" : role === "worker" ? "Worker" : ADVISOR_LABELS[role];
const roleProfile = (task: Task, role: TaskAgentRole) => role === "root" ? task.rootProfile : role === "worker" ? task.workerProfile : task.advisorProfiles[role] ?? task.rootProfile;
const roleSession = (activity: TaskActivity, role: TaskAgentRole) => activity.sessions.find(session => session.current && (role === "root" ? session.kind === "root" : session.kind === "worker" && session.advisorRole === (role === "worker" ? null : role)));

export function TaskAgent({ task, role, onChange, onActivityChange, openRequest, onOpenRequestHandled }: {
  task: Task; role: TaskAgentRole; onChange: (task: Task) => void; onActivityChange: (activity: TaskActivity) => void;
  openRequest?: number; onOpenRequestHandled?: () => void;
}) {
  const label = taskAgentLabel(role);
  const profile = roleProfile(task, role);
  const eligible = !task.archivedAt && (task.status === "active" || task.status === "waiting_human");
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<{ task: Task; sessionId: string | null } | null>(null);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [direction, setDirection] = useState("");
  const [resume, setResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = profileId || (intent ? roleProfile(intent.task, role).profileId : "");
  const question = intent?.task.status === "waiting_human" ? intent.task.humanQuestion : null;
  const canResume = question?.kind === "question" && !question.requiresCommandCleanup;
  const noChange = selected === (intent ? roleProfile(intent.task, role).profileId : "") && !direction.trim() && !resume;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readJson<{ profiles: ApiProfile[] }>("/api/profiles").then(result => { if (!cancelled) setProfiles(result.profiles); }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Agent profiles are not available."); });
    return () => { cancelled = true; };
  }, [open]);
  const allowed = profiles.filter(item => item.role === (role === "worker" ? "worker" : "root") && !item.archivedAt && isProfileAllowed(ProjectProviderPolicySchema.nullish().parse(intent?.task.configuration.providerPolicy), item));
  const openDialog = async () => {
    if (busy) return;
    setBusy(true); setError(""); setIntent(null);
    try {
      const [freshTask, freshActivity] = await Promise.all([getTask(task.id), readJson(`/api/tasks/${task.id}/activity`).then(value => TaskActivityResponseSchema.parse(value))]);
      onChange(freshTask); onActivityChange(freshActivity);
      setIntent({ task: freshTask, sessionId: roleSession(freshActivity, role)?.id ?? null });
      setProfileId(roleProfile(freshTask, role).profileId); setDirection(""); setResume(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Task activity is not available."); }
    finally { setBusy(false); setOpen(true); }
  };
  useEffect(() => { if (openRequest) { onOpenRequestHandled?.(); void openDialog(); } }, [openRequest]);
  const save = async () => {
    if (!intent || busy || !selected || noChange) return;
    setBusy(true); setError("");
    try {
      const body: TaskAgentSelectionRequest = resume && question
        ? { role, expectedProfileId: roleProfile(intent.task, role).profileId, expectedSessionId: intent.sessionId, profileId: selected, direction, resume: true, questionId: question.id }
        : { role, expectedProfileId: roleProfile(intent.task, role).profileId, expectedSessionId: intent.sessionId, profileId: selected, direction, resume: false };
      const updated = await selectTaskAgent(task.id, body);
      onChange(updated);
      await readJson(`/api/tasks/${task.id}/activity`).then(value => onActivityChange(TaskActivityResponseSchema.parse(value)), () => undefined);
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Suplex could not save the ${label}.`); }
    finally { setBusy(false); }
  };
  return <div className="space-y-1.5"><dt className="text-muted-foreground">{label}</dt><dd>
    {eligible ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void openDialog()} aria-label={`Select ${label}`}><EntityAvatar kind="agent" id={profile.profileId} name={label} size="xs" /><span className="min-w-0 text-left"><span className="block truncate" title={`${profile.model} · ${profile.provider}`}>{profile.model}</span><span className="block text-xs text-muted-foreground">{profile.provider} · {profile.reasoningLevel}</span></span></Button>
      : <span className="flex items-center gap-2"><EntityAvatar kind="agent" id={profile.profileId} name={label} size="xs" /><span className="min-w-0"><span className="block truncate">{profile.model}</span><span className="block text-xs text-muted-foreground">{profile.provider} · {profile.reasoningLevel}</span></span></span>}
  </dd><Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Select {label}</DialogTitle></DialogHeader>
    <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="text-xs text-muted-foreground">Suplex uses this agent for remaining work. Suplex keeps completed work, history, and limits.</p>
      <TaskRoleSelector role={role === "worker" ? "worker" : "root"} {...(role === "root" || role === "worker" ? {} : { label })} profiles={allowed} assignment={profileId} defaultProfileId={intent ? roleProfile(intent.task, role).profileId : undefined} showDefaultChoice={false} busy={busy} onChange={setProfileId} />
      <div className="grid gap-1"><Label htmlFor={`agent-direction-${role}-${task.id}`}>Additional direction (optional)</Label><Textarea id={`agent-direction-${role}-${task.id}`} value={direction} onChange={event => setDirection(event.target.value)} disabled={busy} /></div>
      {question ? <div className="grid gap-2 text-xs"><p>{question.text}</p>{canResume ? <><p className="text-muted-foreground">Suplex sends the unanswered question to Coordinator.</p><label className="flex items-center gap-2"><Checkbox checked={resume} disabled={busy} onCheckedChange={checked => setResume(checked === true)} />Resume the task</label></> : <p className="text-muted-foreground">The current decision stays pending. Answer it to resume the task.</p>}</div> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || !intent || noChange || !allowed.some(item => item.id === selected)}>{resume ? "Save and resume" : `Save ${label}`}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog></div>;
}
