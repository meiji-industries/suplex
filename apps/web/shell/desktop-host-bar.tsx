import { Activity, ChevronDown, Globe2, Monitor } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "../components/ui/button.js";
import { Progress } from "../components/ui/progress.js";
import { getSystemHealthLevel, useSystemHealth } from "../components/app/system-health.js";
import type { DesktopUpdateStatus } from "../vite-env.js";
import { thisComputer } from "./desktop-platform.js";

export function DesktopHostBar(): ReactElement | null {
  const health = useSystemHealth();
  const watch = health.watch;
  useEffect(() => window.suplexApp ? watch() : undefined, [watch]);
  if (!window.suplexApp && !window.suplexMobile) return null;

  const host = window.location.host;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const label = local ? thisComputer() : host;
  const level = getSystemHealthLevel(health.snapshot, health.freshness);
  const status = health.freshness === "stale" || level === "red" || !health.snapshot ? "Not available" : level === "green" ? "Ready" : "Needs attention";

  return <footer data-desktop-host-bar className="fixed inset-x-0 bottom-0 z-30 flex h-8 items-center gap-2 border-t bg-background px-2 text-xs text-muted-foreground">
    <Button type="button" variant="ghost" size="xs" aria-label={`Select a Suplex host. Current host: ${label}`} onClick={() => { void (window.suplexApp ?? window.suplexMobile)?.openHostPicker(); }}>
      {local ? <Monitor aria-hidden="true" /> : <Globe2 aria-hidden="true" />}
      <span className="max-w-[45vw] truncate">{label}</span>
      <ChevronDown aria-hidden="true" />
    </Button>
    {window.suplexApp ? <span className="flex min-w-0 items-center gap-1" role="status"><Activity aria-hidden="true" className="size-3" />{status}</span> : null}
    {window.suplexApp?.version ? <DesktopUpdate version={window.suplexApp.version} /> : null}
  </footer>;
}

/** The installed version, and the desktop updater's progress while it checks, downloads, or waits for a restart. */
function DesktopUpdate({ version }: { version: string }): ReactElement {
  const [update, setUpdate] = useState<DesktopUpdateStatus>({ phase: "idle" });
  useEffect(() => {
    const app = window.suplexApp;
    if (!app?.updateStatus || !app.onUpdateChange) return;
    const unsubscribe = app.onUpdateChange(setUpdate);
    void app.updateStatus().then(setUpdate).catch(() => undefined);
    return unsubscribe;
  }, []);
  const check = (): void => { void window.suplexApp?.checkForUpdates?.(); };

  if (update.phase === "downloading") {
    // A feed without a content length gives no percent, so the bar would read as zero: show the bytes instead.
    const percent = update.total ? Math.floor(update.received * 100 / update.total) : null;
    const amount = percent === null ? `${Math.floor(update.received / 1048576)} MB` : `${percent}%`;
    return <span className="ml-auto flex items-center gap-2" role="status" aria-live="polite">
      <span>Downloading {update.version} {amount}</span>
      {percent === null ? null : <span className="w-24"><Progress value={percent} aria-label={`Downloading desktop app ${update.version}`} /></span>}
    </span>;
  }
  const text = update.phase === "checking" ? "Checking for updates"
    : update.phase === "available" ? `${update.version} available`
    : update.phase === "ready" ? `Restart to update to ${update.version}`
    : version;
  const title = update.phase === "ready" ? "Restart the desktop app to apply the downloaded update"
    : update.phase === "available" ? `Download desktop app ${update.version}`
    : `Check for desktop app updates. Installed version ${version}`;
  return <span className="ml-auto">
    <Button type="button" variant="ghost" size="xs" disabled={update.phase === "checking"} aria-label={title} title={title} onClick={check}>{text}</Button>
  </span>;
}
