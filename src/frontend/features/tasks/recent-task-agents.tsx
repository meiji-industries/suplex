import type { TaskSetup } from "../../contracts/generated/TaskSetup.js";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { TaskAgentsResponseSchema, TaskAgentStatusSchema } from "../../contracts/task-responses.js";
import { readTaskAgentExpiry } from "./task-agent-expiry.js";
import { roleLabel } from "./workflow-presentation.js";

const labels = { queued: "Queued", working: "Working", retrying: "Retry", idle: "Idle", waiting_human: "Answer necessary", stopped: "Stopped", unknown: "Not available" } satisfies Record<z.infer<typeof TaskAgentStatusSchema>, string>;
type TaskAgent = z.infer<typeof TaskAgentsResponseSchema>["agents"][number];

export function isTaskAgentExpired(agent: TaskAgent, now: number, expiryMs: number): boolean {
  if (agent.status !== "idle" && agent.status !== "stopped") return false;
  if (expiryMs === 0) return true;
  if (!agent.statusChangedAt) return false;
  const changedAt = Date.parse(agent.statusChangedAt);
  return Number.isFinite(changedAt) && now - changedAt >= expiryMs;
}

export function RecentTaskAgents({ agents, setup }: { agents: TaskAgent[]; setup?: TaskSetup | undefined }) {
  const [expiryMs] = useState(readTaskAgentExpiry);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(timer);
  }, []);
  const visibleAgents = agents.filter(agent => !isTaskAgentExpired(agent, now, expiryMs));
  // The row shows only while setup runs. The Setup tab keeps the result.
  const showSetup = setup?.state === "running";
  if (!visibleAgents.length && !showSetup) return null;
  return <ul className="ml-6 min-w-0" aria-label="Task agents">{showSetup ? <li data-setup-state={setup.state} title="Setup: Working" className="flex h-6 min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground"><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-emerald-500" /><span className="min-w-0 truncate">Setup · Working</span></li> : null}{visibleAgents.map(agent => {
    const role = agent.label ?? roleLabel({ kind: agent.role, advisorRole: agent.advisorRole ?? null });
    const color = agent.status === "working" ? "bg-emerald-500" : ["waiting_human", "retrying"].includes(agent.status) ? "bg-amber-500" : "bg-muted-foreground";
    return <li key={agent.id} data-live-pane-row={agent.paneId ?? undefined} data-agent-status={agent.status} title={`${role}: ${labels[agent.status]}`} className="flex h-6 min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${color}`} /><span className="min-w-0 truncate">{role} · {labels[agent.status]}</span></li>;
  })}</ul>;
}
