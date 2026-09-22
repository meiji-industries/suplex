import { TaskWorker } from "./task-worker.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CircleDashed } from "lucide-react";
import type { Task } from "../../../tasks/contracts.js";
import { type TaskActivityResponseSchema, TaskDiffResponseSchema, TaskDiffSummaryResponseSchema } from "../../../http/contracts/tasks.js";
import { useTaskChecks } from "./lib/task-checks.js";
import { readJson } from "../../lib/api.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { Markdown } from "../../components/app/markdown.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { RootPlan, TaskTools, useTaskExecution } from "./task-execution.js";
import { WorkflowPlan } from "./workflow-plan.js";
import { TaskCheckResults } from "./task-check-results.js";
import { DeveloperDiff } from "../../components/app/developer-diff.js";
import { TaskActivityTimeline } from "./task-activity-timeline.js";
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "../../components/ai-elements/prompt-input.js";
const MAX_TASK_NOTE_LENGTH = 20_000;

export type TaskActivity = z.infer<typeof TaskActivityResponseSchema>;
const turnLabels = { pending_prompt: "Queued", prompted: "In progress", unknown: "Observation not available", completed: "Turn ended", cancelled: "Cancelled" };
const answerLabels = { pending_prompt: "Queued", prompted: "Sent to Coordinator", unknown: "Delivery not confirmed", completed: "Sent to Coordinator", cancelled: "Cancelled" };
const ResultSchema = z.object({ text: z.string().optional() });

export function formatTurnDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

export function turnLabel(turn: TaskActivity["turns"][number]): string {
  if (turn.status !== "completed" || !turn.promptedAt || !turn.completedAt) return turnLabels[turn.status];
  const duration = Date.parse(turn.completedAt) - Date.parse(turn.promptedAt);
  return Number.isFinite(duration) && duration >= 0 ? `Turn took ${formatTurnDuration(duration)}` : turnLabels.completed;
}

function resultText(result: string | null): string {
  if (!result) return "";
  try { const parsed = ResultSchema.safeParse(JSON.parse(result)); return parsed.success ? parsed.data.text ?? "" : ""; }
  catch { return ""; }
}

function humanMessage(prompt: string): string {
  if (prompt.startsWith("Human note:\n")) return prompt.slice("Human note:\n".length);
  try {
    const answer = z.object({ question: z.string(), answer: z.string() }).strict().safeParse(JSON.parse(prompt));
    return answer.success ? answer.data.answer : "";
  } catch { return ""; }
}

export function TaskWork({ task, activity, onChange, onSelectWorker }: { task: Task; activity: TaskActivity; onChange: (task: Task) => void; onSelectWorker: () => void }) {
  const [tab, setTab] = useState("chat");
  const { execution, error: executionError } = useTaskExecution(task.id);
  const diffSummary = useTaskDiffSummary(task);
  return <Tabs value={tab} onValueChange={value => setTab(String(value))} data-task-work-tabs>
    <TaskWorker key={task.id} task={task} activity={activity} onSelect={onSelectWorker} />
    <TaskActivityTimeline taskId={task.id} />
    <div className="max-w-full border-b"><TabsList variant="line"><TabsTrigger value="chat">Chat</TabsTrigger><TabsTrigger value="activity">Activity <span className="text-xs text-muted-foreground">{activity.turns.length}</span></TabsTrigger><TabsTrigger value="diffs">Diffs{diffSummary?.available ? <span className="text-xs text-muted-foreground"> ({diffSummary.files})</span> : null}</TabsTrigger><TabsTrigger value="checks">Checks</TabsTrigger><TabsTrigger value="other">Other</TabsTrigger></TabsList></div>
    <TabsContent value="chat"><div className="grid min-w-0 gap-5 pt-3" aria-label="Conversation">
      <WorkflowPlan key={`workflow-plan-${task.id}`} task={task} />
      <RootPlan execution={execution} />
      {activity.turns.filter(turn => resultText(turn.result) || humanMessage(turn.prompt)).map(turn => {
        const session = activity.sessions.find(session => session.id === turn.sessionId);
        const role = session?.label ?? "Coordinator";
        return <div key={turn.id} className="grid min-w-0 gap-5">{humanMessage(turn.prompt) ? <article className="space-y-2 border-l-2 pl-3"><header className="flex items-center gap-2 text-xs"><span className="font-medium">You</span><span className="text-muted-foreground">{answerLabels[turn.status]}</span></header><Markdown source={humanMessage(turn.prompt)} /></article> : null}{resultText(turn.result) ? <article className="flex min-w-0 gap-3"><EntityAvatar kind="agent" id={session?.profileId ?? task.rootProfile.profileId} name={role} size="sm" /><div className="min-w-0 flex-1 space-y-2"><header className="flex items-center gap-2 text-xs"><span className="font-medium">{role}</span><span className="text-muted-foreground">{turnLabel(turn)}</span></header><Markdown source={resultText(turn.result)} /></div></article> : null}</div>;
      })}
      {!activity.turns.some(turn => resultText(turn.result) || humanMessage(turn.prompt)) ? <p className="text-xs text-muted-foreground">{task.status === "backlog" ? "Start the task to work with Coordinator." : task.status === "queued" ? "Forge starts this task when its prerequisites are complete." : "Agent replies appear here."}</p> : null}
      <TaskNoteInput key={`task-note-input-${task.id}`} task={task} onChange={onChange} />
    </div></TabsContent>
    <TabsContent value="activity"><section aria-label="Task activity" className="grid min-w-0 gap-0 pt-3">{activity.turns.map(turn => <div key={turn.id} className="flex gap-3 border-b py-3 text-xs"><CircleDashed className="size-4 shrink-0 text-muted-foreground" /><span className="font-medium">{activity.sessions.find(session => session.id === turn.sessionId)?.label ?? "Coordinator"}</span><span className="text-muted-foreground">{turnLabel(turn)}</span></div>)}{!activity.turns.length && !execution?.sessions.some(session => session.tools.length) ? <p className="text-xs text-muted-foreground">No activity yet.</p> : null}<TaskTools execution={execution} error={executionError} /></section></TabsContent>
    <TabsContent value="diffs">{tab === "diffs" ? <TaskDiff task={task} /> : null}</TabsContent>
    <TabsContent value="checks">{tab === "checks" ? <TaskChecks task={task} /> : null}</TabsContent>
    <TabsContent value="other"><div className="grid min-w-0 gap-4 pt-3 text-xs"><details><summary className="cursor-pointer font-medium">Runtime diagnostics</summary><section aria-label="Sessions" className="grid gap-3 pt-3">{activity.sessions.map(session => <div key={session.id}><p>{session.label} {session.generation}</p><code className="break-all text-muted-foreground">{session.nativeSessionId ?? "Not started"}</code></div>)}</section>{activity.turns.map(turn => <details key={turn.id} className="border-b py-2"><summary className="cursor-pointer">{turnLabel(turn)} · Prompt</summary><Markdown source={turn.prompt} /></details>)}</details></div></TabsContent>
  </Tabs>;
}

export function TaskNoteInput({ task, onChange }: { task: Task; onChange: (task: Task) => void }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const mounted = useRef(true);
  const currentTaskId = useRef(task.id);
  const inFlight = useRef(false);
  currentTaskId.current = task.id;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const eligible = ["active", "delivered"].includes(task.status) && !task.archivedAt;
  const trimmed = text.trim();
  const invalid = !trimmed || trimmed.length > MAX_TASK_NOTE_LENGTH;
  const submit = async ({ text: submittedText }: { text: string }) => {
    if (inFlight.current || !submittedText.trim() || submittedText.trim().length > MAX_TASK_NOTE_LENGTH || !eligible) return;
    inFlight.current = true;
    const submittedTaskId = task.id;
    const submittedRevision = revision.current;
    setSubmitting(true); setError("");
    try {
      const next = await readJson<Task>(`/api/tasks/${submittedTaskId}/note`, { method: "POST", body: JSON.stringify({ note: submittedText }) });
      if (!mounted.current || submittedTaskId !== currentTaskId.current) return;
      onChange(next);
      if (submittedRevision === revision.current) setText("");
    } catch (error) {
      if (mounted.current && submittedTaskId === currentTaskId.current) setError(error instanceof Error ? error.message : "Forge could not send the message. Retry the message.");
      throw error;
    } finally {
      inFlight.current = false;
      if (mounted.current && submittedTaskId === currentTaskId.current) setSubmitting(false);
    }
  };
  if (!eligible) return <p className="text-xs text-muted-foreground">{task.archivedAt ? "Open the archived task before you send a message." : task.status === "backlog" ? "Start the task before you send a message." : task.status === "queued" ? "Wait for Forge to start the task before you send a message." : task.status === "waiting_human" ? "Answer the current decision before you send a message." : "This task cannot receive messages."}</p>;
  return <section className="border-t pt-3" aria-label="Message Coordinator">
    {task.status === "delivered" ? <p>Send a message to resume this task.</p> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <div className={error ? "mt-2" : undefined}><PromptInput maxFiles={0} onError={() => setError("Attachments are not supported. Send text only.")} onSubmit={submit}>
      <PromptInputTextarea aria-label="Message Coordinator" value={text} onChange={event => { revision.current += 1; setText(event.currentTarget.value); }} onPaste={event => { if (Array.from(event.clipboardData.items).some(item => item.kind === "file")) { event.preventDefault(); setError("Attachments are not supported. Send text only."); } }} aria-invalid={trimmed.length > MAX_TASK_NOTE_LENGTH || undefined} />
      <PromptInputFooter><span className="mr-auto text-xs text-muted-foreground">{trimmed.length.toLocaleString()} / {MAX_TASK_NOTE_LENGTH.toLocaleString()}</span><PromptInputSubmit status={submitting ? "submitted" : "ready"} disabled={invalid || submitting} /></PromptInputFooter>
    </PromptInput></div>
  </section>;
}

function useTaskDiffSummary(task: Task) {
  const [summary, setSummary] = useState<z.infer<typeof TaskDiffSummaryResponseSchema> | null>(null);
  useEffect(() => {
    let closed = false;
    let reading = false;
    const read = async () => {
      if (closed || reading) return;
      reading = true;
      try { const value = TaskDiffSummaryResponseSchema.parse(await readJson(`/api/tasks/${task.id}/diff/summary`)); if (!closed) setSummary(value); }
      catch { if (!closed) setSummary(null); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [task.id, task.updatedAt]);
  return summary;
}

function TaskDiff({ task }: { task: Task }) {
  const [diff, setDiff] = useState<z.infer<typeof TaskDiffResponseSchema> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let closed = false;
    let reading = false;
    const read = async () => {
      if (closed || reading) return;
      reading = true;
      try { const value = TaskDiffResponseSchema.parse(await readJson(`/api/tasks/${task.id}/diff`)); if (!closed) { setDiff(value); setError(""); } }
      catch (error) { if (!closed) setError(error instanceof Error ? error.message : "Changes are not available"); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [task.id, task.updatedAt]);
  return <div className="min-w-0 space-y-3 pt-3" data-task-diff-panel>{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : !diff ? <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading changes…</span></p> : !diff.available ? <p className="text-xs text-muted-foreground">The worktree is not available.</p> : <DeveloperDiff patch={diff.patch} />}</div>;
}

function TaskChecks({ task }: { task: Task }) {
  const { checks, error } = useTaskChecks(task.id, task.pullRequest ? `${task.pullRequest.number}:${task.pullRequest.state}:${task.pullRequest.headSha}` : null);
  return <section aria-label="GitHub checks" className="space-y-3 pt-3">{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : !checks ? <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading checks…</span></p> : !checks.runs.length ? <p className="text-xs text-muted-foreground">{checks.available ? "GitHub has no checks for this pull request." : "No pull request checks are available."}</p> : <TaskCheckResults runs={checks.runs} />}</section>;
}
