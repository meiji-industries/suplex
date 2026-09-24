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
        {filtered.length === 0 ? <div className="px-2 py-4 text-xs text-muted-foreground">No settings found.</div> : null}
      </SidebarContent>
    </Sidebar>
  );
}

export function SettingsLayout({ title, companyId, backHref, activeHref, contentClassName = "", children }: { title: string; companyId: string; backHref: string; activeHref: string; contentClassName?: string; children: ReactNode }): ReactElement {
  return <ApplicationFrame title={title} sidebar={<SettingsSidebar companyId={companyId} backHref={backHref} activeHref={activeHref} />} headerRight={<SystemHealthIndicator />}><div className={`px-4 pb-8 lg:px-6 ${contentClassName}`}>{children}</div></ApplicationFrame>;
}

type SettingsHeaderProps = { title: string; description?: ReactNode; actions?: ReactNode };

/** Settings headers put their actions on a row below the title and caption. */
function HeaderActions({ actions }: { actions?: ReactNode }): ReactElement | null {
  return actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null;
}

function SettingsHeader({ title, description, actions }: SettingsHeaderProps): ReactElement {
  return (
    <div className="mb-6 space-y-4">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <HeaderActions actions={actions} />
    </div>
  );
}

/** Page body with the title and caption. Use "narrow" for setting rows and "wide" for tables. */
export function SettingsContent({ title, description, actions, width = "narrow", children }: Partial<SettingsHeaderProps> & { width?: "narrow" | "wide"; children: ReactNode }): ReactElement {
  const wide = width === "wide";
  return (
    <div className={wide ? "mx-auto w-full min-w-0 max-w-5xl pt-8 lg:pt-12" : "mx-auto w-full max-w-2xl pt-8 lg:pt-12"}>
      {title ? <div className="px-4"><SettingsHeader title={title} description={description} actions={actions} /></div> : null}
      {children}
    </div>
  );
}

/** Secondary title for a group of rows or a table. Table sections render it directly, without the row card. It is indented to line up with row text. */
export function SettingsSectionHeader({ title, description, actions }: { title?: string | undefined; description?: string | undefined; actions?: ReactNode }): ReactElement | null {
  if (!title && !description && !actions) return null;
  return (
    <div className="mb-3 space-y-3 px-4">
      {title || description ? <div className="space-y-1">
        {title ? <h3 className="text-base font-medium">{title}</h3> : null}
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div> : null}
      <HeaderActions actions={actions} />
    </div>
  );
}

export function SettingsSection({ title, description, actions, children }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="mb-10">
      <SettingsSectionHeader title={title} description={description} actions={actions} />
      <div className="overflow-hidden rounded-lg border bg-card px-4">{children}</div>
    </section>
  );
}

export function SettingRow({ label, description, children, destructive, htmlFor }: { label: string; description?: ReactNode; children?: ReactNode; destructive?: boolean; htmlFor?: string }): ReactElement {
  const labelClassName = destructive ? "text-sm font-medium text-destructive" : "text-sm font-medium";
  return (
    <div className="flex min-h-15 flex-col gap-2 border-t py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        {htmlFor ? <label className={labelClassName} htmlFor={htmlFor}>{label}</label> : <div className={labelClassName}>{label}</div>}
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}
