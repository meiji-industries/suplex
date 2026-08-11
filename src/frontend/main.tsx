import { Collapsible } from "./components/ui/collapsible.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent } from "./components/ui/card.js";
import type { HealthCheck, HealthSnapshot } from "../health.js";
import {
  Activity,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Clock3,
  Database,
  ExternalLink,
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

function StatusBadge({ status }: { status: HealthCheck["status"] }): ReactElement {
  return (
    <Badge className={status === "healthy"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-rose-200 bg-rose-50 text-rose-700"}>
      <span className={cnDot(status)} />
      {status}
    </Badge>
  );
}

function cnDot(status: HealthCheck["status"]): string {
  return status === "healthy" ? "mr-1.5 size-1.5 rounded-full bg-emerald-500" : "mr-1.5 size-1.5 rounded-full bg-rose-500";
}

function HealthCard({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id] ?? CircleHelp;
  return (
    <Collapsible.Root data-status={check.status} className="group rounded-xl border border-border/80 bg-card shadow-xs transition-colors hover:border-border hover:shadow-sm">
      <Collapsible.Trigger className="flex w-full items-start gap-3 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset">
        <span className={check.status === "healthy"
          ? "flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600"
          : "flex size-8 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-600"}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-3">
            <span className="truncate text-sm font-semibold tracking-[-0.01em]">{check.label}</span>
            <StatusBadge status={check.status} />
          </span>
          <span className="mt-1 block text-[13px] leading-5 text-muted-foreground">{check.summary}</span>
        </span>
        <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-t border-border/70 px-4 py-3">
        {Object.keys(check.details).length > 0 ? (
          <dl className="grid gap-2 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-5">
            {Object.entries(check.details).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="font-medium text-muted-foreground">{key}</dt>
                <dd className="truncate text-foreground/80 sm:text-right">{String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">No additional details reported.</p>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Dashboard({ initialSnapshot }: { initialSnapshot: HealthSnapshot }): ReactElement {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
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

  const ownedChecks = useMemo(() => snapshot.checks.filter((check) => ["temporal", "database", "artifact-root", "worker"].includes(check.id)), [snapshot.checks]);
  const providerChecks = useMemo(() => snapshot.checks.filter((check) => !["temporal", "database", "artifact-root", "worker"].includes(check.id)), [snapshot.checks]);
  const healthyCount = snapshot.checks.filter((check) => check.status === "healthy").length;
  const failingCount = snapshot.checks.length - healthyCount;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[1440px]">
        <aside className="hidden w-56 shrink-0 border-r border-sidebar-border bg-sidebar px-3 py-4 lg:flex lg:flex-col">
          <div className="flex items-center gap-2 px-2 pb-7">
            <span className="flex size-7 items-center justify-center rounded-lg bg-foreground text-xs font-bold text-background">F</span>
            <span className="text-sm font-semibold tracking-[-0.02em]">Forge</span>
          </div>
          <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Workspace</div>
          <nav className="space-y-0.5 text-sm">
            <a className="flex items-center gap-2 rounded-lg bg-sidebar-accent px-2.5 py-2 font-medium text-sidebar-foreground" href="/health"><Activity className="size-4 text-primary" />Overview</a>
            <a className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" href="/health"><ShieldCheck className="size-4" />Host health</a>
            <span className="flex cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-2 text-muted-foreground/50"><Server className="size-4" />Projects</span>
          </nav>
          <div className="mt-auto border-t border-sidebar-border pt-3">
            <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-emerald-500" />Local host connected</div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="flex h-14 items-center justify-between border-b border-border/70 px-4 sm:px-8">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="lg:hidden font-semibold text-foreground">Forge</span><span className="lg:hidden text-border">/</span><span>Operations</span><span>/</span><span className="text-foreground">Host health</span></div>
            <div className="flex items-center gap-2"><span className="hidden text-xs text-muted-foreground sm:inline">{relativeTime(snapshot.generatedAt)}</span><Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />Refresh</Button></div>
          </header>

          <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
            <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
              <div><div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary"><span className="size-1.5 rounded-full bg-primary" />Runtime overview</div><h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Host health</h1><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">A focused view of the services Forge owns and the local credentials it can use.</p></div>
              <a className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground" href={snapshot.reachableAddress}><ExternalLink className="size-3.5" />{snapshot.reachableAddress.replace(/^https?:\/\//, "")}</a>
            </div>

            <Card className={snapshot.ready ? "mb-8 border-emerald-200 bg-emerald-50/50" : "mb-8 border-amber-200 bg-amber-50/60"}>
              <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3"><span className={snapshot.ready ? "flex size-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600" : "flex size-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600"}>{snapshot.ready ? <Check className="size-5" /> : <CircleAlert className="size-5" />}</span><div><p className="text-sm font-semibold">{snapshot.ready ? "Everything is operational" : "Attention needed"}</p><p className="mt-0.5 text-xs text-muted-foreground">{snapshot.ready ? "All Forge-owned services are reporting normally." : `${failingCount} check${failingCount === 1 ? "" : "s"} need attention before Forge is ready.`}</p></div></div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="size-3.5" />Updated {relativeTime(snapshot.generatedAt)}</div>
              </CardContent>
            </Card>

            <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
              <div className="bg-card px-4 py-3"><div className="text-xs text-muted-foreground">Checks</div><div className="mt-1 text-xl font-semibold tracking-[-0.03em]">{snapshot.checks.length}</div></div>
              <div className="bg-card px-4 py-3"><div className="text-xs text-muted-foreground">Healthy</div><div className="mt-1 text-xl font-semibold tracking-[-0.03em] text-emerald-600">{healthyCount}</div></div>
              <div className="col-span-2 bg-card px-4 py-3 sm:col-span-1"><div className="text-xs text-muted-foreground">Issues</div><div className={failingCount > 0 ? "mt-1 text-xl font-semibold tracking-[-0.03em] text-rose-600" : "mt-1 text-xl font-semibold tracking-[-0.03em]"}>{failingCount}</div></div>
            </div>

            <section aria-labelledby="owned-services"><div className="mb-3 flex items-center justify-between"><h2 id="owned-services" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Owned services</h2><span className="text-xs text-muted-foreground">{ownedChecks.length} checks</span></div><div className="grid gap-3 md:grid-cols-2">{ownedChecks.map((check) => <HealthCard check={check} key={check.id} />)}</div></section>
            <section aria-labelledby="provider-access" className="mt-8"><div className="mb-3 flex items-center justify-between"><h2 id="provider-access" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Provider access</h2><span className="text-xs text-muted-foreground">Shown separately from readiness</span></div><div className="grid gap-3 md:grid-cols-2">{providerChecks.map((check) => <HealthCard check={check} key={check.id} />)}</div></section>
            <p className="mt-8 text-xs text-muted-foreground">Credentials are checked locally and never displayed here.</p>
          </div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("forge-app")!).render(<Dashboard initialSnapshot={window.__FORGE_HEALTH__} />);
