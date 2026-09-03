import { useLayoutEffect, useRef, type ReactElement } from "react";

import { relativeTime, type ApiAgent, type ApiAgentRuntime } from "../../lib/view-shared.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { ProfileAvatar } from "./profile-avatar.js";
import { runtimeStatusLabel } from "./runtime-presentation.js";

type RowPosition = { index: number; top: number };

export const AGENT_RECENCY_WINDOW_MS = 6 * 60 * 60 * 1_000;

export function filterRecentAgents(agents: readonly ApiAgent[], now = Date.now()): ApiAgent[] {
  return agents.filter((agent) => {
    const lastSeenAt = Date.parse(agent.lastSeenAt);
    return Number.isFinite(lastSeenAt) && now - lastSeenAt <= AGENT_RECENCY_WINDOW_MS;
  });
}

export function animateReorderedAgentRow(row: Element | null, previous: RowPosition | undefined, next: RowPosition): void {
  const offset = previous === undefined ? 0 : previous.top - next.top;
  if (previous === undefined || previous.index === next.index || offset === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  row?.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
}

export function agentRuntimeSummary(agent: { lastSeenAt: string }, runtime: readonly ApiAgentRuntime[]): string {
  if (!runtime.length) return `Last seen ${relativeTime(agent.lastSeenAt)}`;
  const lead = runtime.find((entry) => entry.diagnosis === "working") ?? runtime[0]!;
  return `${lead.role} · ${runtimeStatusLabel(lead)}${runtime.length > 1 ? ` +${runtime.length - 1} more` : ""}`;
}

export function agentRuntimeDetail(agent: { lastSeenAt: string }, runtime: readonly ApiAgentRuntime[]): string {
  if (!runtime.length) return `Last seen ${relativeTime(agent.lastSeenAt)}`;
  return runtime.map((entry) => `${entry.role} · ${runtimeStatusLabel(entry)} · ${entry.taskId}`).join(" · ");
}

function AgentRow({ agent, runtime, index }: { agent: ApiAgent; runtime: ApiAgentRuntime[]; index: number }): ReactElement {
  const row = useRef<HTMLDivElement>(null);
  const previousPosition = useRef<RowPosition>(undefined);
  useLayoutEffect(() => {
    const nextTop = row.current?.getBoundingClientRect().top;
    if (nextTop === undefined) return;
    const nextPosition = { index, top: nextTop };
    animateReorderedAgentRow(row.current, previousPosition.current, nextPosition);
    previousPosition.current = nextPosition;
  });
  const summary = agentRuntimeSummary(agent, runtime);
  const detail = agentRuntimeDetail(agent, runtime);
  const active = runtime.some((entry) => entry.diagnosis === "working");
  return <SidebarMenuItem><SidebarMenuButton render={<div ref={row} data-agent-row={agent.id} />} size="lg"><span className={`flex min-w-0 flex-1 items-center gap-2 ${runtime.length ? "" : "opacity-50 grayscale"}`}><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate font-medium">{agent.name}</span><span title={detail} className="flex items-center gap-1 truncate text-xs text-muted-foreground">{active ? <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" /> : null}<span>{summary}</span></span></span></span></SidebarMenuButton></SidebarMenuItem>;
}

export function AgentsLeaderboard({ agents, runtime }: { agents: ApiAgent[]; runtime: ApiAgentRuntime[] }): ReactElement | null {
  const recentAgents = filterRecentAgents(agents);
  if (recentAgents.length === 0) return null;
  return <SidebarGroup><SidebarGroupLabel>Agents</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{recentAgents.map((agent, index) => <AgentRow key={agent.id} agent={agent} runtime={runtime.filter((entry) => entry.agentId === agent.id)} index={index} />)}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
