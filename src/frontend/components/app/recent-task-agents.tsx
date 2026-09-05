import { useEffect, useState } from "react";
import type { z } from "zod";
import { TaskAgentsResponseSchema, type TaskAgentStatusSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";

const labels = { queued: "Queued", working: "Working", retrying: "Retry", idle: "Idle", waiting_human: "Answer necessary", stopped: "Stopped", unknown: "Not available" } satisfies Record<z.infer<typeof TaskAgentStatusSchema>, string>;

export function RecentTaskAgents({ taskId }: { taskId: string }) {
  const [agents, setAgents] = useState<z.infer<typeof TaskAgentsResponseSchema>["agents"]>([]);
  useEffect(() => {
    let closed = false;
    let reading = false;
    const load = async () => {
      if (closed || reading) return;
      reading = true;
      try { const value = TaskAgentsResponseSchema.parse(await readJson(`/api/tasks/${taskId}/agents`)); if (!closed) setAgents(value.agents); }
      catch { if (!closed) setAgents(current => current.map(agent => ({ ...agent, status: "unknown" }))); }
      finally { reading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { closed = true; clearInterval(timer); };
  }, [taskId]);
  if (!agents.length) return null;
  return <ul className="ml-6 min-w-0" aria-label="Task agents">{agents.map(agent => {
    const role = agent.role === "root" ? "Root" : "Worker";
    const color = agent.status === "working" ? "bg-emerald-500" : ["waiting_human", "retrying"].includes(agent.status) ? "bg-amber-500" : "bg-muted-foreground";
    return <li key={agent.id} data-live-pane-row={agent.paneId ?? undefined} data-agent-status={agent.status} title={`${role}: ${labels[agent.status]}`} className="flex h-6 min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${color}`} /><span className="min-w-0 truncate">{role} · {labels[agent.status]}</span></li>;
  })}</ul>;
}
