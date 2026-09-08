import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { ProviderListResponse } from "../../http/contracts/providers.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Spinner } from "../components/ui/spinner.js";
import { SettingsContent, SettingsLayout } from "../components/app/settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableGroup, SettingsTableRow, type SettingsTableColumn } from "../components/app/settings-table.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { readJson, withCompany } from "../lib/api.js";

const columns: SettingsTableColumn[] = [
  { key: "provider", label: "Provider", width: 180 },
  { key: "status", label: "Configuration", width: 150 },
  { key: "models", label: "Models", width: 80 },
  { key: "request", label: "Model request", width: 140 },
];

type ProviderView = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: ProviderListResponse };

export function ProviderSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [view, setView] = useState<ProviderView>({ status: "loading" });
  const load = useCallback(async () => {
    setView({ status: "loading" });
    try {
      setView({ status: "loaded", data: await readJson<ProviderListResponse>("/api/admin/providers") });
    } catch (error) {
      setView({ status: "failed", message: error instanceof Error ? error.message : "Provider configuration is not available." });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const providers = view.status === "loaded" ? view.data.providers : [];
  return <SettingsLayout title="Providers" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/providers", companyId)}>
    <SettingsContent>
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">OpenCode and Claude Code on the Forge host</h2>
      <Button size="sm" variant="outline" disabled={view.status === "loading"} onClick={() => void load()}>Check configuration</Button>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>To sign in, run <code>opencode auth login</code> or <code>claude auth login</code> on the Forge host.</p>
        <p>A Claude Code login does not verify OpenCode access. This check does not send a model request.</p>
      </div>
    </div>
    <SettingsDataTable label="Providers" columns={columns}>
      <SettingsTableGroup label="Configured on the host" count={providers.length} columnCount={columns.length}>
        {providers.map((provider) => <SettingsTableRow key={provider.id}>
          <SettingsTableCell>{provider.label}</SettingsTableCell>
          <SettingsTableCell><Badge variant="secondary" aria-label={`${provider.label}: configured, not tested`}>Configured</Badge></SettingsTableCell>
          <SettingsTableCell>{provider.modelCount}</SettingsTableCell>
          <SettingsTableCell>Not tested</SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup>
    </SettingsDataTable>
    <div className="mt-3 space-y-2 text-xs text-muted-foreground" role="status" aria-busy={view.status === "loading"}>
      {view.status === "loading" ? <span className="inline-flex items-center gap-2"><Spinner /><span>Please wait.</span></span> : null}
      {view.status === "failed" ? <p role="alert">{view.message}</p> : null}
      {view.status === "loaded" && providers.length === 0 ? <p>No configured providers were found.</p> : null}
      {view.status === "loaded" ? <p className="break-words">Host directory: <code>{view.data.directory}</code></p> : null}
    </div>
    </SettingsContent>
  </SettingsLayout>;
}
