import { Clock3, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "../components/ui/button.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { HealthCheckSections, healthFreshnessLabel, useSystemHealth } from "../components/app/system-health.js";
import { SettingsLayout } from "../components/app/settings-layout.js";
import { withCompany } from "../lib/api.js";
import { relativeTime } from "../lib/view-shared.js";

export function Dashboard(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const { snapshot, freshness, lastSuccessfulCheckAt, refreshing, refresh } = useSystemHealth();
  const companyId = currentCompany?.id ?? "";
  const healthyCount = snapshot?.checks.filter((check) => check.status === "healthy").length ?? 0;
  const checkCount = snapshot?.checks.length ?? 0;
  const failingCount = checkCount - healthyCount;
  const checked = healthFreshnessLabel(freshness, lastSuccessfulCheckAt);
  const compactChecked = freshness === "checking" ? "Checking…" : freshness === "stale" ? `Stale · ${lastSuccessfulCheckAt ? relativeTime(lastSuccessfulCheckAt) : "unknown"}` : `Checked ${lastSuccessfulCheckAt ? relativeTime(lastSuccessfulCheckAt) : "unknown"}`;

  return (
    <SettingsLayout title="Host health" companyId={companyId} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/health", companyId)}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 bg-muted/20 px-3 py-1.5 sm:px-4">
        <div className="flex items-center gap-4 text-xs">
          <span className="font-medium text-foreground">Health</span>
          <span className="text-muted-foreground">{checkCount} checks</span>
          <span className="text-emerald-700">{healthyCount} healthy</span>
          <span className={failingCount > 0 ? "text-rose-700" : "text-muted-foreground"}>{failingCount} issues</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {snapshot ? <a className="max-w-48 truncate text-[11px] text-muted-foreground hover:text-foreground" href={snapshot.reachableAddress}>{snapshot.reachableAddress.replace(/^https?:\/\//, "")}</a> : null}
          <span aria-live="polite" data-health-freshness={freshness} title={checked} className={freshness === "stale" ? "flex items-center gap-1.5 text-[11px] text-amber-700 sm:hidden" : "flex items-center gap-1.5 text-[11px] text-muted-foreground sm:hidden"}><Clock3 className="size-3" />{compactChecked}</span>
          <span aria-live="polite" data-health-freshness={freshness} className={freshness === "stale" ? "hidden items-center gap-1.5 text-[11px] text-amber-700 sm:flex" : "hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex"}><Clock3 className="size-3" />{checked}</span>
          <Button aria-label="Refresh" title="Refresh" variant="ghost" size="icon-xs" onClick={() => void refresh()} disabled={refreshing}><RefreshCw aria-hidden="true" className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /></Button>
        </div>
      </div>
      {snapshot?.herdr ? <div className="flex items-center justify-between border-b px-4 py-2 text-xs"><span>Herdr</span><span>{snapshot.herdr.reachable ? "Running" : "Not running"}</span></div> : null}
      <HealthCheckSections snapshot={snapshot} />
    </SettingsLayout>
  );
}
