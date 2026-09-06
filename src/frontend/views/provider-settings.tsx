import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { ProviderListResponse } from "../../http/contracts/providers.js";
import { Button } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { SettingsLayout } from "../components/app/settings-layout.js";
import { StatusLight } from "../components/app/status-light.js";
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
      setView({ status: "failed", message: error instanceof Error ? error.message : "OpenCode provider configuration is not available." });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const providers = view.status === "loaded" ? view.data.providers : [];
  return <SettingsLayout title="Providers" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/providers", companyId)}>
    <div className="flex flex-wrap items-center gap-3 py-3">
      <span>OpenCode on the Forge host</span>
      <Button size="sm" variant="outline" disabled={view.status === "loading"} onClick={() => void load()}>Check configuration</Button>
    </div>
    <p>To sign in, run <code>opencode auth login</code> on the Forge host.</p>
    <p>Codex and Claude Code logins do not verify OpenCode access. This check does not send a model request.</p>
    <SettingsDataTable label="Providers" columns={columns}>
      <SettingsTableGroup label="Configured in OpenCode" count={providers.length} columnCount={columns.length}>
        {providers.map((provider) => <SettingsTableRow key={provider.id}>
          <SettingsTableCell>{provider.label}</SettingsTableCell>
          <SettingsTableCell><span className="inline-flex items-center gap-2"><StatusLight level="amber" label={`${provider.label}: configured, not tested`} />Configured</span></SettingsTableCell>
          <SettingsTableCell>{provider.modelCount}</SettingsTableCell>
          <SettingsTableCell>Not tested</SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup>
    </SettingsDataTable>
    <div className="pt-2" role="status" aria-busy={view.status === "loading"}>
      {view.status === "loading" ? <span className="inline-flex items-center gap-2"><Spinner /><span>Forge checks OpenCode configuration.</span></span> : null}
      {view.status === "failed" ? view.message : null}
      {view.status === "loaded" && providers.length === 0 ? "OpenCode reports no configured providers." : null}
      {view.status === "loaded" ? <p className="break-all">Host directory: <code>{view.data.directory}</code></p> : null}
    </div>
  </SettingsLayout>;
}
