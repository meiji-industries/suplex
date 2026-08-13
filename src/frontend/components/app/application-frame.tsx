import { type ReactElement, type ReactNode } from "react";

import { SidebarInset, SidebarProvider, SidebarTrigger } from "../ui/sidebar.js";
import { AppSidebar } from "./navigation.js";
import { SystemHealthIndicator } from "./system-health.js";

export function ApplicationFrame({ title, headerActions, headerRight, children }: { title: string; headerActions?: ReactElement | null | undefined; headerRight?: ReactElement | null | undefined; children: ReactNode }): ReactElement {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header data-app-header className="flex h-10 items-center justify-between border-b px-3 sm:px-4">
          <div className="flex items-center gap-2"><span className="md:hidden"><SidebarTrigger aria-label="Open navigation" title="Open navigation" /></span><span className="flex size-5 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background md:hidden">F</span><h1 className="text-[13px] font-semibold">{title}</h1>{headerActions}</div>
          <div className="flex items-center gap-1">{headerRight}<SystemHealthIndicator /></div>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
