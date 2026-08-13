import { Collapsible } from ".././components/ui/collapsible.js";
import { Button } from ".././components/ui/button.js";
import { ApplicationFrame } from ".././components/app/application-frame.js";
import type { HealthCheck, HealthSnapshot } from "../../health.js";
import { isOwnedHealthCheck } from "../../health-contract.js";
import { Activity, ChevronRight, CircleHelp, Clock3, Database, GitBranch, HardDrive, RefreshCw, Terminal, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { relativeTime } from "../lib/view-shared.js";

const icons: Record<string, LucideIcon> = {
  temporal: Workflow,
  database: Database,
  "artifact-root": HardDrive,
  worker: Activity,
  "codex-auth": Terminal,
  "gh-auth": GitBranch,
};

function StatusIndicator({ check }: { check: HealthCheck }): ReactElement {
  const healthy = check.status === "healthy";
  const degraded = !healthy && !isOwnedHealthCheck(check.id);
  return (
    <span className={healthy ? "flex items-center gap-1.5 text-xs text-emerald-700" : degraded ? "flex items-center gap-1.5 text-xs text-amber-700" : "flex items-center gap-1.5 text-xs text-rose-700"}>
      <span className={healthy ? "size-1.5 rounded-full bg-emerald-500" : degraded ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-rose-500"} />
      {healthy ? "Healthy" : degraded ? "Degraded" : "Unavailable"}
    </span>
  );
}

function HealthRow({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id] ?? CircleHelp;
  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group">
      <Collapsible.Trigger className="flex min-h-9 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{check.label}</span>
        <span className="hidden min-w-0 flex-1 truncate pl-2 text-xs text-muted-foreground sm:block">{check.summary}</span>
        <StatusIndicator check={check} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="bg-muted/20 px-9 py-2.5 sm:px-11">
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

export function Dashboard({ initialSnapshot }: { initialSnapshot: HealthSnapshot }): ReactElement {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [freshness, setFreshness] = useState<"checking" | "current" | "stale">("current");
  const [lastSuccessfulCheckAt, setLastSuccessfulCheckAt] = useState(initialSnapshot.generatedAt);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setFreshness("checking");
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Health request failed");
      const nextSnapshot = await response.json() as HealthSnapshot;
      setSnapshot(nextSnapshot);
      setLastSuccessfulCheckAt(nextSnapshot.generatedAt);
      setFreshness("current");
    } catch {
      // Retain the last successful snapshot, but never present it as current.
      setFreshness("stale");
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
  const freshnessLabel = freshness === "checking"
    ? "Checking health…"
    : freshness === "stale"
      ? `Refresh failed · Last successful check ${relativeTime(lastSuccessfulCheckAt)}`
      : `Last successful check ${relativeTime(lastSuccessfulCheckAt)}`;
  const compactFreshnessLabel = freshness === "checking"
    ? "Checking…"
    : freshness === "stale"
      ? `Stale · ${relativeTime(lastSuccessfulCheckAt)}`
      : `Checked ${relativeTime(lastSuccessfulCheckAt)}`;

  return (
    <ApplicationFrame title="Host health" headerRight={
      <div className="flex items-center gap-2">
        <span className={snapshot.ready ? "hidden items-center gap-1.5 text-xs text-emerald-700 sm:flex" : "hidden items-center gap-1.5 text-xs text-amber-700 sm:flex"}>
          <span className={snapshot.ready ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-amber-500"} />
          {snapshot.ready ? "Ready" : "Needs attention"}
        </span>
        <a className="max-w-[34vw] truncate text-[11px] text-muted-foreground hover:text-foreground sm:max-w-64 sm:text-xs" href={snapshot.reachableAddress}>{snapshot.reachableAddress.replace(/^https?:\/\//, "")}</a>
        <span aria-live="polite" data-health-freshness={freshness} title={freshnessLabel} className={freshness === "stale" ? "max-w-[20vw] truncate text-[11px] text-amber-700 sm:hidden" : "max-w-[20vw] truncate text-[11px] text-muted-foreground sm:hidden"}>{compactFreshnessLabel}</span>
        <span aria-live="polite" data-health-freshness={freshness} className={freshness === "stale" ? "hidden text-[11px] text-amber-700 md:inline" : "hidden text-[11px] text-muted-foreground md:inline"}>{freshnessLabel}</span>
        <Button aria-label="Refresh health" title="Refresh health" variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /></Button>
      </div>
    }>

          <div className="flex h-9 items-center justify-between bg-muted/20 px-3 sm:px-4">
            <div className="flex h-full items-center gap-4 text-xs">
              <span className="flex h-full items-center font-medium text-foreground">Health</span>
              <span className="text-muted-foreground">{snapshot.checks.length} checks</span>
              <span className="text-emerald-700">{healthyCount} healthy</span>
              <span className={failingCount > 0 ? "text-rose-700" : "text-muted-foreground"}>{failingCount} issues</span>
            </div>
            <span aria-live="polite" data-health-freshness={freshness} className={freshness === "stale" ? "hidden items-center gap-1.5 text-[11px] text-amber-700 sm:flex" : "hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex"}><Clock3 className="size-3" />{freshnessLabel}</span>
          </div>

          <div>
            <section aria-labelledby="owned-services">
              <div className="flex h-8 items-center justify-between px-3 sm:px-4">
                <h2 id="owned-services" className="text-[11px] font-semibold text-muted-foreground">Owned services</h2>
                <span className="text-[11px] text-muted-foreground">{ownedChecks.length}</span>
              </div>
              <div>{ownedChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
            <section aria-labelledby="provider-access" className="mt-5">
              <div className="flex h-8 items-center justify-between px-3 sm:px-4">
                <h2 id="provider-access" className="text-[11px] font-semibold text-muted-foreground">Provider access</h2>
                <span className="text-[11px] text-muted-foreground">{providerChecks.length}</span>
              </div>
              <div>{providerChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
          </div>

    </ApplicationFrame>
  );
}
