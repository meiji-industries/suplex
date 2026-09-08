import { useEffect, useState } from "react";
import type { z } from "zod";
import { TaskAgentsResponseSchema, type TaskAgentStatusSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";
import { readTaskAgentExpiry } from "./task-agent-expiry.js";
import { roleLabel } from "../../../coordination/workflows.js";

const labels = { queued: "Queued", working: "Working", retrying: "Retry", idle: "Idle", waiting_human: "Answer necessary", stopped: "Stopped", unknown: "Not available" } satisfies Record<z.infer<typeof TaskAgentStatusSchema>, string>;
type TaskAgent = z.infer<typeof TaskAgentsResponseSchema>["agents"][number];

export function isTaskAgentExpired(agent: TaskAgent, now: number, expiryMs: number): boolean {
  if (agent.status !== "idle" && agent.status !== "stopped") return false;
  if (expiryMs === 0) return true;
  if (!agent.statusChangedAt) return false;
  const changedAt = Date.parse(agent.statusChangedAt);
  return Number.isFinite(changedAt) && now - changedAt >= expiryMs;
}

export function RecentTaskAgents({ taskId }: { taskId: string }) {
  const [agents, setAgents] = useState<z.infer<typeof TaskAgentsResponseSchema>["agents"]>([]);
  const [expiryMs] = useState(readTaskAgentExpiry);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let closed = false;
    let reading = false;
    const load = async () => {
      if (closed || reading) return;
      reading = true;
      try { const value = TaskAgentsResponseSchema.parse(await readJson(`/api/tasks/${taskId}/agents`)); if (!closed) { setAgents(value.agents); setNow(Date.now()); } }
      catch { if (!closed) setAgents(current => current.map(agent => ({ ...agent, status: "unknown" }))); }
      finally { reading = false; }
    };
    void load();
    const timer = setInterval(() => { setNow(Date.now()); void load(); }, 3000);
    return () => { closed = true; clearInterval(timer); };
  }, [taskId]);
  const visibleAgents = agents.filter(agent => !isTaskAgentExpired(agent, now, expiryMs));
  if (!visibleAgents.length) return null;
  return <ul className="ml-6 min-w-0" aria-label="Task agents">{visibleAgents.map(agent => {
    const role = agent.label ?? roleLabel({ kind: agent.role, advisorRole: agent.advisorRole ?? null });
    const color = agent.status === "working" ? "bg-emerald-500" : ["waiting_human", "retrying"].includes(agent.status) ? "bg-amber-500" : "bg-muted-foreground";
    return <li key={agent.id} data-live-pane-row={agent.paneId ?? undefined} data-agent-status={agent.status} title={`${role}: ${labels[agent.status]}`} className="flex h-6 min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${color}`} /><span className="min-w-0 truncate">{role} · {labels[agent.status]}</span></li>;
  })}</ul>;
}
