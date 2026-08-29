import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SettingsLayout } from "../components/app/settings-layout.js";
import { StatusLight } from "../components/app/status-light.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableGroup, SettingsTableRow, type SettingsTableColumn } from "../components/app/settings-table.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { readJson, withCompany } from "../lib/api.js";

type ProviderCredential = { configured: boolean; maskedKey: string | null; lastTestedAt: string | null; lastTestSummary: string | null };
type Provider = { id: "codex" | "claude" | "openrouter"; label: string; harnessLabel: string; healthCheckId: string; credential: ProviderCredential };
type HealthCheck = { id: string; status: "healthy" | "warning" | "unhealthy"; summary: string };

const columns: SettingsTableColumn[] = [
  { key: "provider", label: "Provider", width: 170 }, { key: "harness", label: "Harness", width: 180 }, { key: "status", label: "Status", width: 82 }, { key: "detail", label: "Detail", width: 300 }, { key: "actions", label: "Actions", width: 420 },
];

function statusLevel(check: HealthCheck | undefined): "green" | "amber" | "red" {
  if (!check || check.status === "warning") return "amber";
  return check.status === "healthy" ? "green" : "red";
}

function lastTestDetail(credential: ProviderCredential): string | null {
  if (!credential.lastTestedAt) return credential.lastTestSummary;
  const date = new Date(credential.lastTestedAt);
  const testedAt = Number.isNaN(date.getTime()) ? credential.lastTestedAt : date.toLocaleString();
  return `${credential.lastTestSummary ?? "Key tested"} · ${testedAt}`;
}

export function ProviderSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [providers, setProviders] = useState<Provider[]>([]);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const load = useCallback(async () => {
    const [providerResponse, health] = await Promise.all([readJson<{ providers: Provider[] }>("/api/admin/providers"), readJson<{ checks: HealthCheck[] }>("/api/health")]);
    setProviders(providerResponse.providers); setChecks(health.checks);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const action = async (path: string, method: "PUT" | "DELETE" | "POST", body?: unknown): Promise<void> => {
    try {
      const result = await readJson<{ summary?: string }>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (result.summary) setMessage(result.summary);
      setKey(""); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider action failed"); }
  };
  return <SettingsLayout title="Providers" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/providers", companyId)}>
    <SettingsDataTable label="Providers" columns={columns} className="mt-5"><SettingsTableGroup label="Agent providers" count={providers.length} columnCount={columns.length}>{providers.map((provider) => {
      const check = checks.find((candidate) => candidate.id === provider.healthCheckId);
      const detail = lastTestDetail(provider.credential);
      return <SettingsTableRow key={provider.id}>
        <SettingsTableCell>{provider.label}</SettingsTableCell><SettingsTableCell className="text-muted-foreground">{provider.harnessLabel}</SettingsTableCell><SettingsTableCell><StatusLight level={statusLevel(check)} label={`${provider.label}: ${check?.summary ?? "Health status is unavailable"}`} /></SettingsTableCell>
        <SettingsTableCell className="text-muted-foreground"><span className="block truncate">{check?.summary ?? "Health status is unavailable"}</span>{provider.credential.maskedKey ? <span className="block truncate text-[11px]">{provider.credential.maskedKey}{detail ? ` · ${detail}` : ""}</span> : null}</SettingsTableCell>
        <SettingsTableCell>{provider.id === "openrouter" ? <div className="flex items-center gap-2"><Input aria-label="OpenRouter API key" type="password" value={key} onChange={(event) => setKey(event.target.value)} /><Button size="sm" disabled={!key.trim()} onClick={() => void action("/api/admin/providers/openrouter/credential", "PUT", { apiKey: key })}>Save</Button>{provider.credential.configured ? <Button size="sm" variant="outline" onClick={() => void action("/api/admin/providers/openrouter/credential", "DELETE")}>Clear</Button> : null}<Button size="sm" variant="outline" onClick={() => void action("/api/admin/providers/openrouter/test", "POST")}>Test</Button></div> : "Local CLI login"}</SettingsTableCell>
      </SettingsTableRow>;
    })}</SettingsTableGroup></SettingsDataTable>
    {message ? <p className="pt-2 text-[12px] text-muted-foreground" role="status">{message}</p> : null}
  </SettingsLayout>;
}
