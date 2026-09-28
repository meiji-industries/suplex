import { Activity, ChevronDown, Globe2, Monitor } from "lucide-react";
import { useEffect, type ReactElement } from "react";

import { Button } from "../components/ui/button.js";
import { getSystemHealthLevel, useSystemHealth } from "../components/app/system-health.js";

export function DesktopHostBar(): ReactElement | null {
  const health = useSystemHealth();
  const watch = health.watch;
  useEffect(() => window.suplexApp ? watch() : undefined, [watch]);
  if (!window.suplexApp) return null;

  const host = window.location.host;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const label = local ? "This Mac" : host;
  const level = getSystemHealthLevel(health.snapshot, health.freshness);
  const status = health.freshness === "stale" || level === "red" || !health.snapshot ? "Not available" : level === "green" ? "Ready" : "Needs attention";

  return <footer data-desktop-host-bar className="fixed inset-x-0 bottom-0 z-30 flex h-8 items-center gap-2 border-t bg-background px-2 text-xs text-muted-foreground">
    <Button type="button" variant="ghost" size="xs" aria-label={`Select a Suplex host. Current host: ${label}`} onClick={() => { void window.suplexApp?.openHostPicker(); }}>
      {local ? <Monitor aria-hidden="true" /> : <Globe2 aria-hidden="true" />}
      <span className="max-w-[45vw] truncate">{label}</span>
      <ChevronDown aria-hidden="true" />
    </Button>
    <span className="flex min-w-0 items-center gap-1" role="status"><Activity aria-hidden="true" className="size-3" />{status}</span>
  </footer>;
}
