import { Collapsible } from "./components/ui/collapsible.js";
import { Button } from "./components/ui/button.js";
import { Dialog } from "./components/ui/dialog.js";
import type { HealthCheck, HealthSnapshot } from "../health.js";
import { isOwnedHealthCheck } from "../health-contract.js";
import {
  Activity,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  GitBranch,
  HardDrive,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const icons: Record<string, LucideIcon> = {
  temporal: Workflow,
  database: Database,
  "artifact-root": HardDrive,
  worker: Activity,
  "codex-auth": Terminal,
  "gh-auth": GitBranch,
};

function relativeTime(timestamp: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (elapsed < 10_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}

function StatusIndicator({ status }: { status: HealthCheck["status"] }): ReactElement {
  const healthy = status === "healthy";
  return (
    <span className={healthy ? "flex items-center gap-1.5 text-xs text-emerald-700" : "flex items-center gap-1.5 text-xs text-rose-700"}>
      <span className={healthy ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-rose-500"} />
      {healthy ? "Healthy" : "Unhealthy"}
    </span>
  );
}

function HealthRow({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id] ?? CircleHelp;
  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group border-b border-border/70 last:border-b-0">
      <Collapsible.Trigger className="flex min-h-9 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{check.label}</span>
        <span className="hidden min-w-0 flex-1 truncate pl-2 text-xs text-muted-foreground sm:block">{check.summary}</span>
        <StatusIndicator status={check.status} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-t border-border/70 bg-muted/20 px-9 py-2.5 sm:px-11">
        {Object.keys(check.details).length > 0 ? (
          <dl className="grid gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-5">
            {Object.entries(check.details).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="truncate text-foreground/80">{String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className="text-xs text-muted-foreground">No additional details reported.</span>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function NavigationLinks({ close }: { close?: () => void }): ReactElement {
  return (
    <nav aria-label="Forge navigation" className="space-y-0.5 text-[13px]">
      <a className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" href="/health" onClick={close}><Activity className="size-3.5" />Overview</a>
      <a aria-current="page" className="flex h-7 items-center gap-2 rounded-md bg-sidebar-accent px-2 font-medium text-sidebar-foreground" href="/health" onClick={close}><ShieldCheck className="size-3.5 text-primary" />Host health</a>
      <span className="flex h-7 cursor-not-allowed items-center gap-2 rounded-md px-2 text-muted-foreground/45"><Server className="size-3.5" />Projects</span>
    </nav>
  );
}

function AppSidebar(): ReactElement {
  return (
    <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 lg:flex lg:flex-col">
      <div className="flex h-8 items-center gap-2 px-2">
        <span className="flex size-5 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background">F</span>
        <span className="text-[13px] font-semibold tracking-[-0.02em]">Forge</span>
      </div>
      <div className="mt-3"><NavigationLinks /></div>
      <div className="mt-auto border-t border-sidebar-border pt-2">
        <div className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />Local host</div>
      </div>
    </aside>
  );
}

function MobileNavigation({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger render={<Button variant="ghost" size="icon" aria-label="Open navigation" title="Open navigation"><Activity className="size-3.5" /></Button>} />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Popup data-slot="mobile-nav" className="fixed inset-y-0 left-0 z-50 w-60 border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 shadow-xl outline-none">
          <div className="flex h-8 items-center justify-between px-2">
            <div className="flex items-center gap-2"><span className="flex size-5 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background">F</span><span className="text-[13px] font-semibold">Forge</span></div>
            <Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close navigation" title="Close navigation"><ChevronRight className="size-3.5 rotate-180" /></Button>} />
          </div>
          <div className="mt-3"><NavigationLinks close={() => onOpenChange(false)} /></div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Dashboard({ initialSnapshot }: { initialSnapshot: HealthSnapshot }): ReactElement {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Health request failed");
      setSnapshot(await response.json() as HealthSnapshot);
    } catch {
      // Keep the last truthful snapshot visible when a refresh is interrupted.
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const ownedChecks = useMemo(() => snapshot.checks.filter((check) => isOwnedHealthCheck(check.id)), [snapshot.checks]);
  const providerChecks = useMemo(() => snapshot.checks.filter((check) => !isOwnedHealthCheck(check.id)), [snapshot.checks]);
  const healthyCount = snapshot.checks.filter((check) => check.status === "healthy").length;
  const failingCount = snapshot.checks.length - healthyCount;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        <AppSidebar />

        <main className="min-w-0 flex-1">
          <header className="flex h-10 items-center justify-between border-b border-border/70 px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="lg:hidden"><MobileNavigation open={mobileNavOpen} onOpenChange={setMobileNavOpen} /></span>
              <span className="flex size-5 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background lg:hidden">F</span>
              <h1 className="truncate text-[13px] font-semibold">Host health</h1>
              <span className="text-border">/</span>
              <span className={snapshot.ready ? "flex items-center gap-1.5 text-xs text-emerald-700" : "flex items-center gap-1.5 text-xs text-amber-700"}>
                <span className={snapshot.ready ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-amber-500"} />
                {snapshot.ready ? "Ready" : "Needs attention"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <a className="max-w-[34vw] truncate text-[11px] text-muted-foreground hover:text-foreground sm:max-w-64 sm:text-xs" href={snapshot.reachableAddress}>{snapshot.reachableAddress.replace(/^https?:\/\//, "")}</a>
              <span className="hidden text-xs text-muted-foreground md:inline">{relativeTime(snapshot.generatedAt)}</span>
              <Button aria-label="Refresh health" title="Refresh health" variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /></Button>
            </div>
          </header>

          <div className="flex h-9 items-center justify-between border-b border-border/70 bg-muted/20 px-3 sm:px-4">
            <div className="flex h-full items-center gap-4 text-xs">
              <span className="flex h-full items-center border-b-2 border-primary font-medium text-foreground">Health</span>
              <span className="text-muted-foreground">{snapshot.checks.length} checks</span>
              <span className="text-emerald-700">{healthyCount} healthy</span>
              <span className={failingCount > 0 ? "text-rose-700" : "text-muted-foreground"}>{failingCount} issues</span>
            </div>
            <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex"><Clock3 className="size-3" />Updated {relativeTime(snapshot.generatedAt)}</span>
          </div>

          <div>
            <section aria-labelledby="owned-services">
              <div className="flex h-8 items-center justify-between border-b border-border/70 px-3 sm:px-4">
                <h2 id="owned-services" className="text-[11px] font-semibold text-muted-foreground">Owned services</h2>
                <span className="text-[11px] text-muted-foreground">{ownedChecks.length}</span>
              </div>
              <div>{ownedChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
            <section aria-labelledby="provider-access" className="mt-5">
              <div className="flex h-8 items-center justify-between border-y border-border/70 px-3 sm:px-4">
                <h2 id="provider-access" className="text-[11px] font-semibold text-muted-foreground">Provider access</h2>
                <span className="text-[11px] text-muted-foreground">{providerChecks.length}</span>
              </div>
              <div>{providerChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
          </div>

        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("forge-app")!).render(<Dashboard initialSnapshot={window.__FORGE_HEALTH__} />);
