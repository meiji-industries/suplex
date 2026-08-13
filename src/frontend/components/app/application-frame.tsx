import { type ReactElement, type ReactNode } from "react";

import { Separator } from "../ui/separator.js";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../ui/sidebar.js";
import { AppSidebar } from "./navigation.js";

export function ApplicationFrame({ title, headerActions, headerRight, children }: { title: string; headerActions?: ReactElement | null | undefined; headerRight?: ReactElement | null | undefined; children: ReactNode }): ReactElement {
  return (
    <SidebarProvider style={{ "--sidebar-width": "18rem", "--header-height": "3rem" } as React.CSSProperties}>
      <AppSidebar />
      <SidebarInset>
        <header data-app-header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
          <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
            <SidebarTrigger className="-ml-1" aria-label="Open navigation" title="Toggle navigation" />
            <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
            <h1 className="text-base font-medium">{title}</h1>
            {headerActions}
            <div className="ml-auto flex items-center gap-2">{headerRight}</div>
          </div>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
