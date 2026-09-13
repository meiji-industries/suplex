import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { ProviderListResponse } from "../../../http/contracts/providers.js";
import type { z } from "zod";
import type { ProviderInstanceListResponseSchema } from "../../../http/contracts/providers.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Badge } from "../../components/ui/badge.js";
import { Spinner } from "../../components/ui/spinner.js";
import { SettingsContent, SettingsLayout } from "./settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableGroup, SettingsTableRow, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJson, withCompany } from "../../lib/api.js";

const columns: SettingsTableColumn[] = [
  { key: "provider", label: "Provider", width: 180 },
  { key: "status", label: "Configuration", width: 150 },
  { key: "models", label: "Models", width: 80 },
  { key: "request", label: "Model request", width: 140 },
];

type ProviderView = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: ProviderListResponse };
type ProviderInstance = z.infer<typeof ProviderInstanceListResponseSchema>["instances"][number];

export function ProviderSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [view, setView] = useState<ProviderView>({ status: "loading" });
  const [instances, setInstances] = useState<ProviderInstance[]>([]);
  const [label, setLabel] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProviderInstance | null>(null);
  const load = useCallback(async () => {
    setView({ status: "loading" });
    try {
        const [providers, instanceList] = await Promise.all([readJson<ProviderListResponse>("/api/admin/providers"), readJson<{ instances: ProviderInstance[] }>("/api/admin/provider-instances")]);
        setInstances(instanceList.instances);
        setView({ status: "loaded", data: providers });
    } catch (error) {
      setView({ status: "failed", message: error instanceof Error ? error.message : "Provider configuration is not available." });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const providers = view.status === "loaded" ? view.data.providers : [];
  const create = async (): Promise<void> => { if (!label.trim()) return; await readJson("/api/admin/provider-instances", { method: "POST", body: JSON.stringify({ provider: "claude-code", label }) }); setLabel(""); await load(); };
  const remove = async (id: string): Promise<void> => { await readJson(`/api/admin/provider-instances/${encodeURIComponent(id)}`, { method: "DELETE" }); setDeleteTarget(null); await load(); };
  return <SettingsLayout title="Providers" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/providers", companyId)}>
    <SettingsContent>
     <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">OpenCode, Claude Code, and Devin CLI on the Forge host</h2>
      <Button size="sm" variant="outline" disabled={view.status === "loading"} onClick={() => void load()}>Check configuration</Button>
      </div>
       <div className="space-y-1 text-xs text-muted-foreground">
        <p>To sign in, run <code>opencode auth login</code> or <code>claude auth login</code> on the Forge host.</p>
        <p>A Claude Code login does not verify OpenCode access. This check does not send a model request.</p>
       </div>
       <div className="flex max-w-md gap-2"><Input value={label} onChange={event => setLabel(event.target.value)} placeholder="New Claude Code instance" /><Button size="sm" onClick={() => void create()} disabled={!label.trim()}>New instance</Button></div>
    </div>
    <SettingsDataTable label="Providers" columns={columns}>
      <SettingsTableGroup label="Providers on the Forge host" count={providers.length} columnCount={columns.length}>
        {providers.map((provider) => <SettingsTableRow key={provider.id}>
          <SettingsTableCell>{provider.label}</SettingsTableCell>
          <SettingsTableCell>{provider.status === "configured"
            ? <Badge variant="secondary" aria-label={`${provider.label}: configured, not tested`}>Configured</Badge>
            : <div className="space-y-1"><Badge variant="destructive" aria-label={`${provider.label}: not installed`}>Not installed</Badge><p className="text-xs text-muted-foreground">{provider.id === "devin" ? <>Run <code>curl -fsSL https://cli.devin.ai/install.sh | bash</code> or set <code>FORGE_DEVIN_COMMAND</code>.</> : <>Install it or set <code>FORGE_CLAUDE_COMMAND</code>.</>}</p></div>}</SettingsTableCell>
          <SettingsTableCell>{provider.modelCount}</SettingsTableCell>
          <SettingsTableCell>Not tested</SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup>
     </SettingsDataTable>
     {instances.length ? <div className="mt-4 space-y-2 text-xs"><h3 className="font-semibold">Local instances</h3>{instances.map(instance => <div key={instance.id} className="flex flex-wrap items-center gap-2"><span>{instance.label}</span><Badge variant={instance.readiness.status === "healthy" ? "secondary" : instance.readiness.status === "unhealthy" ? "destructive" : "outline"}>{instance.readiness.summary}</Badge><code>CLAUDE_CONFIG_DIR='{instance.homeDirectory}' claude auth login</code><Button size="sm" variant="outline" onClick={() => setDeleteTarget(instance)}>Delete</Button></div>)}</div> : null}
     <AlertDialog open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {deleteTarget?.label}?</AlertDialogTitle><AlertDialogDescription>This deletes the local provider configuration. Agent profiles using it must be changed first.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (deleteTarget) void remove(deleteTarget.id); }}>Delete instance</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <div className="mt-3 space-y-2 text-xs text-muted-foreground" role="status" aria-busy={view.status === "loading"}>
      {view.status === "loading" ? <span className="inline-flex items-center gap-2"><Spinner /><span>Please wait.</span></span> : null}
      {view.status === "failed" ? <p role="alert">{view.message}</p> : null}
      {view.status === "loaded" && providers.length === 0 ? <p>No configured providers were found.</p> : null}
      {view.status === "loaded" ? <p className="break-words">Host directory: <code>{view.data.directory}</code></p> : null}
    </div>
    </SettingsContent>
  </SettingsLayout>;
}
