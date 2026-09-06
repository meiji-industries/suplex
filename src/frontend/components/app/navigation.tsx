import { ChartNoAxesGantt, CirclePlus, Columns3, ClipboardList, EllipsisVertical, FolderGit2, Inbox, LogOut, Search, Settings, Shield, UserRound, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { BarChart3 } from "lucide-react";

import { buttonVariants } from "../ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { Input } from "../ui/input.js";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../ui/sidebar.js";
import { companySettingsPath, withCompany } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";
import { EntityAvatar } from "./entity-avatar.js";
import { RecentTasks } from "./recent-tasks.js";
import { SystemHealthIndicator } from "./system-health.js";
import { requestNewTask } from "./global-new-task-dialog.js";

type NavItem = { href: string; label: string; icon: LucideIcon };

function isActive(href: string): boolean {
  const current = window.location.pathname;
  const target = new URL(href, window.location.href).pathname;
  return current === target || (target !== "/" && current.startsWith(`${target}/`));
}

function MainNavigation({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  const items = useMemo<NavItem[]>(() => {
    return [
      { href: withCompany("/tasks", companyId), label: "Tasks", icon: ClipboardList },
      { href: withCompany("/board", companyId), label: "Board", icon: Columns3 },
      { href: withCompany("/timeline", companyId), label: "Timeline", icon: ChartNoAxesGantt },
      { href: withCompany("/analytics", companyId), label: "Analytics", icon: BarChart3 },
      { href: withCompany("/projects", companyId), label: "Projects", icon: FolderGit2 },
    ];
  }, [companyId]);
  return (
    <><CreateActions {...(close ? { close } : {})} /><SidebarGroup><SidebarGroupContent><SidebarMenu>{items.map(({ href, label, icon: Icon }) => { const active = isActive(href); return <SidebarMenuItem key={href}><SidebarMenuButton render={<a aria-current={active ? "page" : undefined} href={href} onClick={close}><Icon />{label}</a>} isActive={active} tooltip={label} /></SidebarMenuItem>; })}</SidebarMenu></SidebarGroupContent></SidebarGroup></>
  );
}

function CreateActions({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const company = context?.currentCompany;
  return (
    <div className="flex gap-2 p-2"><SidebarMenuButton className="min-w-8 flex-1 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground" disabled={company?.status !== "active"} onClick={() => { close?.(); requestNewTask(); }}><CirclePlus />New task</SidebarMenuButton><a className={buttonVariants({ variant: "outline", size: "icon-sm" })} href={withCompany("/attention", company?.id)} onClick={close} aria-label="Open attention" title="Open attention"><Inbox /></a></div>
  );
}

function NavigationSearch({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const companyId = context?.currentCompany?.id;
  const items: NavItem[] = [
    { href: withCompany("/timeline", companyId), label: "Timeline", icon: ChartNoAxesGantt },
    { href: withCompany("/analytics", companyId), label: "Analytics", icon: BarChart3 },
    { href: withCompany("/projects", companyId), label: "Projects", icon: FolderGit2 }, { href: withCompany("/tasks", companyId), label: "Tasks", icon: ClipboardList }, { href: withCompany("/board", companyId), label: "Board", icon: Columns3 }, { href: withCompany("/attention", companyId), label: "Attention", icon: Inbox }, { href: withCompany("/health", companyId), label: "Host health", icon: Shield },
  ];
  const visible = items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const openMenu = (): void => { setQuery(""); setOpen(true); };
    window.addEventListener("forge:command-menu", openMenu);
    return () => window.removeEventListener("forge:command-menu", openMenu);
  }, []);
  return <><SidebarMenuButton render={<button type="button" onClick={() => { setQuery(""); setOpen(true); }} title="Search Forge (⌘K)"><Search />Search</button>} /><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Command menu</DialogTitle></DialogHeader><Input autoFocus aria-label="Search Forge" placeholder="Search the views" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="space-y-1"><button type="button" className={buttonVariants({ variant: "ghost", className: "w-full justify-start" })} onClick={() => { setOpen(false); close?.(); requestNewTask(); }}><CirclePlus />New task <kbd className="ml-auto text-[11px] text-muted-foreground">C</kbd></button>{visible.map(({ href, label, icon: Icon }) => <a className={buttonVariants({ variant: "ghost", className: "w-full justify-start" })} href={href} onClick={() => { setOpen(false); close?.(); }} key={href}><Icon />{label}</a>)}</div><p className="text-[11px] text-muted-foreground">⌘K or / search. G then T or B navigates. C starts a new task.</p></DialogContent></Dialog></>;
}

function SecondaryNavigation({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  if (!context?.user) return <></>;
  const settingsHref = context.user.role === "admin" && companyId ? companySettingsPath(companyId) : withCompany("/profile", companyId);
  return <SidebarGroup className="mt-auto"><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SystemHealthIndicator sidebar /></SidebarMenuItem><SidebarMenuItem><SidebarMenuButton render={<a href={settingsHref} onClick={close}><Settings />Settings</a>} isActive={isActive(settingsHref)} /></SidebarMenuItem><SidebarMenuItem><NavigationSearch {...(close ? { close } : {})} /></SidebarMenuItem></SidebarMenu></SidebarGroupContent></SidebarGroup>;
}

function UserMenu(): ReactElement | null {
  const context = useOptionalCompanyContext();
  const { isMobile } = useSidebar();
  const user = context?.user;
  if (!user) return null;
  return <SidebarMenu><SidebarMenuItem><DropdownMenu><DropdownMenuTrigger render={<SidebarMenuButton size="lg"><EntityAvatar kind="user" id={user.id} name={user.displayName} seed={user.avatarSeed} /><span className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate font-medium">{user.displayName}</span><span className="truncate text-xs text-muted-foreground">{user.username}</span></span><EllipsisVertical className="ml-auto" /></SidebarMenuButton>} /><DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}><DropdownMenuItem render={<a href={withCompany("/profile", context.currentCompany?.id)} />}><UserRound />Profile</DropdownMenuItem><DropdownMenuItem onClick={() => void signOut()}><LogOut />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu></SidebarMenuItem></SidebarMenu>;
}

async function signOut(): Promise<void> { try { await fetch("/api/auth/sign-out", { method: "POST" }); } finally { window.localStorage.removeItem("forge.activeCompanyId"); window.location.assign("/auth"); } }

/** The host this page was loaded from, so a desktop window shows which Forge it is on. */
export function instanceHost(): string {
  return typeof location === "undefined" ? "" : location.host;
}

export function AppSidebar(): ReactElement {
  const context = useOptionalCompanyContext();
  const { setOpenMobile } = useSidebar();
  const close = (): void => setOpenMobile(false);
  useEffect(() => {
    let goPending = false;
    let goTimer: number | undefined;
    const handleShortcut = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.matches("input, textarea, select, button, [contenteditable=true]")) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "k" || !event.metaKey && !event.ctrlKey && key === "/") {
        event.preventDefault(); window.dispatchEvent(new Event("forge:command-menu")); return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "c" && context?.currentCompany?.status === "active") {
        event.preventDefault(); requestNewTask(); return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "g") {
        goPending = true; window.clearTimeout(goTimer); goTimer = window.setTimeout(() => { goPending = false; }, 750); return;
      }
      if (goPending && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const path = key === "t" ? "/tasks" : key === "b" ? "/board" : key === "l" ? "/timeline" : undefined;
        goPending = false; window.clearTimeout(goTimer);
        if (path) { event.preventDefault(); navigate(withCompany(path, context?.currentCompany?.id)); }
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => { window.removeEventListener("keydown", handleShortcut); window.clearTimeout(goTimer); };
  }, [context?.currentCompany?.id, context?.currentCompany?.status]);
  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader><div className="flex items-center gap-1"><div className="min-w-0 flex-1"><CompanySwitcher /></div><span className="md:hidden"><SidebarTrigger aria-label="Close navigation" title="Close navigation" /></span></div><div className="truncate px-2 text-[11px] text-muted-foreground" data-testid="instance-host">{instanceHost()}</div></SidebarHeader>
      <SidebarContent><MainNavigation close={close} /><RecentTasks close={close} /><SecondaryNavigation close={close} /></SidebarContent>
      <SidebarFooter><UserMenu /></SidebarFooter>
    </Sidebar>
  );
}
