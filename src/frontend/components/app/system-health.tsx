import { Activity, Bot, Check, CheckCircle2, ChevronRight, CircleAlert, Copy, Database, GitBranch, HardDrive, LayoutGrid, Network, Package, RefreshCw, ShieldCheck, SquareTerminal, Terminal, XCircle, type LucideIcon } from "lucide-react";
import { createContext, useContext, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";

import type { HealthCheck, HealthSnapshot } from "../../../platform/health.js";
import { isOwnedHealthCheck, isRequiredHealthCheck, type HealthCheckId } from "../../../platform/health-contract.js";
import { HealthSnapshotSchema } from "../../../platform/schemas.js";
import { createHealthRefresher, healthContextQuery, type HealthContextSelector } from "../../lib/health-refresh.js";
import { relativeTime } from "../../shell/view-shared.js";
import { Button } from "../ui/button.js";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Badge } from "../ui/badge.js";
import { Collapsible } from "../ui/collapsible.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import { StatusLight } from "./status-light.js";
import { SidebarMenuButton } from "../ui/sidebar.js";

export type { HealthContextSelector } from "../../lib/health-refresh.js";
export type HealthFreshness = "checking" | "current" | "stale";
export type SystemHealthLevel = "green" | "amber" | "red";

type SystemHealthContextValue = {
  snapshot: HealthSnapshot | undefined;
  freshness: HealthFreshness;
  lastSuccessfulCheckAt: string | undefined;
  refreshing: boolean;
  refresh: (context?: HealthContextSelector) => Promise<void>;
  /** Registers a visible health surface so visibility and focus signals re-check the host. */
  watch: () => () => void;
};

const SystemHealthContext = createContext<SystemHealthContextValue | undefined>(undefined);

const icons: Record<HealthCheckId, LucideIcon> = {
  database: Database,
  "artifact-root": HardDrive,
  "disk-space": HardDrive,
  git: GitBranch,
  "herdr-readiness": LayoutGrid,
  "gh-auth": GitBranch,
  pnpm: Package,
  tailscale: Network,
  backup: ShieldCheck,
  "provider:opencode": Terminal,
  "provider:claude-code": Bot,
  "provider:codex": SquareTerminal,
};

export function HealthCheckIcon({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id];
  return <Icon aria-hidden="true" className={check.status === "healthy" ? "size-4 shrink-0 text-emerald-700 dark:text-emerald-400" : check.status === "warning" || !isOwnedHealthCheck(check.id) && !isRequiredHealthCheck(check.id) ? "size-4 shrink-0 text-amber-700 dark:text-amber-400" : "size-4 shrink-0 text-destructive"} />;
}

export function healthCheckPurpose(id: HealthCheckId): string {
  switch (id) {
    case "database": return "Store your tasks";
    case "artifact-root": return "Store task files";
    case "disk-space": return "Keep room for Forge";
    case "git": return "Save code changes";
    case "herdr-readiness": return "Open the agent terminals";
    case "gh-auth": return "Publish pull requests";
    case "pnpm": return "Update Forge";
    case "tailscale": return "Reach this host";
    case "backup": return "Recover your data";
    case "provider:opencode": return "Run tasks with OpenCode";
    case "provider:claude-code": return "Run tasks with Claude Code";
    case "provider:codex": return "Run tasks with Codex CLI";
  }
}

export function getSystemHealthLevel(snapshot: HealthSnapshot | undefined, freshness: HealthFreshness): SystemHealthLevel {
  const rollupChecks = snapshot?.checks.filter((check) => check.id !== "backup") ?? [];
  if (snapshot && (!snapshot.ready || rollupChecks.some((check) => (isOwnedHealthCheck(check.id) || isRequiredHealthCheck(check.id)) && check.status === "unhealthy"))) return "red";
  if (!snapshot || freshness === "stale" || snapshot.checks.length === 0 || rollupChecks.some((check) => check.status !== "healthy")) return "amber";
  return "green";
}

export function healthFreshnessLabel(freshness: HealthFreshness, lastSuccessfulCheckAt?: string): string {
  if (freshness === "checking") return "Forge checks the host.";
  if (freshness === "stale") return lastSuccessfulCheckAt ? `Forge could not check the host · Last successful check ${relativeTime(lastSuccessfulCheckAt)}` : "Forge could not check the host";
  if (!lastSuccessfulCheckAt) return "No successful health check";
  return `Last successful check ${relativeTime(lastSuccessfulCheckAt)}`;
}

export function SystemHealthProvider({ initialSnapshot, children }: { initialSnapshot: HealthSnapshot | undefined; children: ReactNode }): ReactElement {
  const [refresher] = useState(() => createHealthRefresher({
    initialSnapshot,
    read: async (context, force) => {
      const query = healthContextQuery(context);
      const response = await fetch(`/api/health${query ? `?${query}` : ""}`, { headers: force ? { Accept: "application/json", "Cache-Control": "no-cache" } : { Accept: "application/json" } });
      if (!response.ok) throw new Error("Health request failed");
      return HealthSnapshotSchema.parse(await response.json());
    },
    onChange: (next) => setHealth(next),
  }));
  const [health, setHealth] = useState(refresher.state);

  useEffect(() => {
    if (!initialSnapshot) void refresher.refresh();
  }, [initialSnapshot, refresher]);

  useEffect(() => {
    const onVisibility = (): void => { if (document.visibilityState === "visible") refresher.notifyVisible(); };
    const onFocus = (): void => refresher.notifyVisible();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresher]);

  useEffect(() => refresher.startPolling(() => document.visibilityState === "visible"), [refresher]);

  return <SystemHealthContext.Provider value={{ ...health, refresh: refresher.refresh, watch: refresher.watch }}>{children}</SystemHealthContext.Provider>;
}

export function useSystemHealth(): SystemHealthContextValue {
  const value = useContext(SystemHealthContext);
  if (!value) throw new Error("System health is not available outside SystemHealthProvider");
  return value;
}

export function SystemHealthAlert(): ReactElement | null {
  const health = useContext(SystemHealthContext);
  const failed = health?.snapshot?.checks.find(check => (isOwnedHealthCheck(check.id) || window.location.pathname !== "/setup" && isRequiredHealthCheck(check.id)) && check.status === "unhealthy");
  if (!failed) return null;
  return (
    <div data-system-health-alert className="border-b px-4 py-3 lg:px-6">
      <Alert variant="destructive">
        <Activity />
        <AlertTitle>{failed.label} not available</AlertTitle>
        <AlertDescription>{failed.summary} {isRequiredHealthCheck(failed.id) ? <a href="/setup">Repair the host</a> : <a href="/health">Open host health</a>}.</AlertDescription>
      </Alert>
    </div>
  );
}

export function CheckStatusIndicator({ check }: { check: HealthCheck }): ReactElement {
  const healthy = check.status === "healthy";
  const degraded = check.status === "warning" || (!healthy && !isOwnedHealthCheck(check.id) && !isRequiredHealthCheck(check.id));
  return (
    <Badge variant={healthy ? "secondary" : degraded ? "outline" : "destructive"}>
      {healthy ? <CheckCircle2 /> : degraded ? <CircleAlert /> : <XCircle />}
      {healthy ? "Healthy" : degraded ? "Degraded" : "Offline"}
    </Badge>
  );
}

export function HealthTechnicalDetails({ check }: { check: HealthCheck }): ReactElement {
  return <Accordion><AccordionItem value="technical"><AccordionTrigger>Technical details</AccordionTrigger><AccordionContent>
    {Object.keys(check.details).length > 0 ? <dl className="grid gap-1.5 text-xs sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-5">{Object.entries(check.details).map(([key, value]) => <div className="contents" key={key}><dt className="text-muted-foreground">{key}</dt><dd className="min-w-0 break-words text-foreground/80">{String(value)}</dd></div>)}</dl> : <p className="text-xs text-muted-foreground">No additional details.</p>}
  </AccordionContent></AccordionItem></Accordion>;
}

export function HealthRow({ check, compact = false }: { check: HealthCheck; compact?: boolean }): ReactElement {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group">
      <Collapsible.Trigger className="flex min-h-9 w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
        <HealthCheckIcon check={check} />
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-foreground">{check.label}</span>{!compact ? <span className="block text-xs text-muted-foreground">{healthCheckPurpose(check.id)}</span> : null}</span>
        <CheckStatusIndicator check={check} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="bg-muted/20 px-4 py-3 sm:px-11">
        {compact ? <p className="mb-1 text-xs font-medium">{healthCheckPurpose(check.id)}</p> : null}
        <p className="mb-3 text-xs text-muted-foreground">{check.summary}</p>
        {check.remedy === "Open the Tailscale app and sign in" ? <Alert><Network /><AlertTitle>Sign in to Tailscale on the host</AlertTitle><AlertDescription>Open the Tailscale app and sign in. Then check the host again.</AlertDescription></Alert> : check.remedy && check.remedyKind === "link" ? <div className="space-y-2 rounded-md border bg-background p-3"><p className="text-xs font-medium">Open the instructions</p><p className="text-xs text-muted-foreground">Install instructions are on the official page. Then check again.</p><Button size="xs" variant="outline" nativeButton={false} render={<a href={check.remedy} target="_blank" rel="noreferrer" />}>Open the instructions</Button></div> : check.remedy ? <div className="space-y-2 rounded-md border bg-background p-3"><p className="text-xs font-medium">Run on the Forge host</p><p className="text-xs text-muted-foreground">Open the Terminal on the host. Run this command, then check again.</p><div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{check.remedy}</code><Button size="xs" variant="outline" aria-label="Copy the command" onClick={async () => { try { await navigator.clipboard.writeText(check.remedy ?? ""); setCopyState("copied"); } catch { setCopyState("failed"); } }}>{copyState === "copied" ? <Check /> : <Copy />}{copyState === "copied" ? "Copied" : "Copy"}</Button></div>{copyState === "failed" ? <p role="status" className="text-xs text-destructive">Forge cannot copy the command. Select the command and copy it manually.</p> : null}</div> : null}
        <HealthTechnicalDetails check={check} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function HealthCheckSections({ snapshot, compact = false, attentionOnly = false }: { snapshot: HealthSnapshot | undefined; compact?: boolean; attentionOnly?: boolean }): ReactElement {
  const sectionId = useId();
  if (!snapshot) return <div className="p-4 text-xs text-muted-foreground">Health data is not available.</div>;
  const checks = snapshot.checks.filter((check) => !attentionOnly || check.status !== "healthy");
  const groups = [
    { title: "Owned services", checks: checks.filter(check => isOwnedHealthCheck(check.id)) },
    { title: "Host tools", checks: checks.filter(check => isRequiredHealthCheck(check.id)) },
    { title: "Provider access", checks: checks.filter(check => !isOwnedHealthCheck(check.id) && !isRequiredHealthCheck(check.id)) },
  ];
  return (
    <div className="space-y-4">
      {groups.filter(group => group.checks.length > 0).map((group, index) => <section key={group.title} aria-labelledby={`${sectionId}-${index}`}><div className="flex h-8 items-center justify-between px-3 sm:px-4"><h2 id={`${sectionId}-${index}`} className="text-[11px] font-semibold text-muted-foreground">{group.title}</h2><span className="text-[11px] text-muted-foreground">{group.checks.length}</span></div><div>{group.checks.map(check => <HealthRow check={check} compact={compact} key={`${check.id}-${check.remedy ?? ""}`} />)}</div></section>)}
      {checks.length === 0 ? <p className="p-4 text-xs text-muted-foreground">{attentionOnly ? "No checks need attention." : "No checks are available."}</p> : null}
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
  const watch = health?.watch;
  useEffect(() => {
    if (!open || !watch) return undefined;
    return watch();
  }, [open, watch]);
  if (!health) return null;
  const level = getSystemHealthLevel(health.snapshot, health.freshness);
  const label = level === "green" ? "Healthy" : level === "amber" ? "Degraded" : "Offline";
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
