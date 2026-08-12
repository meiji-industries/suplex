import { type ReactElement, type ReactNode } from "react";

import { AppSidebar, MobileNavigation } from "./navigation.js";

export function ApplicationFrame({ title, headerActions, headerRight, children }: { title: string; headerActions?: ReactElement | null | undefined; headerRight?: ReactElement | null | undefined; children: ReactNode }): ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        <AppSidebar />
        <main className="min-w-0 flex-1">
          <header data-app-header className="flex h-10 items-center justify-between px-3 sm:px-4">
            <div className="flex items-center gap-2"><span className="lg:hidden"><MobileNavigation /></span><span className="flex size-5 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background lg:hidden">F</span><h1 className="text-[13px] font-semibold">{title}</h1>{headerActions}</div>
            {headerRight}
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
