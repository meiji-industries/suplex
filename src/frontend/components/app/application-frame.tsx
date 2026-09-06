import type { ReactElement, ReactNode } from "react";

import { Separator } from "../ui/separator.js";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../ui/sidebar.js";
import { AppSidebar } from "./navigation.js";
import { SystemHealthAlert } from "./system-health.js";
import { ThemeToggle } from "./theme.js";

export function ApplicationFrame({ title, headerActions, headerRight, sidebar, children }: { title: string; headerActions?: ReactElement | null | undefined; headerRight?: ReactElement | null | undefined; sidebar?: ReactElement; children: ReactNode }): ReactElement {
  return (
    <SidebarProvider style={{ "--sidebar-width": "18rem", "--header-height": "3rem" } as React.CSSProperties}>
      {sidebar ?? <AppSidebar />}
      <SidebarInset>
        <header data-app-header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
          <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
            <SidebarTrigger className="-ml-1" aria-label="Open navigation" title="Toggle navigation" />
            <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
            <h1 className="min-w-0 truncate text-base font-medium" title={title}>{title}</h1>
            {headerActions}
            <div className="ml-auto flex shrink-0 items-center gap-2"><ThemeToggle />{headerRight}</div>
          </div>
        </header>
        <SystemHealthAlert />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
