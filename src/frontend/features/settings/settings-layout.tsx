import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../../components/ui/sidebar.js";
import type { ApiUser } from "../../lib/api.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { CompanySwitcher } from "../../shell/company-switcher.js";
import { SystemHealthIndicator } from "../../components/app/system-health.js";
import { buildSettingsGroups, type SettingsNavGroup } from "./settings-nav.js";

function useSettingsGroups(companyId: string, user?: ApiUser): SettingsNavGroup[] {
  return useMemo<SettingsNavGroup[]>(() => buildSettingsGroups(companyId, user), [companyId, user?.role]);
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
      <SidebarHeader className="titlebar-drag titlebar-top">
        <div className="flex items-center gap-1"><div className="min-w-0 flex-1"><CompanySwitcher /></div><span className="md:hidden"><SidebarTrigger aria-label="Close navigation" title="Close navigation" /></span></div>
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton render={<a href={backHref} onClick={close}><ArrowLeft />Back to app</a>} tooltip="Back to app" /></SidebarMenuItem></SidebarMenu>
        <SidebarInput id={searchId} aria-label="Search settings" aria-keyshortcuts="/" placeholder="Search the settings" value={search} onChange={(event) => setSearch(event.target.value)} />
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

export function SettingsContent({ children }: { children: ReactNode }): ReactElement {
  return <div className="mt-5 max-w-3xl">{children}</div>;
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

export function SettingRow({ label, description, children, destructive, htmlFor }: { label: string; description?: string; children: ReactNode; destructive?: boolean; htmlFor?: string }): ReactElement {
  const labelClassName = destructive ? "text-[13px] font-medium text-destructive" : "text-[13px] font-medium";
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        {htmlFor ? <label className={labelClassName} htmlFor={htmlFor}>{label}</label> : <div className={labelClassName}>{label}</div>}
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
