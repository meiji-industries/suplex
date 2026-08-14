import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";

import { readJson } from "../../lib/api.js";
import { relativeTime, type ApiAgent } from "../../lib/view-shared.js";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { ProfileAvatar } from "./profile-avatar.js";

function AnimatedEllipsis(): ReactElement {
  return <span aria-hidden="true"><span className="motion-safe:animate-pulse [animation-duration:900ms]">.</span><span className="motion-safe:animate-pulse [animation-delay:150ms] [animation-duration:900ms]">.</span><span className="motion-safe:animate-pulse [animation-delay:300ms] [animation-duration:900ms]">.</span></span>;
}

function AgentRow({ agent }: { agent: ApiAgent }): ReactElement {
  const row = useRef<HTMLDivElement>(null);
  const previousTop = useRef<number>(undefined);
  const active = agent.activeCount > 0;
  useLayoutEffect(() => {
    const nextTop = row.current?.getBoundingClientRect().top;
    const offset = nextTop === undefined || previousTop.current === undefined ? 0 : previousTop.current - nextTop;
    previousTop.current = nextTop;
    if (offset && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) row.current?.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], { duration: 160, easing: "ease-out" });
  });
  return <SidebarMenuItem><SidebarMenuButton render={<div ref={row} data-agent-row={agent.id} />} size="lg"><span className={`flex min-w-0 flex-1 items-center gap-2 ${active ? "" : "opacity-50 grayscale"}`}><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate font-medium">{agent.name}</span><span className="flex items-center gap-1 truncate text-xs text-muted-foreground">{active ? <><span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" /><span>{agent.activeCount} active</span><AnimatedEllipsis /></> : <span>Last seen {relativeTime(agent.lastSeenAt)}</span>}</span></span></span></SidebarMenuButton></SidebarMenuItem>;
}

export function AgentsLeaderboard(): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setAgents((await readJson<{ agents: ApiAgent[] }>(companyId ? `/api/agents?companyId=${encodeURIComponent(companyId)}` : "/api/agents")).agents);
    } catch {
      setAgents([]);
    }
  }, [companyId]);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 5_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (agents.length === 0) return null;
  return <SidebarGroup><SidebarGroupLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agents</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}
