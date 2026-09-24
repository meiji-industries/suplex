import { CheckCircle2, CircleAlert, RefreshCw, Server, XCircle } from "lucide-react";
import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { connectionRoute, getSystemHealthLevel, HealthCheckSections, useSystemHealth } from "../../components/app/system-health.js";
import { isOwnedHealthCheck, isRequiredHealthCheck } from "../../../platform/health-contract.js";
import { SettingsLayout } from "../settings/settings-layout.js";
import { UpdateSettings } from "../settings/update-settings.js";
import { withCompany } from "../../lib/api.js";

export function Dashboard(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const { snapshot, freshness, refreshing, refresh } = useSystemHealth();
  const companyId = currentCompany?.id ?? "";
  const healthyCount = snapshot?.checks.filter(check => check.status === "healthy").length ?? 0;
  const checkCount = snapshot?.checks.length ?? 0;
  const failingCount = checkCount - healthyCount;
  const level = getSystemHealthLevel(snapshot, freshness);

  return <SettingsLayout title="Host health" companyId={companyId} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/health", companyId)}>
    <div className="flex flex-wrap items-center gap-3 border-b py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40"><Server className="size-4" /></div>
      <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{snapshot?.reachableAddress ?? window.location.origin}</p><p className="text-xs text-muted-foreground">Suplex host · {connectionRoute(snapshot?.reachableAddress ?? window.location.origin)}</p></div>
      <Button aria-label="Refresh" title="Refresh" variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}><RefreshCw aria-hidden="true" className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />{refreshing ? "Check in progress" : "Check again"}</Button>
    </div>
    <section aria-label="Host health overview" className="flex flex-wrap items-center justify-between gap-5 py-5">
      <div className="min-w-0 flex-1"><div className="mb-3 flex flex-wrap items-center gap-3"><span className="flex items-baseline gap-2"><strong className="text-2xl font-semibold tabular-nums">{healthyCount}<span className="text-lg font-normal text-muted-foreground"> / {checkCount}</span></strong><span className="text-xs text-muted-foreground">checks healthy</span></span><Badge variant={level === "red" ? "destructive" : "outline"}>{level === "red" ? <XCircle /> : level === "amber" ? <CircleAlert /> : <CheckCircle2 />}{level === "red" ? "Host needs attention" : level === "amber" ? "Check the host" : "Healthy"}</Badge></div>
        <div role="img" aria-label={`${healthyCount} healthy checks, ${failingCount} issues`} className="flex max-w-md gap-1">{snapshot?.checks.map(check => <span key={check.id} title={`${check.label}: ${check.status}`} className={check.status === "healthy" ? "h-2 flex-1 rounded-sm bg-emerald-600" : check.status === "warning" || !isRequiredHealthCheck(check.id) && !isOwnedHealthCheck(check.id) ? "h-2 flex-1 rounded-sm bg-amber-500" : "h-2 flex-1 rounded-sm bg-destructive"} />)}</div>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-emerald-600" />{healthyCount} healthy</span><span className="flex items-center gap-1.5"><CircleAlert className="size-3.5" />{failingCount} issues</span></div>
      </div>
    </section>
      {snapshot?.herdr ? <div className="flex items-center justify-between border-b px-4 py-2 text-xs"><span>Herdr</span><span>{snapshot.herdr.reachable ? "Running" : "Not running"}</span></div> : null}
      <HealthCheckSections snapshot={snapshot} />
      <div id="updates" className="px-4 pt-5 lg:px-6"><UpdateSettings /></div>
    </SettingsLayout>;
}
