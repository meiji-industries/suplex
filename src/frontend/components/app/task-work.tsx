import { useEffect, useState } from "react";
import { z } from "zod";
import { CircleDashed } from "lucide-react";
import type { Task } from "../../../task-contracts.js";
import { type TaskActivityResponseSchema, TaskChecksResponseSchema, TaskDiffResponseSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Spinner } from "../ui/spinner.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";
import { Markdown } from "./markdown.js";
import { EntityAvatar } from "./entity-avatar.js";
import { RootPlan, TaskTools, useTaskExecution } from "./task-execution.js";
import { TaskCheckResults } from "./task-check-results.js";
import { DeveloperDiff } from "./developer-diff.js";
import { TaskActivityTimeline } from "./task-activity-timeline.js";

export type TaskActivity = z.infer<typeof TaskActivityResponseSchema>;
const turnLabels = { pending_prompt: "Queued", prompted: "In progress", unknown: "Observation not available", completed: "Turn ended", cancelled: "Cancelled" };
const answerLabels = { pending_prompt: "Queued", prompted: "Sent to Coordinator", unknown: "Delivery not confirmed", completed: "Sent to Coordinator", cancelled: "Cancelled" };
const ResultSchema = z.object({ text: z.string().optional() });

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

export function TaskWork({ task, activity }: { task: Task; activity: TaskActivity }) {
  const [tab, setTab] = useState("chat");
  const { execution, error: executionError } = useTaskExecution(task.id);
  return <Tabs value={tab} onValueChange={value => setTab(String(value))} data-task-work-tabs>
    <TaskActivityTimeline taskId={task.id} />
    <div className="max-w-full border-b"><TabsList variant="line"><TabsTrigger value="chat">Chat</TabsTrigger><TabsTrigger value="activity">Activity <span className="text-xs text-muted-foreground">{activity.turns.length}</span></TabsTrigger><TabsTrigger value="diffs">Diffs</TabsTrigger><TabsTrigger value="checks">Checks</TabsTrigger><TabsTrigger value="other">Other</TabsTrigger></TabsList></div>
    <TabsContent value="chat"><div className="grid min-w-0 gap-5 pt-3" aria-label="Conversation">
      <RootPlan execution={execution} />
      {activity.turns.filter(turn => resultText(turn.result) || humanMessage(turn.prompt)).map(turn => {
        const session = activity.sessions.find(session => session.id === turn.sessionId);
        const role = session?.kind === "worker" ? "Worker" : "Coordinator";
        return <div key={turn.id} className="grid min-w-0 gap-5">{humanMessage(turn.prompt) ? <article className="space-y-2 border-l-2 pl-3"><header className="flex items-center gap-2 text-xs"><span className="font-medium">You</span><span className="text-muted-foreground">{answerLabels[turn.status]}</span></header><Markdown source={humanMessage(turn.prompt)} /></article> : null}{resultText(turn.result) ? <article className="flex min-w-0 gap-3"><EntityAvatar kind="agent" id={role === "Coordinator" ? task.rootProfile.profileId : task.workerProfile.profileId} name={role} size="sm" /><div className="min-w-0 flex-1 space-y-2"><header className="flex items-center gap-2 text-xs"><span className="font-medium">{role}</span><span className="text-muted-foreground">{turnLabels[turn.status]}</span></header><Markdown source={resultText(turn.result)} /></div></article> : null}</div>;
      })}
      {!activity.turns.some(turn => resultText(turn.result) || humanMessage(turn.prompt)) ? <p className="text-xs text-muted-foreground">{task.status === "backlog" ? "Start the task to work with Coordinator." : "Agent replies appear here."}</p> : null}
    </div></TabsContent>
    <TabsContent value="activity"><section aria-label="Task activity" className="grid min-w-0 gap-0 pt-3">{activity.turns.map(turn => <div key={turn.id} className="flex gap-3 border-b py-3 text-xs"><CircleDashed className="size-4 shrink-0 text-muted-foreground" /><span className="font-medium">{activity.sessions.find(session => session.id === turn.sessionId)?.kind === "worker" ? "Worker" : "Coordinator"}</span><span className="text-muted-foreground">{turnLabels[turn.status]}</span></div>)}{!activity.turns.length && !execution?.sessions.some(session => session.tools.length) ? <p className="text-xs text-muted-foreground">No activity yet.</p> : null}<TaskTools execution={execution} error={executionError} /></section></TabsContent>
    <TabsContent value="diffs">{tab === "diffs" ? <TaskDiff task={task} /> : null}</TabsContent>
    <TabsContent value="checks">{tab === "checks" ? <TaskChecks task={task} /> : null}</TabsContent>
    <TabsContent value="other"><div className="grid min-w-0 gap-4 pt-3 text-xs"><details><summary className="cursor-pointer font-medium">Runtime diagnostics</summary><section aria-label="Sessions" className="grid gap-3 pt-3">{activity.sessions.map(session => <div key={session.id}><p>{session.kind === "root" ? "Coordinator" : "Worker"} {session.generation}</p><code className="break-all text-muted-foreground">{session.nativeSessionId ?? "Not started"}</code></div>)}</section>{activity.turns.map(turn => <details key={turn.id} className="border-b py-2"><summary className="cursor-pointer">{turnLabels[turn.status]} · Prompt</summary><Markdown source={turn.prompt} /></details>)}</details></div></TabsContent>
  </Tabs>;
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
  const [checks, setChecks] = useState<z.infer<typeof TaskChecksResponseSchema> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let closed = false;
    let reading = false;
    const read = async () => {
      if (closed || reading) return;
      reading = true;
      try { const value = TaskChecksResponseSchema.parse(await readJson(`/api/tasks/${task.id}/checks`)); if (!closed) { setChecks(value); setError(""); } }
      catch (error) { if (!closed) setError(error instanceof Error ? error.message : "Checks are not available"); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 15000);
    return () => { closed = true; clearInterval(timer); };
  }, [task.id, task.updatedAt]);
  return <section aria-label="GitHub checks" className="space-y-3 pt-3">{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : !checks ? <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading checks…</span></p> : !checks.runs.length ? <p className="text-xs text-muted-foreground">{checks.available ? "GitHub has no checks for this pull request." : "No pull request checks are available."}</p> : <TaskCheckResults runs={checks.runs} />}</section>;
}
