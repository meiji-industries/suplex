import { Activity, ChevronRight, CircleHelp, Database, GitBranch, HardDrive, RefreshCw, Terminal, Workflow, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";

import type { HealthCheck, HealthSnapshot } from "../../../health.js";
import { isOwnedHealthCheck } from "../../../health-contract.js";
import { relativeTime } from "../../lib/view-shared.js";
import { Button } from "../ui/button.js";
import { Collapsible } from "../ui/collapsible.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";

export type HealthFreshness = "checking" | "current" | "stale";
export type SystemHealthLevel = "green" | "amber" | "red";

type SystemHealthContextValue = {
  snapshot: HealthSnapshot | undefined;
  freshness: HealthFreshness;
  lastSuccessfulCheckAt: string | undefined;
  refreshing: boolean;
  refresh: () => Promise<void>;
};

const SystemHealthContext = createContext<SystemHealthContextValue | undefined>(undefined);

const icons: Record<string, LucideIcon> = {
  temporal: Workflow,
  database: Database,
  "artifact-root": HardDrive,
  worker: Activity,
  "codex-auth": Terminal,
  "gh-auth": GitBranch,
};

export function getSystemHealthLevel(snapshot: HealthSnapshot | undefined, freshness: HealthFreshness): SystemHealthLevel {
  if (snapshot && (!snapshot.ready || snapshot.checks.some((check) => isOwnedHealthCheck(check.id) && check.status !== "healthy"))) return "red";
  if (!snapshot || freshness === "stale" || snapshot.checks.length === 0 || snapshot.checks.some((check) => check.status !== "healthy")) return "amber";
  return "green";
}

export function healthFreshnessLabel(freshness: HealthFreshness, lastSuccessfulCheckAt?: string): string {
  if (freshness === "checking") return "Checking health…";
  if (!lastSuccessfulCheckAt) return "No successful health check";
  return freshness === "stale" ? `Refresh failed · Last successful check ${relativeTime(lastSuccessfulCheckAt)}` : `Last successful check ${relativeTime(lastSuccessfulCheckAt)}`;
}

export function SystemHealthProvider({ initialSnapshot, children }: { initialSnapshot: HealthSnapshot | undefined; children: ReactNode }): ReactElement {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [freshness, setFreshness] = useState<HealthFreshness>(initialSnapshot ? "current" : "checking");
  const [lastSuccessfulCheckAt, setLastSuccessfulCheckAt] = useState(initialSnapshot?.generatedAt);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async (): Promise<void> => {
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
      setFreshness("stale");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!initialSnapshot) void refresh();
  }, [initialSnapshot, refresh]);

  return <SystemHealthContext.Provider value={{ snapshot, freshness, lastSuccessfulCheckAt, refreshing, refresh }}>{children}</SystemHealthContext.Provider>;
}

export function useSystemHealth(): SystemHealthContextValue {
  const value = useContext(SystemHealthContext);
  if (!value) throw new Error("System health is unavailable outside SystemHealthProvider");
  return value;
}

function CheckStatusIndicator({ check }: { check: HealthCheck }): ReactElement {
  const healthy = check.status === "healthy";
  const degraded = !healthy && !isOwnedHealthCheck(check.id);
  return (
    <span className={healthy ? "flex items-center gap-1.5 text-xs text-emerald-700" : degraded ? "flex items-center gap-1.5 text-xs text-amber-700" : "flex items-center gap-1.5 text-xs text-rose-700"}>
      <span className={healthy ? "size-1.5 rounded-full bg-emerald-500" : degraded ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-rose-500"} />
      {healthy ? "Healthy" : degraded ? "Degraded" : "Unavailable"}
    </span>
  );
}

function HealthRow({ check, compact = false }: { check: HealthCheck; compact?: boolean }): ReactElement {
  const Icon = icons[check.id] ?? CircleHelp;
  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group">
      <Collapsible.Trigger className="flex min-h-9 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{check.label}</span>
        {compact ? <span className="flex-1" /> : <span className="hidden min-w-0 flex-1 truncate pl-2 text-xs text-muted-foreground sm:block">{check.summary}</span>}
        <CheckStatusIndicator check={check} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="bg-muted/20 px-9 py-2.5 sm:px-11">
        {compact ? <p className="mb-2 text-xs text-muted-foreground">{check.summary}</p> : null}
        {Object.keys(check.details).length > 0 ? (
          <dl className="grid gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-5">
            {Object.entries(check.details).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="truncate text-foreground/80">{String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : <span className="text-xs text-muted-foreground">No additional details reported.</span>}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function HealthCheckSections({ snapshot, compact = false }: { snapshot: HealthSnapshot | undefined; compact?: boolean }): ReactElement {
  const sectionId = useId();
  const ownedId = `${sectionId}-owned`;
  const providerId = `${sectionId}-providers`;
  const ownedChecks = useMemo(() => snapshot?.checks.filter((check) => isOwnedHealthCheck(check.id)) ?? [], [snapshot]);
  const providerChecks = useMemo(() => snapshot?.checks.filter((check) => !isOwnedHealthCheck(check.id)) ?? [], [snapshot]);
  if (!snapshot) return <div className="p-4 text-xs text-muted-foreground">Health data is unavailable.</div>;
  return (
    <div>
      <section aria-labelledby={ownedId}>
        <div className="flex h-8 items-center justify-between px-3 sm:px-4"><h2 id={ownedId} className="text-[11px] font-semibold text-muted-foreground">Owned services</h2><span className="text-[11px] text-muted-foreground">{ownedChecks.length}</span></div>
        <div>{ownedChecks.map((check) => <HealthRow check={check} compact={compact} key={check.id} />)}</div>
      </section>
      <section aria-labelledby={providerId} className="mt-5">
        <div className="flex h-8 items-center justify-between px-3 sm:px-4"><h2 id={providerId} className="text-[11px] font-semibold text-muted-foreground">Provider access</h2><span className="text-[11px] text-muted-foreground">{providerChecks.length}</span></div>
        <div>{providerChecks.map((check) => <HealthRow check={check} compact={compact} key={check.id} />)}</div>
      </section>
    </div>
  );
}

export function SystemHealthIndicator(): ReactElement | null {
  const health = useContext(SystemHealthContext);
  const [open, setOpen] = useState(false);
  if (!health) return null;
  const level = getSystemHealthLevel(health.snapshot, health.freshness);
  const label = level === "green" ? "Healthy" : level === "amber" ? "Degraded" : "Unavailable";
  const lightClass = level === "green" ? "bg-emerald-500" : level === "amber" ? "bg-amber-500" : "bg-rose-500";
  const healthyCount = health.snapshot?.checks.filter((check) => check.status === "healthy").length ?? 0;
  const checkCount = health.snapshot?.checks.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label={`System health: ${label}`} title={`System health: ${label}`} data-system-health data-status={level} />}>
        <span className="relative flex size-2">
          <span className={`absolute -inset-0.5 inline-flex size-3 rounded-full opacity-50 motion-safe:animate-ping ${lightClass}`} />
          <span className={`relative inline-flex size-2 rounded-full motion-safe:animate-pulse ${lightClass}`} />
        </span>
      </DialogTrigger>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>System health</DialogTitle>
          <DialogDescription>{label} · {healthFreshnessLabel(health.freshness, health.lastSuccessfulCheckAt)}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{healthyCount} of {checkCount} checks healthy</span>
          <Button variant="outline" size="sm" onClick={() => void health.refresh()} disabled={health.refreshing}><RefreshCw className={health.refreshing ? "size-3.5 animate-spin" : "size-3.5"} />Refresh</Button>
        </div>
        <HealthCheckSections snapshot={health.snapshot} compact />
      </DialogContent>
    </Dialog>
  );
}
