import { ArrowLeft, Bell, Building2, CreditCard, Key, Menu, Palette, Settings2, Shield, Terminal, Users, X, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";

import { Button } from "../ui/button.js";
import { Dialog } from "../ui/dialog.js";
import { Field, FieldLabel } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { companySettingsPath, withCompany, type ApiUser } from "../../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";

type SettingsNavItem = { label: string; href?: string; icon: LucideIcon };

type SettingsNavGroup = { title: string; items: SettingsNavItem[] };

function useSettingsGroups(companyId: string, user?: ApiUser): SettingsNavGroup[] {
  return useMemo<SettingsNavGroup[]>(() => {
    const companyItems: SettingsNavItem[] = companyId ? [{ label: "Workspace", href: companySettingsPath(companyId), icon: Building2 }] : [];
    return [
      { title: "General", items: [
        { label: "General", icon: Settings2 },
        { label: "Notifications", icon: Bell },
        { label: "Appearance", icon: Palette },
      ]},
      { title: "Company", items: companyItems.concat([
        { label: "Members", icon: Users },
        { label: "Billing", icon: CreditCard },
      ])},
      ...(user?.role === "admin" ? [{ title: "Administration", items: [
        { label: "Users", href: withCompany("/admin", companyId), icon: Users },
        { label: "Profiles", href: withCompany("/admin/profiles", companyId), icon: Terminal },
        { label: "Security", icon: Shield },
        { label: "API", icon: Key },
      ]}] : []),
    ];
  }, [companyId, user?.role]);
}

function SettingsNavItem({ item, active }: { item: SettingsNavItem; active: boolean }): ReactElement {
  const className = active
    ? "flex h-7 items-center gap-2 rounded-md bg-sidebar-accent px-2 text-[13px] font-medium text-sidebar-foreground"
    : "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground";
  const iconClass = active ? "size-3.5 text-primary" : "size-3.5";
  const Icon = item.icon;
  if (!item.href) {
    return <div className={`${className} cursor-not-allowed opacity-50`}><Icon className={iconClass} />{item.label}</div>;
  }
  return <a aria-current={active ? "page" : undefined} className={className} href={item.href}><Icon className={iconClass} />{item.label}</a>;
}

function SettingsNavContent({ groups, activeHref, search, setSearch, backHref }: { groups: SettingsNavGroup[]; activeHref: string; search: string; setSearch: (value: string) => void; backHref: string }): ReactElement {
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return groups;
    return groups
      .map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLowerCase().includes(term)) }))
      .filter((group) => group.items.length > 0);
  }, [groups, search]);
  return (
    <div className="flex h-full flex-col">
      <div className="px-3 py-3">
        <a className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground" href={backHref}>
          <ArrowLeft className="size-3.5" />Back to app
        </a>
      </div>
      <div className="px-3 pb-2">
        <Field>
          <FieldLabel htmlFor="settings-search">Search settings</FieldLabel>
          <Input id="settings-search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Field>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
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
    </div>
  );
}

function SettingsMobileNavigation({ title, groups, activeHref, backHref }: { title: string; groups: SettingsNavGroup[]; activeHref: string; backHref: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={<Button variant="ghost" size="icon" aria-label="Open settings navigation" title="Open settings navigation"><Menu className="size-4" /></Button>} />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Popup data-slot="settings-mobile-nav" className="fixed inset-y-0 left-0 z-50 w-64 border-r border-sidebar-border bg-sidebar px-0 py-0 outline-none">
          <div className="flex h-12 items-center justify-between border-b border-sidebar-border px-3">
            <span className="text-[13px] font-semibold">{title}</span>
            <Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close settings navigation" title="Close settings navigation"><X className="size-3.5" /></Button>} />
          </div>
          <div className="h-[calc(100%-3rem)]">
            <SettingsNavContent groups={groups} activeHref={activeHref} search={search} setSearch={setSearch} backHref={backHref} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SettingsLayout({ title, companyId, backHref, activeHref, contentClassName = "max-w-3xl px-4 py-6 lg:px-8", children }: { title: string; companyId: string; backHref: string; activeHref: string; contentClassName?: string; children: ReactNode }): ReactElement {
  const context = useOptionalCompanyContext();
  const groups = useSettingsGroups(companyId, context?.user);
  const [search, setSearch] = useState("");
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
          <SettingsNavContent groups={groups} activeHref={activeHref} search={search} setSearch={setSearch} backHref={backHref} />
        </aside>
        <main className="min-w-0 flex-1">
          <header className="flex h-12 items-center gap-3 border-b border-border/70 px-4 lg:px-6">
            <div className="lg:hidden"><SettingsMobileNavigation title={title} groups={groups} activeHref={activeHref} backHref={backHref} /></div>
            <h1 className="min-w-0 truncate text-lg font-semibold">{title}</h1>
            <div className="ml-auto min-w-0 w-52 max-w-[50%]"><CompanySwitcher /></div>
          </header>
          <div className={contentClassName}>{children}</div>
        </main>
      </div>
    </div>
  );
}

export function SettingsSection({ title, description, children }: { title?: string; description?: string; children: ReactNode }): ReactElement {
  return (
    <section className="mb-6">
      {title ? <h2 className="mb-1 text-sm font-semibold">{title}</h2> : null}
      {description ? <p className="mb-3 text-xs text-muted-foreground">{description}</p> : null}
      <div className="overflow-hidden rounded-md border border-border bg-card">{children}</div>
    </section>
  );
}

export function SettingRow({ label, description, children, destructive }: { label: string; description?: string; children: ReactNode; destructive?: boolean }): ReactElement {
  return (
    <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className={destructive ? "text-[13px] font-medium text-rose-700" : "text-[13px] font-medium"}>{label}</div>
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
