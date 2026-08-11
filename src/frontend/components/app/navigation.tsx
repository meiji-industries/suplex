import { Activity, AlertTriangle, ChevronRight, ClipboardList, FolderGit2, ShieldCheck } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Dialog } from "../ui/dialog.js";
import { withCompany } from "../../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { CompanySwitcher } from "./company-switcher.js";

function isActive(path: string): boolean {
  const currentPath = window.location.pathname;
  return currentPath === path || currentPath.startsWith(`${path}/`);
}

function NavigationLinks({ close }: { close?: () => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const companyId = context?.currentCompany?.id;
  const links = [
    { href: "/health", label: "Host health", icon: ShieldCheck },
    { href: "/projects", label: "Projects", icon: FolderGit2 },
    { href: "/tasks", label: "Tasks", icon: ClipboardList },
    { href: "/attention", label: "Attention", icon: AlertTriangle },
  ];
  return (
    <nav aria-label="Forge navigation" className="space-y-0.5 text-[13px]">
      {links.map(({ href, label, icon: Icon }) => {
        const active = isActive(href);
        return <a aria-current={active ? "page" : undefined} className={active ? "flex h-7 items-center gap-2 rounded-md bg-sidebar-accent px-2 font-medium text-sidebar-foreground" : "flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"} href={withCompany(href, companyId)} onClick={close} key={href}><Icon className={active ? "size-3.5 text-primary" : "size-3.5"} />{label}</a>;
      })}
    </nav>
  );
}

export function AppSidebar(): ReactElement {
  return (
    <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 lg:flex lg:flex-col">
      <CompanySwitcher />
      <div className="mt-3"><NavigationLinks /></div>
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
      <Dialog.Trigger render={<Button variant="ghost" size="icon" aria-label="Open navigation" title="Open navigation"><Activity className="size-3.5" /></Button>} />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Popup data-slot="mobile-nav" className="fixed inset-y-0 left-0 z-50 w-60 border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 outline-none">
          <div className="flex h-8 items-center justify-between px-2">
            <div className="min-w-0 flex-1"><CompanySwitcher /></div>
            <Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close navigation" title="Close navigation"><ChevronRight className="size-3.5 rotate-180" /></Button>} />
          </div>
          <div className="mt-3"><NavigationLinks close={() => setOpen(false)} /></div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
