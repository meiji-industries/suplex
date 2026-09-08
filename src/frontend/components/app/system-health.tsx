import { Activity, ChevronRight, CircleHelp, Database, GitBranch, HardDrive, RefreshCw, Terminal, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";

import type { HealthCheck, HealthSnapshot } from "../../../platform/health.js";
import { isOwnedHealthCheck } from "../../../platform/health-contract.js";
import { relativeTime } from "../../shell/view-shared.js";
import { Button } from "../ui/button.js";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Collapsible } from "../ui/collapsible.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import { StatusLight } from "./status-light.js";
import { SidebarMenuButton } from "../ui/sidebar.js";

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
  database: Database,
  "artifact-root": HardDrive,
  opencode: Terminal,
  "gh-auth": GitBranch,
};

export function getSystemHealthLevel(snapshot: HealthSnapshot | undefined, freshness: HealthFreshness): SystemHealthLevel {
  const rollupChecks = snapshot?.checks.filter((check) => check.id !== "backup") ?? [];
  if (snapshot && (!snapshot.ready || rollupChecks.some((check) => isOwnedHealthCheck(check.id) && check.status === "unhealthy"))) return "red";
  if (!snapshot || freshness === "stale" || snapshot.checks.length === 0 || rollupChecks.some((check) => check.status !== "healthy")) return "amber";
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
  if (!value) throw new Error("System health is not available outside SystemHealthProvider");
  return value;
}

export function SystemHealthAlert(): ReactElement | null {
  const health = useContext(SystemHealthContext);
  const failed = health?.snapshot?.checks.find(check => isOwnedHealthCheck(check.id) && check.status === "unhealthy");
  if (!failed) return null;
  return (
    <div data-system-health-alert className="border-b px-4 py-3 lg:px-6">
      <Alert variant="destructive">
        <Activity />
        <AlertTitle>{failed.label} not available</AlertTitle>
        <AlertDescription>{failed.summary} <a href="/health">Open host health</a>.</AlertDescription>
      </Alert>
    </div>
  );
}

function CheckStatusIndicator({ check }: { check: HealthCheck }): ReactElement {
  const healthy = check.status === "healthy";
  const degraded = check.status === "warning" || (!healthy && !isOwnedHealthCheck(check.id));
  return (
    <span className={healthy ? "flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400" : degraded ? "flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400" : "flex items-center gap-1.5 text-xs text-destructive"}>
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

/** The host this page was loaded from, so a desktop window shows which Forge it is on. */
const instanceHost = typeof location === "undefined" ? "" : location.host;
const windowOrigin = typeof location === "undefined" ? "" : location.origin;

/** How this window reaches Forge, derived from the address it loaded. */
export function connectionRoute(origin: string): string {
  let url: URL;
  try { url = new URL(origin); } catch { return "Not available"; }
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "This computer";
  if (url.hostname.endsWith(".ts.net")) return `Tailscale (${url.protocol === "https:" ? "Serve, HTTPS" : "direct, HTTP"})`;
  return url.protocol === "https:" ? "HTTPS" : "HTTP";
}

export function SystemHealthIndicator({ sidebar = false }: { sidebar?: boolean } = {}): ReactElement | null {
  const health = useContext(SystemHealthContext);
  const [open, setOpen] = useState(false);
  if (!health) return null;
  const level = getSystemHealthLevel(health.snapshot, health.freshness);
  const label = level === "green" ? "Healthy" : level === "amber" ? "Degraded" : "Unavailable";
  const healthyCount = health.snapshot?.checks.filter((check) => check.status === "healthy").length ?? 0;
  const checkCount = health.snapshot?.checks.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={sidebar ? <SidebarMenuButton aria-label={`System health: ${label}`} title={`System health: ${label}`} data-system-health data-status={level} /> : <Button variant="ghost" size="icon" aria-label={`System health: ${label}`} title={`System health: ${label}`} data-system-health data-status={level} />}>
        <span className="flex size-4 shrink-0 items-center justify-center">
          <StatusLight level={level} label={label} />
        </span>
        {sidebar ? <span>{label}</span> : null}
        {sidebar && instanceHost ? <span className="ml-auto min-w-0 truncate rounded-[5px] bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" title={instanceHost} data-testid="instance-host">{instanceHost}</span> : null}
      </DialogTrigger>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>System health</DialogTitle>
          <DialogDescription>{label} · {healthFreshnessLabel(health.freshness, health.lastSuccessfulCheckAt)}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{healthyCount} of {checkCount} checks healthy</span>
          <Button size="icon-xs" variant="ghost" aria-label="Refresh" title="Refresh" onClick={() => void health.refresh()} disabled={health.refreshing}><RefreshCw aria-hidden="true" className={health.refreshing ? "size-3.5 animate-spin" : "size-3.5"} /></Button>
        </div>
        <HealthCheckSections snapshot={health.snapshot} compact />
        <dl className="divide-y border-t text-xs" data-testid="connection-details">
          <div className="flex items-center justify-between gap-3 py-1.5"><dt className="text-muted-foreground">This window</dt><dd className="min-w-0 truncate font-mono" title={windowOrigin}>{windowOrigin || "Not available"}</dd></div>
          <div className="flex items-center justify-between gap-3 py-1.5"><dt className="text-muted-foreground">Forge address</dt><dd className="min-w-0 truncate font-mono" title={health.snapshot?.reachableAddress}>{health.snapshot?.reachableAddress ?? "Not available"}</dd></div>
          <div className="flex items-center justify-between gap-3 py-1.5"><dt className="text-muted-foreground">Route</dt><dd>{connectionRoute(windowOrigin)}</dd></div>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
