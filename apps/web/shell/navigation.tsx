import { CalendarDays, ChartNoAxesGantt, Columns3, ClipboardList, EllipsisVertical, LogOut, Plus, Settings, Shield, UserRound, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { BarChart3 } from "lucide-react"; import { cn } from "../lib/utils.js"; import { PhosphorTerminalIcon, toggleQuickShell } from "./quick-shell.js";

import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button, buttonVariants } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Input } from "../components/ui/input.js";
import { NewButton } from "../components/ui/new-button.js";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../components/ui/sidebar.js";
import { companySettingsPath, withCompany } from "../lib/api.js";
import { useIsMobile } from "../lib/hooks/use-mobile.js";
import { navigate } from "./navigation-state.js";
import { useExperiments } from "./experiments-api.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";
import { EntityAvatar } from "../components/app/entity-avatar.js";
import { RecentTasks } from "../features/tasks/recent-tasks.js";
import { SystemHealthIndicator } from "../components/app/system-health.js";
import { requestNewTask, useHasProjects } from "./global-new-task-dialog.js";
import { inFieldOrDialog, opensCommandMenu, opensSettings, settingsShortcutLabel } from "./shortcuts.js";
import { useSignOut } from "./server-state.js";
import wordmark from "../assets/suplex-wordmark.svg?inline";

type NavItem = { href: string; label: string; icon: LucideIcon; shortcut?: string };

/** Company settings for admins, the profile otherwise. The sidebar icon, the command menu, and ⌘, all open it. */
function useSettingsHref(): string {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  return context?.user?.role === "admin" && companyId ? companySettingsPath(companyId) : withCompany("/profile", companyId);
}

function isActive(href: string): boolean {
  const current = window.location.pathname;
  const target = new URL(href, window.location.href).pathname;
  return current === target || (target !== "/" && current.startsWith(`${target}/`));
}

function MainNavigation({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  const todayPage = useExperiments()?.todayPage ?? false;
  const items = useMemo<NavItem[]>(() => {
    return [
      ...(todayPage ? [{ href: "/today", label: "Today", icon: CalendarDays }] : []),
      { href: withCompany("/tasks", companyId), label: "Tasks", icon: ClipboardList },
      { href: withCompany("/moves", companyId), label: "Moves", icon: Zap },
      { href: withCompany("/board", companyId), label: "Board", icon: Columns3 },
      { href: withCompany("/timeline", companyId), label: "Timeline", icon: ChartNoAxesGantt },
      { href: withCompany("/analytics", companyId), label: "Analytics", icon: BarChart3 },
    ];
  }, [companyId, todayPage]);
  return (
    <><CreateActions {...(close ? { close } : {})} /><SidebarGroup><SidebarGroupContent><SidebarMenu>{items.map(({ href, label, icon: Icon }) => { const active = isActive(href); return <SidebarMenuItem key={href}><SidebarMenuButton render={<a className="font-normal leading-none" aria-current={active ? "page" : undefined} href={href} onClick={close}><Icon className="w-[19px] h-[19px] [stroke-width:1.2632]" />{label}</a>} isActive={active} tooltip={label} /></SidebarMenuItem>; })}</SidebarMenu></SidebarGroupContent></SidebarGroup></>
  );
}

function CreateActions({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const company = context?.currentCompany;
  const hasProjects = useHasProjects(company?.id);
  const mobile = useIsMobile();
  return (
    <div className="flex gap-2 p-2"><NewButton className="flex-1" disabled={company?.status !== "active"} onClick={() => { close?.(); requestNewTask(); }}>{hasProjects === false ? "Add project" : "New task"}</NewButton>{context?.user?.role === "admin" && !mobile ? <Button variant="outline" size="icon-sm" aria-label="Quick shell" title="Quick shell (Ctrl+`)" onClick={() => { close?.(); toggleQuickShell(); }}><PhosphorTerminalIcon /></Button> : null}</div>
  );
}

function NavigationSearch({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const companyId = context?.currentCompany?.id;
  const hasProjects = useHasProjects(companyId);
  const todayPage = useExperiments()?.todayPage ?? false;
  const settingsHref = useSettingsHref();
  const settingsShortcut = settingsShortcutLabel();
  const items: NavItem[] = [
    ...(todayPage ? [{ href: "/today", label: "Today", icon: CalendarDays }] : []),
    { href: withCompany("/timeline", companyId), label: "Timeline", icon: ChartNoAxesGantt },
    { href: withCompany("/analytics", companyId), label: "Analytics", icon: BarChart3 },
    { href: withCompany("/tasks", companyId), label: "Tasks", icon: ClipboardList }, { href: withCompany("/board", companyId), label: "Board", icon: Columns3 }, { href: withCompany("/moves", companyId), label: "Moves", icon: Zap }, { href: withCompany("/health", companyId), label: "Host health", icon: Shield },
    ...(context?.user ? [{ href: settingsHref, label: "Settings", icon: Settings, shortcut: settingsShortcut }] : []),
  ];
  const visible = items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const openMenu = (): void => { setQuery(""); setOpen(true); };
    window.addEventListener("suplex:command-menu", openMenu);
    return () => window.removeEventListener("suplex:command-menu", openMenu);
  }, []);
  return <><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Command menu</DialogTitle></DialogHeader><Input autoFocus aria-label="Search Suplex" placeholder="Search the views" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="space-y-1 -ml-[11px] -mr-[11px]"><button type="button" className={cn(buttonVariants({ variant: "ghost", className: "w-full justify-start focus-visible:border-foreground/25 focus-visible:ring-0 text-sm gap-x-[12px]" }))} onClick={() => { setOpen(false); close?.(); requestNewTask(); }}><Plus />{hasProjects === false ? "Add project" : "New task"} <kbd className="ml-auto text-xs text-muted-foreground">C</kbd></button>{visible.map(({ href, label, icon: Icon, shortcut }) => <a className={cn(buttonVariants({ variant: "ghost", className: "w-full justify-start focus-visible:border-foreground/25 focus-visible:ring-0 text-sm gap-x-[12px]" }))} href={href} onClick={() => { setOpen(false); close?.(); }} key={href}><Icon />{label}{shortcut ? <kbd className="ml-auto text-xs text-muted-foreground">{shortcut}</kbd> : null}</a>)}</div><p className="text-xs text-muted-foreground">⌘K or / search. G then H, T, B, or M navigates. C starts a new task.{context?.user ? ` ${settingsShortcut} opens Settings.` : ""}</p></DialogContent></Dialog></>;
}

function SecondaryNavigation(): ReactElement {
  const context = useOptionalCompanyContext();
  if (!context?.user) return <></>;
  return <SidebarGroup className="mt-auto"><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SystemHealthIndicator sidebar /></SidebarMenuItem></SidebarMenu></SidebarGroupContent></SidebarGroup>;
}

function UserMenu(): ReactElement | null {
  const context = useOptionalCompanyContext();
  const accountLogout = Boolean(window.suplexApp) && context?.user?.role === "admin";
  const signOut = useSignOut(accountLogout ? "account" : "session");
  const [logoutError, setLogoutError] = useState("");
  const logout = async (): Promise<void> => {
    setLogoutError("");
    try { await signOut(); }
    catch { setLogoutError("Suplex could not log out. Retry."); }
  };
  const { isMobile } = useSidebar();
  const user = context?.user;
  if (!user) return null;
  return <SidebarMenu><SidebarMenuItem><DropdownMenu><DropdownMenuTrigger render={<SidebarMenuButton size="lg"><EntityAvatar kind="user" id={user.id} name={user.displayName} seed={user.avatarSeed} /><span className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate font-medium">{user.displayName}</span><span className="truncate text-xs text-muted-foreground">{user.username}</span></span><EllipsisVertical className="ml-auto" /></SidebarMenuButton>} /><DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}><DropdownMenuItem render={<a href={withCompany("/profile", context.currentCompany?.id)} />}><UserRound />Profile</DropdownMenuItem><DropdownMenuItem onClick={() => void logout()}><LogOut />{accountLogout ? "Log out" : "Sign out"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>{logoutError ? <Alert variant="destructive"><AlertDescription>{logoutError}</AlertDescription></Alert> : null}</SidebarMenuItem></SidebarMenu>;
}

export function AppSidebar(): ReactElement {
  const context = useOptionalCompanyContext();
  const settingsHref = useSettingsHref();
  const { setOpenMobile } = useSidebar();
  const close = (): void => setOpenMobile(false);
  const todayPage = useExperiments()?.todayPage ?? false;
  useEffect(() => {
    let goPending = false;
    let goTimer: number | undefined;
    const handleShortcut = (event: KeyboardEvent): void => {
      if (opensSettings(event)) {
        if (!inFieldOrDialog(event.target)) { event.preventDefault(); navigate(settingsHref); }
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.matches("input, textarea, select, button, [contenteditable=true]")) return;
      const key = event.key.toLowerCase();
      if (opensCommandMenu(event)) {
        event.preventDefault(); window.dispatchEvent(new Event("suplex:command-menu")); return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "c" && context?.currentCompany?.status === "active") {
        event.preventDefault(); requestNewTask(); return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "g") {
        goPending = true; window.clearTimeout(goTimer); goTimer = window.setTimeout(() => { goPending = false; }, 750); return;
      }
      if (goPending && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const path = key === "h" ? (todayPage ? "/today" : "/tasks") : key === "t" ? "/tasks" : key === "b" ? "/board" : key === "m" ? "/moves" : key === "l" ? "/timeline" : undefined;
        goPending = false; window.clearTimeout(goTimer);
        if (path) { event.preventDefault(); navigate(path === "/today" ? path : withCompany(path, context?.currentCompany?.id)); }
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => { window.removeEventListener("keydown", handleShortcut); window.clearTimeout(goTimer); };
  }, [context?.currentCompany?.id, context?.currentCompany?.status, settingsHref, todayPage]);
  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader data-tauri-drag-region="deep" className="titlebar-top"><div className="flex h-8 items-center gap-1 pl-2 -mr-2"><img src={wordmark} alt="Suplex" className="w-auto invert dark:invert-0 h-5" />{context?.user ? <span className="ml-auto flex"><Button variant="ghost" size="icon-sm" nativeButton={false} render={<a href={settingsHref} onClick={close} aria-label="Settings" title="Settings" />}><Settings /></Button></span> : null}<span className="md:hidden"><SidebarTrigger aria-label="Close navigation" title="Close navigation" /></span></div><CompanySwitcher /></SidebarHeader>
      <SidebarContent><MainNavigation close={close} /><RecentTasks close={close} /><SecondaryNavigation /></SidebarContent>
      <NavigationSearch close={close} />
      <SidebarFooter><UserMenu /></SidebarFooter>
    </Sidebar>
  );
}
