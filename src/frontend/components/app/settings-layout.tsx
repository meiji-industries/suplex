import { AlertTriangle, ArrowLeft, Building2, Cpu, HardDrive, KeyRound, Mail, MessageSquareText, Plug, ShieldCheck, UserRound, Users, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../ui/sidebar.js";
import { companySettingsPath, withCompany, type ApiUser } from "../../lib/api.js";
import { ApplicationFrame } from "./application-frame.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";
import { SystemHealthIndicator } from "./system-health.js";

type SettingsNavItem = { label: string; href: string; icon: LucideIcon };

type SettingsNavGroup = { title: string; items: SettingsNavItem[] };

function useSettingsGroups(companyId: string, user?: ApiUser): SettingsNavGroup[] {
  return useMemo<SettingsNavGroup[]>(() => {
    const companyItems: SettingsNavItem[] = [{ label: "Profile", href: withCompany("/profile", companyId), icon: UserRound }, ...(user?.role === "admin" && companyId ? [{ label: "Workspace", href: companySettingsPath(companyId), icon: Building2 }] : [])];
    return [
      ...(user && companyItems.length ? [{ title: "Company", items: companyItems }] : []),
      ...(user?.role === "admin" ? [{ title: "Administration", items: [
        { label: "Users", href: withCompany("/admin", companyId), icon: Users },
        { label: "Companies", href: withCompany("/admin/companies", companyId), icon: Building2 },
        { label: "Invitations", href: withCompany("/admin/invitations", companyId), icon: Mail },
        { label: "Passkeys", href: withCompany("/admin/passkeys", companyId), icon: KeyRound },
        { label: "Providers", href: withCompany("/admin/providers", companyId), icon: Plug },
        { label: "Agents", href: withCompany("/admin/agents", companyId), icon: Users },
        { label: "Models", href: withCompany("/admin/models", companyId), icon: Cpu },
        { label: "Prompts", href: withCompany("/admin/prompts", companyId), icon: MessageSquareText },
        { label: "Environment", href: withCompany("/admin/environment", companyId), icon: HardDrive },
      ]}] : []),
      { title: "System", items: [
        { label: "Host health", href: withCompany("/health", companyId), icon: ShieldCheck },
        { label: "Attention", href: withCompany("/attention", companyId), icon: AlertTriangle },
      ]},
    ];
  }, [companyId, user?.role]);
}


function SettingsSidebar({ companyId, backHref, activeHref }: { companyId: string; backHref: string; activeHref: string }): ReactElement {
  const context = useOptionalCompanyContext();
  const groups = useSettingsGroups(companyId, context?.user);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const { setOpenMobile } = useSidebar();
  const close = (): void => setOpenMobile(false);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return groups;
    return groups
      .map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLowerCase().includes(term)) }))
      .filter((group) => group.items.length > 0);
  }, [groups, search]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      const input = document.getElementById(searchId);
      if (!input || (input as HTMLElement).offsetParent === null) return;
      event.preventDefault();
      input.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [searchId]);
  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader>
        <div className="flex items-center gap-1"><div className="min-w-0 flex-1"><CompanySwitcher /></div><span className="md:hidden"><SidebarTrigger aria-label="Close navigation" title="Close navigation" /></span></div>
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton render={<a href={backHref} onClick={close}><ArrowLeft />Back to app</a>} tooltip="Back to app" /></SidebarMenuItem></SidebarMenu>
        <SidebarInput id={searchId} aria-label="Search settings" aria-keyshortcuts="/" placeholder="Search settings…" value={search} onChange={(event) => setSearch(event.target.value)} />
      </SidebarHeader>
      <SidebarContent>
        {filtered.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.href === activeHref;
                  return <SidebarMenuItem key={item.label}><SidebarMenuButton render={<a aria-current={active ? "page" : undefined} href={item.href} onClick={close}><Icon />{item.label}</a>} isActive={active} tooltip={item.label} /></SidebarMenuItem>;
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        {filtered.length === 0 ? <div className="px-2 py-4 text-[11px] text-muted-foreground">No settings found.</div> : null}
      </SidebarContent>
    </Sidebar>
  );
}

export function SettingsLayout({ title, companyId, backHref, activeHref, contentClassName = "", children }: { title: string; companyId: string; backHref: string; activeHref: string; contentClassName?: string; children: ReactNode }): ReactElement {
  return <ApplicationFrame title={title} sidebar={<SettingsSidebar companyId={companyId} backHref={backHref} activeHref={activeHref} />} headerRight={<SystemHealthIndicator />}><div className={`px-4 pb-8 lg:px-6 ${contentClassName}`}>{children}</div></ApplicationFrame>;
}
export function SettingsSection({ title, description, children }: { title?: string; description?: string; children: ReactNode }): ReactElement {
  return (
    <section className="mb-6">
      {title ? <h2 className="mb-1 text-sm font-semibold">{title}</h2> : null}
      {description ? <p className="mb-3 text-xs text-muted-foreground">{description}</p> : null}
      <div className="overflow-hidden rounded-md bg-card">{children}</div>
    </section>
  );
}

export function SettingRow({ label, description, children, destructive }: { label: string; description?: string; children: ReactNode; destructive?: boolean }): ReactElement {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className={destructive ? "text-[13px] font-medium text-rose-700" : "text-[13px] font-medium"}>{label}</div>
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
