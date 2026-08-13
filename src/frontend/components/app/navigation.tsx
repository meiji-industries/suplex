import { ChartNoAxesGantt, Columns3, ClipboardList, FolderGit2, Settings, SquarePen, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../ui/sidebar.js";
import { companySettingsPath, withCompany } from "../../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { title: string; items: NavItem[] };

function isActive(href: string): boolean {
  const current = window.location.pathname;
  const target = new URL(href, window.location.href).pathname;
  return current === target || (target !== "/" && current.startsWith(`${target}/`));
}

function NavigationGroups({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  const groups = useMemo<NavGroup[]>(() => {
    return [
      { title: "Work", items: [
        { href: withCompany("/projects", companyId), label: "Projects", icon: FolderGit2 },
        { href: withCompany("/tasks", companyId), label: "Tasks", icon: ClipboardList },
        { href: withCompany("/board", companyId), label: "Board", icon: Columns3 },
        { href: withCompany("/timeline", companyId), label: "Timeline", icon: ChartNoAxesGantt },
      ]},
    ];
  }, [companyId]);
  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = isActive(href);
                return (
                  <SidebarMenuItem key={href}>
                    <SidebarMenuButton render={<a aria-current={active ? "page" : undefined} href={href} onClick={close}><Icon />{label}</a>} isActive={active} />
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function SettingsLink({ close }: { close?: () => void }): ReactElement | null {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  if (!context?.user) return null;
  const href = context.user.role === "admin" && companyId ? companySettingsPath(companyId) : withCompany("/health", companyId);
  return <SidebarMenuButton render={<a href={href} onClick={close}><Settings />Settings</a>} isActive={isActive(href)} />;
}

function requestNewTask(companyId?: string): void {
  if (window.location.pathname === "/tasks") {
    window.dispatchEvent(new Event("forge:new-task"));
    return;
  }
  window.location.assign(withCompany("/tasks?new=1", companyId));
}

function NewTaskButton({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const company = context?.currentCompany;
  return (
    <Button variant="outline" size="icon-sm" aria-label="New task" title="New task (⌘N)" disabled={company?.status !== "active"} onClick={() => { close?.(); requestNewTask(company?.id); }}>
      <SquarePen />
    </Button>
  );
}

export function AppSidebar(): ReactElement {
  const context = useOptionalCompanyContext();
  const { setOpenMobile } = useSidebar();
  const close = (): void => setOpenMobile(false);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || event.key.toLowerCase() !== "n" || context?.currentCompany?.status !== "active") return;
      event.preventDefault();
      requestNewTask(context.currentCompany.id);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [context?.currentCompany?.id, context?.currentCompany?.status]);
  return (
    <Sidebar>
      <SidebarHeader><div className="flex items-center gap-1"><div className="min-w-0 flex-1"><CompanySwitcher /></div><NewTaskButton close={close} /><span className="md:hidden"><SidebarTrigger aria-label="Close navigation" title="Close navigation" /></span></div></SidebarHeader>
      <SidebarContent><NavigationGroups close={close} /></SidebarContent>
      <SidebarFooter><SidebarMenu><SidebarMenuItem><SettingsLink close={close} /></SidebarMenuItem></SidebarMenu></SidebarFooter>
    </Sidebar>
  );
}
