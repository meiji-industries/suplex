import { ArrowLeft } from "lucide-react";
import { useContext, useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../../components/ui/sidebar.js";
import type { ApiUser } from "../../lib/api.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { CompanySwitcher } from "../../shell/company-switcher.js";
import { SystemHealthIndicator } from "../../components/app/system-health.js";
import { buildSettingsGroups, type SettingsNavGroup } from "./settings-nav.js"; import { SettingsHeaderSlotContext } from "../../components/app/settings-table.js";

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
        <div className="flex items-center gap-1"><div className="min-w-0 flex-1"><SidebarMenu><SidebarMenuItem><SidebarMenuButton className="text-sm leading-none" render={<a href={backHref} onClick={close}><ArrowLeft />Back to app</a>} tooltip="Back to app" /></SidebarMenuItem></SidebarMenu></div><span className="md:hidden"><SidebarTrigger aria-label="Close navigation" title="Close navigation" /></span></div>
        <CompanySwitcher />
        <SidebarInput id={searchId} aria-label="Search settings" aria-keyshortcuts="/" placeholder="Search the settings" value={search} onChange={(event) => setSearch(event.target.value)} />
      </SidebarHeader>
      <SidebarContent>
        {filtered.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel className="tracking-widest">{group.title}</SidebarGroupLabel>
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
  // The top bar always names the area; each page shows its own title in the body.
  return <ApplicationFrame title="Settings" documentTitle={title} sidebar={<SettingsSidebar companyId={companyId} backHref={backHref} activeHref={activeHref} />} headerRight={<SystemHealthIndicator />}><div className={`px-4 pb-8 lg:px-6 ${contentClassName}`}>{children}</div></ApplicationFrame>;
}

type SettingsHeaderProps = { title: string; description?: ReactNode; actions?: ReactNode };

/** Section actions sit on their own row below the section title. */
function HeaderActions({ actions }: { actions?: ReactNode }): ReactElement | null {
  return actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null;
}

export function SettingsHeader({ title, description, actions }: SettingsHeaderProps): ReactElement {
  const { setSlot } = useContext(SettingsHeaderSlotContext); return (
    <div data-settings-header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-12">
      <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-[36rem]">
        <h2 className="font-semibold text-[24px] leading-[32px]">{title}</h2>
        {description ? <p className="text-balance text-muted-foreground text-base leading-[24px]">{description}</p> : null}
      </div>
      {/* Two columns: the text wraps on the left, and the buttons sit on the right, bottom-aligned with the text. A toolbar can send its buttons here. */}<div ref={setSlot} className="flex shrink-0 flex-wrap items-center justify-end gap-2 empty:hidden">{actions}</div>
    </div>
  );
}

/** Page body with the title and caption. Every settings page uses the same column width; "width" is kept for existing callers. */
export function SettingsContent({ title, description, actions, children }: Partial<SettingsHeaderProps> & { width?: "narrow" | "wide"; children: ReactNode }): ReactElement {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const headerSlot = useMemo(() => ({ slot, setSlot }), [slot]);
  return (
    <SettingsHeaderSlotContext.Provider value={headerSlot}>
      <div className={`${settingsColumnClassName} pt-8 lg:pt-12`}>
        {title ? <SettingsHeader title={title} description={description} actions={actions} /> : null}
        {children}
      </div>
    </SettingsHeaderSlotContext.Provider>
  );
}

/** Secondary title for a group of rows or a table. Table sections render it directly, without the row card. */
export function SettingsSectionHeader({ title, description, actions }: { title?: string | undefined; description?: string | undefined; actions?: ReactNode }): ReactElement | null {
  if (!title && !description && !actions) return null;
  return (
    <div className="mb-6.25 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-12">
      {/* Text on the left and buttons on the right, bottom-aligned; both line up with the outer edges of the box. */}
      {title || description ? <div className="min-w-0 flex-1 space-y-1">
        {title ? <h3 className="text-base font-medium">{title}</h3> : null}
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div> : null}
      {actions ? <div className="shrink-0 sm:ml-auto"><HeaderActions actions={actions} /></div> : null}
    </div>
  );
}

/** Box padding matches the New task dialog: 20px on every side, including under content that is not a row. */
export function SettingsSection({ title, description, actions, children }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="mb-10">
      <SettingsSectionHeader title={title} description={description} actions={actions} />
      <div className="overflow-hidden rounded-lg border bg-card px-5 py-2 [&>:last-child:not([data-setting-row])]:pb-3">{children}</div>
    </section>
  );
}

export function SettingRow({ label, description, children, destructive, htmlFor }: { label: string; description?: ReactNode; children?: ReactNode; destructive?: boolean; htmlFor?: string }): ReactElement {
  const labelClassName = destructive ? "text-sm font-medium text-destructive" : "text-sm font-medium";
  return (
    <div data-setting-row className="flex min-h-15 flex-col gap-2 border-t py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        {htmlFor ? <label className={labelClassName} htmlFor={htmlFor}>{label}</label> : <div className={labelClassName}>{label}</div>}
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}

/** The one column width for settings pages: halfway between the old narrow (42rem) and wide (64rem) columns. */
export const settingsColumnClassName = "mx-auto w-full min-w-0 max-w-[53rem]";
