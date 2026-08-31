import { useLayoutEffect, useRef, type ReactElement } from "react";

import { relativeTime, type ApiAgent, type ApiAgentRuntime } from "../../lib/view-shared.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { ProfileAvatar } from "./profile-avatar.js";
import { runtimeStatusLabel } from "./runtime-presentation.js";

type RowPosition = { index: number; top: number };

export function animateReorderedAgentRow(row: Element | null, previous: RowPosition | undefined, next: RowPosition): void {
  const offset = previous === undefined ? 0 : previous.top - next.top;
  if (previous === undefined || previous.index === next.index || offset === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  row?.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
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
  const summary = runtime.length ? runtime.map((entry) => `${entry.role}: ${runtimeStatusLabel(entry)} · ${entry.taskId}`).join(" · ") : `Last seen ${relativeTime(agent.lastSeenAt)}`;
  const active = runtime.some((entry) => entry.diagnosis === "working");
  return <SidebarMenuItem><SidebarMenuButton render={<div ref={row} data-agent-row={agent.id} />} size="lg"><span className={`flex min-w-0 flex-1 items-center gap-2 ${runtime.length ? "" : "opacity-50 grayscale"}`}><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate font-medium">{agent.name}</span><span title={summary} className="flex items-center gap-1 truncate text-xs text-muted-foreground">{active ? <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" /> : null}<span>{summary}</span></span></span></span></SidebarMenuButton></SidebarMenuItem>;
}

export function AgentsLeaderboard({ agents, runtime }: { agents: ApiAgent[]; runtime: ApiAgentRuntime[] }): ReactElement | null {
  if (agents.length === 0) return null;
  return <SidebarGroup><SidebarGroupLabel>Agents</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{agents.map((agent, index) => <AgentRow key={agent.id} agent={agent} runtime={runtime.filter((entry) => entry.agentId === agent.id)} index={index} />)}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
