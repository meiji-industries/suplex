import { Activity, ChevronRight, ClipboardList, FolderGit2, ShieldCheck } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Dialog } from "../ui/dialog.js";

function ForgeMark(): ReactElement {
  return <span className="flex size-5 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background">F</span>;
}

function NavigationLinks({ close }: { close?: () => void }): ReactElement {
  return (
    <nav aria-label="Forge navigation" className="space-y-0.5 text-[13px]">
      <a className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" href="/health" onClick={close}><Activity className="size-3.5" />Overview</a>
      <a aria-current="page" className="flex h-7 items-center gap-2 rounded-md bg-sidebar-accent px-2 font-medium text-sidebar-foreground" href="/health" onClick={close}><ShieldCheck className="size-3.5 text-primary" />Host health</a>
      <a className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" href="/projects" onClick={close}><FolderGit2 className="size-3.5" />Projects</a>
      <a className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" href="/tasks" onClick={close}><ClipboardList className="size-3.5" />Tasks</a>
    </nav>
  );
}

export function AppSidebar(): ReactElement {
  return (
    <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 lg:flex lg:flex-col">
      <div className="flex h-8 items-center gap-2 px-2"><ForgeMark /><span className="text-[13px] font-semibold tracking-[-0.02em]">Forge</span></div>
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
            <div className="flex items-center gap-2"><ForgeMark /><span className="text-[13px] font-semibold">Forge</span></div>
            <Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close navigation" title="Close navigation"><ChevronRight className="size-3.5 rotate-180" /></Button>} />
          </div>
          <div className="mt-3"><NavigationLinks close={() => setOpen(false)} /></div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
