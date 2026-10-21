import { copyToClipboard } from "../../lib/clipboard.js";
import { Activity, Binary, Bot, Check, CheckCircle2, ChevronRight, CircleAlert, Copy, Database, GitBranch, HardDrive, LayoutGrid, Network, Package, Pi, RefreshCw, ShieldCheck, SquarePi, SquareTerminal, Terminal, XCircle, type LucideIcon } from "lucide-react";
import { createContext, useContext, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";

import type { HealthCheck, HealthSnapshot } from "../../contracts/health.js";
import { isOwnedHealthCheck, isRequiredHealthCheck, type HealthCheckId } from "../../contracts/health-checks.js";
import { HealthSnapshotSchema } from "../../contracts/health-schema.js";
import { createHealthRefresher, healthContextQuery, type HealthContextSelector } from "../../lib/health-refresh.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { relativeTime } from "../../shell/view-shared.js";
import { ToolActionButton } from "./tool-action-button.js";
import { Button } from "../ui/button.js";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Badge } from "../ui/badge.js";
import { Progress, ProgressLabel, ProgressValue } from "../ui/progress.js";
import { Collapsible } from "../ui/collapsible.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import { StatusLight } from "./status-light.js";
import { SidebarMenuButton } from "../ui/sidebar.js";
import { GithubDeviceSignIn } from "./github-device-sign-in.js";
import { Spinner } from "../ui/spinner.js";
import { installHerdr } from "../../features/settings/lib/herdr-install-api.js";

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
  "gh-cli": GitBranch,
  pnpm: Package,
  tailscale: Network,
  backup: ShieldCheck,
  executable: Binary,
  "provider:opencode": Terminal,
  "provider:claude-code": Bot,
  "provider:codex": SquareTerminal,
  "provider:pi": Pi,
  "provider:omp": SquarePi,
};

export function HealthCheckIcon({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id];
  return <Icon aria-hidden="true" className={check.status === "healthy" ? "size-4 shrink-0 text-emerald-700 dark:text-emerald-400" : check.status === "warning" || !isOwnedHealthCheck(check.id) && !isRequiredHealthCheck(check.id) ? "size-4 shrink-0 text-amber-700 dark:text-amber-400" : "size-4 shrink-0 text-destructive"} />;
}

export function healthCheckPurpose(id: HealthCheckId): string {
  switch (id) {
    case "database": return "Store your tasks";
    case "artifact-root": return "Store task files";
    case "disk-space": return "Keep room for Suplex";
    case "git": return "Save code changes";
    case "herdr-readiness": return "Open the agent terminals";
    case "gh-auth": return "Publish pull requests";
    case "gh-cli": return "Let agents read pull requests and checks";
    case "pnpm": return "Update Suplex";
    case "tailscale": return "Reach this host";
    case "backup": return "Recover your data";
    case "executable": return "Let agents start Suplex tools";
    case "provider:opencode": return "Run tasks with OpenCode";
    case "provider:claude-code": return "Run tasks with Claude Code";
    case "provider:codex": return "Run tasks with Codex CLI";
    case "provider:pi": return "Run tasks with Pi";
    case "provider:omp": return "Run tasks with OMP";
  }
}

export function getSystemHealthLevel(snapshot: HealthSnapshot | undefined, freshness: HealthFreshness): SystemHealthLevel {
  const rollupChecks = snapshot?.checks.filter((check) => check.id !== "backup") ?? [];
  if (snapshot && (!snapshot.ready || rollupChecks.some((check) => (isOwnedHealthCheck(check.id) || isRequiredHealthCheck(check.id)) && check.status === "unhealthy"))) return "red";
  if (!snapshot || freshness === "stale" || snapshot.checks.length === 0 || rollupChecks.some((check) => check.status !== "healthy")) return "amber";
  return "green";
}

export function healthFreshnessLabel(freshness: HealthFreshness, lastSuccessfulCheckAt?: string): string {
  if (freshness === "checking") return "Suplex checks the host.";
  if (freshness === "stale") return lastSuccessfulCheckAt ? `Suplex could not check the host · Last successful check ${relativeTime(lastSuccessfulCheckAt)}` : "Suplex could not check the host";
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
  const failed = health?.snapshot?.checks.find(check => (isOwnedHealthCheck(check.id) || !["/setup", "/onboarding"].includes(window.location.pathname) && isRequiredHealthCheck(check.id)) && check.status === "unhealthy");
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

/** One click installs Herdr on the host when it is absent and starts its server, then checks the host again. */
export function HerdrInstallButton(): ReactElement {
  const { refresh } = useSystemHealth();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; remedy?: string | undefined }>();
  const install = async (): Promise<void> => {
    setPending(true);
    setFailure(undefined);
    try {
      const result = await installHerdr();
      if (result.ok) await refresh();
      else setFailure({ reason: result.reason, remedy: result.remedy });
    } catch (reason) {
      setFailure({ reason: reason instanceof Error ? reason.message : "Suplex could not install Herdr." });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2">
      <ToolActionButton disabled={pending} onClick={() => void install()}>{pending ? <Spinner /> : null}{pending ? "Installing Herdr" : "Install and start Herdr"}</ToolActionButton>
      {failure ? <p role="status" className="text-xs text-destructive">{failure.reason}{failure.remedy ? ` ${failure.remedy}` : ""}</p> : null}
    </div>
  );
}

const diskSize = (bytes: number): string => bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(2)} TB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/** The fact a healthy check proved, such as a version or account, so the badge says more than "Healthy". */
export function healthyCheckLabel(check: HealthCheck): string {
  const text = (key: string): string | undefined => typeof check.details[key] === "string" && check.details[key] !== "" ? check.details[key] : undefined;
  const bytes = (key: string): string | undefined => typeof check.details[key] === "number" ? `${diskSize(check.details[key])} free` : undefined;
  const verifiedAt = text("verifiedAt");
  switch (check.id) {
    case "database": return typeof check.details.appliedMigrations === "number" ? `${check.details.appliedMigrations} migrations` : "Healthy";
    case "artifact-root": return bytes("freeBytes") ?? "Healthy";
    case "disk-space": return bytes("freeBytes") ?? "Healthy";
    case "git": case "pnpm": case "executable": return text("version") ?? "Healthy";
    case "herdr-readiness": return text("serverVersion") ?? "Healthy";
    case "gh-auth": return text("logins") ?? "Healthy";
    case "gh-cli": return "Signed in";
    case "tailscale": return text("hostname") ?? "Healthy";
    case "backup": return verifiedAt && verifiedAt !== "never" ? relativeTime(verifiedAt) : "Healthy";
    case "provider:opencode": case "provider:claude-code": case "provider:codex": case "provider:pi": case "provider:omp": return text("account") ?? "Signed in";
  }
}

export function CheckStatusIndicator({ check, healthyLabel = healthyCheckLabel(check) }: { check: HealthCheck; healthyLabel?: string }): ReactElement {
  const healthy = check.status === "healthy";
  const degraded = check.status === "warning" || (!healthy && !isOwnedHealthCheck(check.id) && !isRequiredHealthCheck(check.id));
  return (
    <Badge variant={healthy || degraded ? "secondary" : "destructive"} className={healthy ? "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400" : degraded ? "bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400" : undefined}>
      {healthy ? <CheckCircle2 /> : degraded ? <CircleAlert /> : <XCircle />}
      {healthy ? healthyLabel : degraded ? "Degraded" : "Offline"}
    </Badge>
  );
}

export function HealthTechnicalDetails({ check }: { check: HealthCheck }): ReactElement {
  return <Accordion><AccordionItem value="technical"><AccordionTrigger>Technical details</AccordionTrigger><AccordionContent>
    {Object.keys(check.details).length > 0 ? <dl className="grid gap-1.5 text-xs sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-5">{Object.entries(check.details).map(([key, value]) => <div className="contents" key={key}><dt className="text-muted-foreground">{key}</dt><dd className="min-w-0 break-words text-foreground/80">{String(value)}</dd></div>)}</dl> : <p className="text-xs text-muted-foreground">No additional details.</p>}
  </AccordionContent></AccordionItem></Accordion>;
}

type DiskRoot = { label: string; path: string | number | boolean | undefined; free: number; total: number };

function diskRoots(details: HealthCheck["details"]): DiskRoot[] {
  return [
    { label: "Worktree root", path: details.worktreeRoot, free: details.worktreeFreeBytes, total: details.worktreeTotalBytes },
    { label: "Artifact root", path: details.artifactRoot, free: details.artifactFreeBytes, total: details.artifactTotalBytes },
  ].flatMap((root) => typeof root.free === "number" && typeof root.total === "number" && root.total > 0 ? [{ ...root, free: root.free, total: root.total }] : []);
}

function DiskSpaceUsage({ roots, minFreeBytes }: { roots: DiskRoot[]; minFreeBytes: number }): ReactElement {
  return (
    <div className="grid gap-3">
      {roots.map((root) => {
        const low = minFreeBytes > 0 && root.free < minFreeBytes;
        return (
          <div key={root.label}>
            <Progress value={((root.total - root.free) / root.total) * 100} className={low ? "[&_[data-slot=progress-indicator]]:bg-destructive" : "[&_[data-slot=progress-indicator]]:bg-emerald-600 dark:[&_[data-slot=progress-indicator]]:bg-emerald-500"}>
              <ProgressLabel>{root.label}</ProgressLabel>
              <ProgressValue>{() => `${diskSize(root.free)} free of ${diskSize(root.total)}`}</ProgressValue>
            </Progress>
            {typeof root.path === "string" ? <p className="mt-1 truncate text-xs text-muted-foreground">{root.path}</p> : null}
            {low ? <p className="mt-1 text-xs text-destructive">{root.label}: {diskSize(root.free)} free; minimum is {diskSize(minFreeBytes)}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

export function HealthRow({ check, compact = false, flush = false, expandable = true }: { check: HealthCheck; compact?: boolean; flush?: boolean; expandable?: boolean }): ReactElement {
  const { user } = useCompanyContext();
  const { refresh } = useSystemHealth();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const disk = check.id === "disk-space" ? diskRoots(check.details) : [];
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const rowContent = <>
    <HealthCheckIcon check={check} />
    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{check.label}</span>{!compact ? <span className="block text-xs text-muted-foreground">{healthCheckPurpose(check.id)}</span> : null}</span>
    <CheckStatusIndicator check={check} />
  </>;
  const rowClassName = `flex min-h-9 w-full items-center gap-2.5 py-2 text-left ${flush ? "px-0" : "px-3 sm:px-4"}`;
  if (!expandable) return <div data-slot="health-row" data-status={check.status} className={rowClassName}>{rowContent}</div>;

  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group">
      <Collapsible.Trigger className={`${rowClassName} outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50`}>
        {rowContent}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className={`bg-muted/20 py-3 ${flush ? "pr-0 pl-7" : "px-4 sm:px-11"}`}>
        {compact ? <p className="mb-1 text-xs font-medium">{healthCheckPurpose(check.id)}</p> : null}
        {disk.length > 0 ? <DiskSpaceUsage roots={disk} minFreeBytes={typeof check.details.minFreeBytes === "number" ? check.details.minFreeBytes : 0} /> : <p className="mb-3 text-xs text-muted-foreground">{check.summary}</p>}
        {check.remedy === "Open the Tailscale app and sign in" ? <Alert><Network /><AlertTitle>Sign in to Tailscale on the host</AlertTitle><AlertDescription>Open the Tailscale app and sign in. Then check the host again.</AlertDescription></Alert> : check.remedy && check.remedyKind === "link" ? <div className="space-y-2 rounded-md border bg-background p-3"><p className="text-xs font-medium">Open the instructions</p><p className="text-xs text-muted-foreground">Install instructions are on the official page. Then check again.</p><Button size="xs" variant="outline" nativeButton={false} render={<a href={check.remedy} target="_blank" rel="noreferrer" />}>Open the instructions</Button></div> : check.remedy ? <div className="space-y-2 rounded-md border bg-background p-3"><p className="text-xs font-medium">Run on the Suplex host</p><p className="text-xs text-muted-foreground">Open the Terminal on the host. Run this command, then check again.</p><div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{check.remedy}</code><Button size="xs" variant="outline" aria-label="Copy the command" onClick={async () => { setCopyState(await copyToClipboard(check.remedy ?? "", "Copied the repair command to clipboard") ? "copied" : "failed"); }}>{copyState === "copied" ? <Check /> : <Copy />}{copyState === "copied" ? "Copied" : "Copy"}</Button></div>{copyState === "failed" ? <p role="status" className="text-xs text-destructive">Suplex cannot copy the command. Select the command and copy it manually.</p> : null}</div> : null}
        {check.id === "gh-auth" && check.details.method === "device" && check.status !== "healthy" && user?.role === "admin" ? <GithubDeviceSignIn onConnected={() => refresh()} /> : null}
        {check.id === "herdr-readiness" && check.status === "unhealthy" && user?.role === "admin" ? <div className="mt-3"><HerdrInstallButton /></div> : null}
        {disk.length === 0 ? <HealthTechnicalDetails check={check} /> : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** "flush" lines the headings and rows up with the page column; the compact popover keeps its padding. */
export function HealthCheckSections({ snapshot, compact = false, attentionOnly = false, flush = false }: { snapshot: HealthSnapshot | undefined; compact?: boolean; attentionOnly?: boolean; flush?: boolean }): ReactElement {
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
      {groups.filter(group => group.checks.length > 0).map((group, index) => <section key={group.title} aria-labelledby={`${sectionId}-${index}`}><div className={`flex h-8 items-center justify-between ${flush ? "px-0" : "px-3 sm:px-4"}`}><h2 id={`${sectionId}-${index}`} className="text-xs font-semibold text-muted-foreground">{group.title}</h2><span className="text-xs text-muted-foreground">{group.checks.length}</span></div><div>{group.checks.map(check => <HealthRow check={check} compact={compact} flush={flush} key={`${check.id}-${check.remedy ?? ""}`} />)}</div></section>)}
      {checks.length === 0 ? <p className="p-4 text-xs text-muted-foreground">{attentionOnly ? "No checks need attention." : "No checks are available."}</p> : null}
    </div>
  );
}

/** The host this page was loaded from, so a desktop window shows which Suplex it is on. */
const instanceHost = typeof location === "undefined" ? "" : location.host;
const windowOrigin = typeof location === "undefined" ? "" : location.origin;

/** How this window reaches Suplex, derived from the address it loaded. */
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
        {sidebar && instanceHost ? <span className="ml-auto min-w-0 truncate rounded-[5px] bg-muted px-1.5 py-0.5 text-xs text-muted-foreground font-normal" title={instanceHost} data-testid="instance-host">{instanceHost}</span> : null}
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
          <div className="flex items-center justify-between gap-3 py-1.5"><dt className="text-muted-foreground">Suplex address</dt><dd className="min-w-0 truncate font-mono" title={health.snapshot?.reachableAddress}>{health.snapshot?.reachableAddress ?? "Not available"}</dd></div>
          <div className="flex items-center justify-between gap-3 py-1.5"><dt className="text-muted-foreground">Route</dt><dd>{connectionRoute(windowOrigin)}</dd></div>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
