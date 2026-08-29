import { useCallback, useLayoutEffect, useRef, type ReactElement } from "react";

import { relativeTime, type ApiAgent } from "../../lib/view-shared.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { ProfileAvatar } from "./profile-avatar.js";
import { useAgentStatus } from "./use-agent-status.js";

function AnimatedEllipsis(): ReactElement {
  return <span aria-hidden="true"><span className="motion-safe:animate-pulse [animation-duration:900ms]">.</span><span className="motion-safe:animate-pulse [animation-delay:150ms] [animation-duration:900ms]">.</span><span className="motion-safe:animate-pulse [animation-delay:300ms] [animation-duration:900ms]">.</span></span>;
}

type RowPosition = { index: number; top: number };

export function animateReorderedAgentRow(row: Element | null, previous: RowPosition | undefined, next: RowPosition): void {
  const offset = previous === undefined ? 0 : previous.top - next.top;
  if (previous === undefined || previous.index === next.index || offset === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  row?.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
}

function AgentRow({ agent, index }: { agent: ApiAgent; index: number }): ReactElement {
  const row = useRef<HTMLDivElement>(null);
  const previousPosition = useRef<RowPosition>(undefined);
  const active = agent.activeCount > 0;
  useLayoutEffect(() => {
    const nextTop = row.current?.getBoundingClientRect().top;
    if (nextTop === undefined) return;
    const nextPosition = { index, top: nextTop };
    animateReorderedAgentRow(row.current, previousPosition.current, nextPosition);
    previousPosition.current = nextPosition;
  });
  return <SidebarMenuItem><SidebarMenuButton render={<div ref={row} data-agent-row={agent.id} />} size="lg"><span className={`flex min-w-0 flex-1 items-center gap-2 ${active ? "" : "opacity-50 grayscale"}`}><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate font-medium">{agent.name}</span><span className="flex items-center gap-1 truncate text-xs text-muted-foreground">{active ? <><span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" /><span>{agent.activeCount} active</span><AnimatedEllipsis /></> : <span>Last seen {relativeTime(agent.lastSeenAt)}</span>}</span></span></span></SidebarMenuButton></SidebarMenuItem>;
}

export function AgentsLeaderboard(): ReactElement | null {
  const context = useOptionalCompanyContext();
  const onAuthenticationRequired = useCallback(() => window.location.assign("/auth"), []);
  const agents = useAgentStatus({
    ...(context?.currentCompany?.id ? { companyId: context.currentCompany.id } : {}),
    authenticated: Boolean(context?.user),
    loading: context?.loading ?? true,
    onAuthenticationRequired,
  });

  if (agents.length === 0) return null;
  return <SidebarGroup><SidebarGroupLabel>Agents</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{agents.map((agent, index) => <AgentRow key={agent.id} agent={agent} index={index} />)}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
