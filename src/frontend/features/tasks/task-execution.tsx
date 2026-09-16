import { useEffect, useState } from "react";
import { CheckCircle2, Circle, CircleDashed, CircleX } from "lucide-react";
import { TaskExecutionResponseSchema, type TaskExecution } from "../../../tasks/execution/contracts.js";
import { readJson } from "../../lib/api.js";
import { Plan, PlanHeader, PlanTitle, PlanDescription, PlanAction, PlanTrigger, PlanContent } from "../../components/ai-elements/plan.js";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput, type ToolPart } from "../../components/ai-elements/tool.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { roleLabel } from "../../../coordination/workflows.js";

const toolStates = { pending: "input-streaming", running: "input-available", completed: "output-available", error: "output-error" } satisfies Record<TaskExecution["sessions"][number]["tools"][number]["status"], ToolPart["state"]>;
const planStates = { pending: "Pending", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" };
const planIcons = { pending: Circle, in_progress: CircleDashed, completed: CheckCircle2, cancelled: CircleX };

export function useTaskExecution(taskId: string) {
  const [execution, setExecution] = useState<TaskExecution | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let closed = false;
    let reading = false;
    setExecution(null);
    setError("");
    const read = async () => {
      if (reading || closed) return;
      reading = true;
      try {
        const value = TaskExecutionResponseSchema.parse(await readJson(`/api/tasks/${taskId}/execution`));
        if (!closed) { setExecution(value); setError(""); }
      } catch { if (!closed) setError("Agent activity is not available."); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [taskId]);
  return { execution, error };
}

export function RootPlan({ execution }: { execution: TaskExecution | null }) {
  const root = execution?.sessions.filter(session => session.role === "root").sort((a, b) => b.generation - a.generation)[0];
  if (!root?.available || !root.plan?.length) return null;
  return <section aria-label="Coordinator plan"><Plan defaultOpen>
    <PlanHeader><div><PlanTitle>Coordinator plan</PlanTitle><PlanDescription>Agent task list</PlanDescription></div><PlanAction><PlanTrigger /></PlanAction></PlanHeader>
    <PlanContent><ol className="grid gap-2">{root.plan.map((item, index) => {
      const Icon = planIcons[item.status];
      return <li key={index} className="flex items-start gap-2 text-sm"><Icon className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{item.content}</span><span className="shrink-0 text-xs text-muted-foreground">{planStates[item.status]}</span></li>;
    })}</ol></PlanContent>
  </Plan></section>;
}

export function TaskTools({ execution, error }: { execution: TaskExecution | null; error: string }) {
  return <section aria-label="Tool activity" className="grid min-w-0 gap-3 pt-3">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {execution?.sessions.map(session => <section key={session.id} aria-label={`${session.label ?? roleLabel({ kind: session.role, advisorRole: session.advisorRole ?? null })} ${session.generation} tools`} className="min-w-0">
      <h3 className="mb-2 text-xs font-medium">{session.label ?? roleLabel({ kind: session.role, advisorRole: session.advisorRole ?? null })} {session.generation}</h3>
      {!session.available ? <p className="text-xs text-muted-foreground">Agent activity is not available for this session.</p> : !session.tools.length ? <p className="text-xs text-muted-foreground">No tool calls yet.</p> : null}
      {session.limited ? <p className="mb-2 text-xs text-muted-foreground">This view includes the latest 100 messages. Open the live pane for the full session.</p> : null}
      {session.tools.map(tool => <Tool key={tool.id} defaultOpen={tool.status === "error"}>
        <ToolHeader type="dynamic-tool" toolName={tool.name} input={tool.input} state={toolStates[tool.status]} />
        <ToolContent><ToolInput input={tool.input} /><ToolOutput output={tool.output} errorText={tool.error ?? undefined} /></ToolContent>
      </Tool>)}
    </section>)}
  </section>;
}
