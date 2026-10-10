import { createContext, useContext, useEffect, type ReactElement, type ReactNode } from "react";

import { cn } from "../lib/utils.js";
import { Separator } from "../components/ui/separator.js";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../components/ui/sidebar.js";
import { AppSidebar } from "./navigation.js";
import { SystemHealthAlert } from "../components/app/system-health.js";
import { UpdateNotice } from "../components/app/update-notice.js";
import { TelemetryNotice } from "./telemetry-notice.js";
import { ReadOnlyNotice } from "./read-only-notice.js";
import { ThemeToggle } from "../components/app/theme.js";
import { GlobalNewTaskDialog } from "./global-new-task-dialog.js"; import { QuickShell } from "./quick-shell.js"; import { Search } from "lucide-react"; import { Button } from "../components/ui/button.js";

const ApplicationShellContext = createContext(false);

export function ApplicationShell({ children }: { children: ReactNode }): ReactElement {
  return <ApplicationShellContext.Provider value>
    <SidebarProvider style={{ "--sidebar-width": "18rem", "--header-height": "3rem" } as React.CSSProperties}>
      <AppSidebar />
      <GlobalNewTaskDialog />
      <QuickShell />
      {children}
    </SidebarProvider>
  </ApplicationShellContext.Provider>;
}

export function ApplicationFrame({ title, documentTitle, headerActions, headerRight, headerPrimary, sidebar, viewportBound = false, children }: { title: string; documentTitle?: string | undefined; headerActions?: ReactElement | null | undefined; headerRight?: ReactElement | null | undefined; /** The page's main action, at the far right of the header. */ headerPrimary?: ReactElement | null | undefined; sidebar?: ReactElement; viewportBound?: boolean; children: ReactNode }): ReactElement {
  const withinShell = useContext(ApplicationShellContext);
  useEffect(() => { document.title = `Suplex · ${documentTitle ?? title}`; }, [documentTitle, title]);
  const content = <SidebarInset className={cn("min-w-0", viewportBound && "max-h-[calc(100dvh-var(--desktop-status-height,0px))] min-h-0 overflow-hidden md:max-h-[calc(100dvh-(--spacing(4))-var(--desktop-status-height,0px))]")}>
        <header data-app-header data-tauri-drag-region="deep" className="titlebar-inset flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
          <div className="flex w-full items-center gap-1 pr-4 pl-3 lg:gap-2 lg:pr-6">
            {sidebar !== null ? <><SidebarTrigger className="-ml-1" aria-label="Open navigation" title="Toggle navigation" /><Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4 ml-[0px] mr-[8px]" /></> : null}
            <h1 className="min-w-0 truncate font-medium text-lg" title={title}>{title}</h1>
            {headerActions}
            <div className="ml-auto flex shrink-0 items-center gap-2"><ThemeToggle />{headerRight}{sidebar === undefined ? <Button variant="ghost" size="icon-sm" onClick={() => window.dispatchEvent(new Event("suplex:command-menu"))} aria-label="Search Suplex" title="Search Suplex (⌘K)"><Search /></Button> : null}{headerPrimary}</div>
          </div>
        </header>
        <UpdateNotice />
        <TelemetryNotice />
        <ReadOnlyNotice />
        <SystemHealthAlert />
        {children}
      </SidebarInset>;
  if (withinShell) return content;
  return (
    <SidebarProvider style={{ "--sidebar-width": "18rem", "--header-height": "3rem" } as React.CSSProperties}>
      {sidebar ?? <AppSidebar />}
      <GlobalNewTaskDialog />
      <QuickShell />
      {content}
    </SidebarProvider>
  );
}
