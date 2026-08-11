import { AlertTriangle, ClipboardList, FolderGit2, Menu, Settings2, Shield, ShieldCheck, X, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Dialog } from "../ui/dialog.js";
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
  const user = context?.user;
  const groups = useMemo<NavGroup[]>(() => {
    const base: NavGroup[] = [
      { title: "Overview", items: [
        { href: withCompany("/health", companyId), label: "Host health", icon: ShieldCheck },
        { href: withCompany("/attention", companyId), label: "Attention", icon: AlertTriangle },
      ]},
      { title: "Work", items: [
        { href: withCompany("/projects", companyId), label: "Projects", icon: FolderGit2 },
        { href: withCompany("/tasks", companyId), label: "Tasks", icon: ClipboardList },
      ]},
    ];
    const adminItems: NavItem[] = [];
    if (companyId) adminItems.push({ href: companySettingsPath(companyId), label: "Settings", icon: Settings2 });
    adminItems.push({ href: withCompany("/admin", companyId), label: "Administration", icon: Shield });
    if (user?.role === "admin") base.push({ title: "Administration", items: adminItems });
    return base;
  }, [companyId, user?.role]);
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

export function AppSidebar(): ReactElement {
  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 lg:flex">
      <CompanySwitcher />
      <div className="mt-3"><NavigationGroups /></div>
      <div className="mt-auto border-t border-sidebar-border pt-2">
        <div className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />Local host</div>
      </div>
    </aside>
  );
}

export function MobileNavigation(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={<Button variant="ghost" size="icon" aria-label="Open navigation" title="Open navigation"><Menu className="size-4" /></Button>} />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Popup data-slot="mobile-nav" className="fixed inset-y-0 left-0 z-50 w-60 border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 outline-none">
          <div className="flex h-8 items-center justify-between px-2">
            <div className="min-w-0 flex-1"><CompanySwitcher /></div>
            <Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close navigation" title="Close navigation"><X className="size-3.5" /></Button>} />
          </div>
          <div className="mt-3"><NavigationGroups close={() => setOpen(false)} /></div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
