import { createContext, useContext, type ReactElement, type ReactNode } from "react";

import { cn } from "../lib/utils.js";
import { Separator } from "../components/ui/separator.js";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../components/ui/sidebar.js";
import { AppSidebar } from "./navigation.js";
import { SystemHealthAlert } from "../components/app/system-health.js";
import { UpdateNotice } from "../components/app/update-notice.js";
import { ThemeToggle } from "../components/app/theme.js";
import { GlobalNewTaskDialog } from "./global-new-task-dialog.js";

const ApplicationShellContext = createContext(false);

export function ApplicationShell({ children }: { children: ReactNode }): ReactElement {
  return <ApplicationShellContext.Provider value>
    <SidebarProvider style={{ "--sidebar-width": "18rem", "--header-height": "3rem" } as React.CSSProperties}>
      <AppSidebar />
      <GlobalNewTaskDialog />
      {children}
    </SidebarProvider>
  </ApplicationShellContext.Provider>;
}

export function ApplicationFrame({ title, headerActions, headerRight, sidebar, viewportBound = false, children }: { title: string; headerActions?: ReactElement | null | undefined; headerRight?: ReactElement | null | undefined; sidebar?: ReactElement; viewportBound?: boolean; children: ReactNode }): ReactElement {
  const withinShell = useContext(ApplicationShellContext);
  const content = <SidebarInset className={cn("min-w-0", viewportBound && "max-h-[calc(100dvh-var(--desktop-status-height,0px))] min-h-0 overflow-hidden md:max-h-[calc(100dvh-(--spacing(4))-var(--desktop-status-height,0px))]")}>
        <header data-app-header className="titlebar-drag titlebar-inset flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
          <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
            {sidebar !== null ? <><SidebarTrigger className="-ml-1" aria-label="Open navigation" title="Toggle navigation" /><Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" /></> : null}
            <h1 className="min-w-0 truncate text-base font-medium" title={title}>{title}</h1>
            {headerActions}
            <div className="ml-auto flex shrink-0 items-center gap-2"><ThemeToggle />{headerRight}</div>
          </div>
        </header>
        <UpdateNotice />
        <SystemHealthAlert />
        {children}
      </SidebarInset>;
  if (withinShell) return content;
  return (
    <SidebarProvider style={{ "--sidebar-width": "18rem", "--header-height": "3rem" } as React.CSSProperties}>
      {sidebar ?? <AppSidebar />}
      <GlobalNewTaskDialog />
      {content}
    </SidebarProvider>
  );
}
