import { AlertTriangle, Columns3, ClipboardList, FolderGit2, Menu, Settings, ShieldCheck, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet.js";
import { companySettingsPath, withCompany } from "../../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { title: string; items: NavItem[] };

function isActive(href: string): boolean {
  const current = window.location.pathname;
  const target = new URL(href, window.location.href).pathname;
  return current === target;
}

function NavigationGroups({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  const groups = useMemo<NavGroup[]>(() => {
    return [
      { title: "Overview", items: [
        { href: withCompany("/health", companyId), label: "Host health", icon: ShieldCheck },
        { href: withCompany("/attention", companyId), label: "Attention", icon: AlertTriangle },
      ]},
      { title: "Work", items: [
        { href: withCompany("/projects", companyId), label: "Projects", icon: FolderGit2 },
        { href: withCompany("/tasks", companyId), label: "Tasks", icon: ClipboardList },
        { href: withCompany("/board", companyId), label: "Board", icon: Columns3 },
      ]},
    ];
  }, [companyId]);
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.title}>
          <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</div>
          <nav className="space-y-0.5" aria-label={group.title}>
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = isActive(href);
              return (
                <a key={href} aria-current={active ? "page" : undefined} className={active ? "flex h-7 items-center gap-2 rounded-md bg-sidebar-accent px-2 text-[13px] font-medium text-sidebar-foreground" : "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"} href={href} onClick={close}>
                  <Icon className={active ? "size-3.5 text-primary" : "size-3.5"} />{label}
                </a>
              );
            })}
          </nav>
        </section>
      ))}
    </div>
  );
}

function SettingsLink({ close }: { close?: () => void }): ReactElement | null {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  if (context?.user?.role !== "admin" || !companyId) return null;
  const href = companySettingsPath(companyId);
  return <a className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground" href={href} onClick={close}><Settings className="size-3.5" />Settings</a>;
}

export function AppSidebar(): ReactElement {
  return (
    <aside className="hidden w-52 shrink-0 flex-col bg-sidebar px-2.5 py-2.5 lg:flex">
      <CompanySwitcher />
      <div className="mt-3"><NavigationGroups /></div>
      <div className="mt-auto pt-2"><SettingsLink /></div>
      <div className="mt-1 pt-1">
        <div className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />Local host</div>
      </div>
    </aside>
  );
}

export function MobileNavigation(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open navigation" title="Open navigation"><Menu className="size-4" /></Button>} />
      <SheetContent data-slot="mobile-nav" side="left" className="w-60 bg-sidebar px-2.5 py-2.5" showCloseButton closeLabel="Close navigation">
        <SheetHeader className="h-8 p-0">
          <SheetTitle className="sr-only">Forge navigation</SheetTitle>
          <CompanySwitcher />
        </SheetHeader>
        <div className="mt-3 flex h-[calc(100%-2.75rem)] flex-col"><NavigationGroups close={() => setOpen(false)} /><div className="mt-auto pt-2"><SettingsLink close={() => setOpen(false)} /></div></div>
      </SheetContent>
    </Sheet>
  );
}
