import { AlertTriangle, ArrowLeft, Building2, Cpu, KeyRound, Mail, Menu, Search, ShieldCheck, Terminal, UserRound, Users, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { SidebarProvider } from "../ui/sidebar.js";
import { companySettingsPath, withCompany, type ApiUser } from "../../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";
import { SystemHealthAlert, SystemHealthIndicator } from "./system-health.js";

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
        { label: "Profiles", href: withCompany("/admin/profiles", companyId), icon: Terminal },
        { label: "Agents", href: withCompany("/admin/agents", companyId), icon: Users },
        { label: "Models", href: withCompany("/admin/models", companyId), icon: Cpu },
      ]}] : []),
      { title: "System", items: [
        { label: "Host health", href: withCompany("/health", companyId), icon: ShieldCheck },
        { label: "Attention", href: withCompany("/attention", companyId), icon: AlertTriangle },
      ]},
    ];
  }, [companyId, user?.role]);
}

function SettingsNavItem({ item, active }: { item: SettingsNavItem; active: boolean }): ReactElement {
  const className = active
    ? "flex h-7 items-center gap-2 rounded-md bg-sidebar-accent px-2 text-[13px] font-medium text-sidebar-foreground"
    : "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground";
  const iconClass = active ? "size-3.5 text-primary" : "size-3.5";
  const Icon = item.icon;
  return <a aria-current={active ? "page" : undefined} className={className} href={item.href}><Icon className={iconClass} />{item.label}</a>;
}

function SettingsNavContent({ groups, activeHref, search, setSearch, backHref }: { groups: SettingsNavGroup[]; activeHref: string; search: string; setSearch: (value: string) => void; backHref: string }): ReactElement {
  const searchId = useId();
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
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center justify-between px-3">
        <a className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground" href={backHref}>
          <ArrowLeft className="size-3.5" />Back to app
        </a>
        <Button variant="ghost" size="icon-sm" aria-label="Focus settings search" title="Focus settings search" onClick={() => document.getElementById(searchId)?.focus()}><Search className="size-4" /></Button>
      </div>
      <div className="relative px-3 pb-3">
        <Search aria-hidden="true" className="pointer-events-none absolute left-5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input id={searchId} aria-label="Search settings" aria-keyshortcuts="/" className="h-8 pl-8 pr-8" placeholder="Search settings…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <kbd className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 rounded border border-sidebar-border bg-sidebar-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">/</kbd>
      </div>
      <ScrollArea className="flex-1 space-y-5 px-3 pb-4">
        <div className="space-y-5">
        {filtered.map((group) => (
          <section key={group.title}>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</div>
            <nav className="space-y-0.5">
              {group.items.map((item) => <SettingsNavItem key={item.label} item={item} active={item.href === activeHref} />)}
            </nav>
          </section>
        ))}
        {filtered.length === 0 ? <div className="px-2 py-4 text-[11px] text-muted-foreground">No settings found.</div> : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function SettingsMobileNavigation({ title, groups, activeHref, backHref }: { title: string; groups: SettingsNavGroup[]; activeHref: string; backHref: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open settings navigation" title="Open settings navigation"><Menu className="size-4" /></Button>} />
      <SheetContent data-slot="settings-mobile-nav" side="left" className="w-64 bg-sidebar px-0 py-0" showCloseButton closeLabel="Close settings navigation">
        <SheetHeader className="h-12 px-3">
          <SheetTitle className="text-[13px]">{title}</SheetTitle>
        </SheetHeader>
        <div className="h-[calc(100%-3rem)]">
          <SettingsNavContent groups={groups} activeHref={activeHref} search={search} setSearch={setSearch} backHref={backHref} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function SettingsLayout({ title, companyId, backHref, activeHref, contentClassName = "", children }: { title: string; companyId: string; backHref: string; activeHref: string; contentClassName?: string; children: ReactNode }): ReactElement {
  const context = useOptionalCompanyContext();
  const groups = useSettingsGroups(companyId, context?.user);
  const [search, setSearch] = useState("");
  return (
    <SidebarProvider>
      <div className="min-h-screen w-full bg-sidebar text-foreground">
      <div className="flex min-h-screen">
        <aside className="hidden w-[244px] shrink-0 flex-col bg-sidebar lg:flex">
          <div className="min-h-0 flex-1"><SettingsNavContent groups={groups} activeHref={activeHref} search={search} setSearch={setSearch} backHref={backHref} /></div>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden bg-[lch(97.94%_0.5_282)] lg:m-2 lg:ml-0 lg:rounded-xl lg:border-[0.5px] lg:border-[lch(89.84%_0_282)] lg:shadow-[0_3px_6px_-2px_rgb(0_0_0_/_0.02),0_1px_1px_rgb(0_0_0_/_0.04)]">
          <header className="flex h-16 items-center gap-3 px-4 lg:px-14">
            <div className="lg:hidden"><SettingsMobileNavigation title={title} groups={groups} activeHref={activeHref} backHref={backHref} /></div>
            <div className="ml-auto flex min-w-0 items-center gap-1 lg:hidden"><div className="w-52 max-w-[45vw]"><CompanySwitcher /></div><SystemHealthIndicator /></div>
          </header>
          <SystemHealthAlert />
          <div className="px-4 pb-8 lg:px-14">
            <h1 className="min-w-0 truncate text-2xl font-medium leading-8">{title}</h1>
            <div className={`mt-3 ${contentClassName}`}>{children}</div>
          </div>
        </main>
      </div>
      </div>
    </SidebarProvider>
  );
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
