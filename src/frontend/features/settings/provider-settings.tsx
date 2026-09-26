import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { z } from "zod";
import type { ProviderConnection, ProviderInstanceListResponseSchema, ProviderListResponse } from "../../contracts/providers.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Badge } from "../../components/ui/badge.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { SettingsContent, SettingsLayout } from "./settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableLoading, SettingsTableRow, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import { ProviderLoginTerminal, useProviderLogin } from "./provider-login.js";

const columns: SettingsTableColumn[] = [
  { key: "provider", label: "Provider", width: 170 },
  { key: "scope", label: "Scope", width: 80 },
  { key: "configuration", label: "Configuration", width: 150 },
  { key: "models", label: "Models", width: 70 },
  { key: "status", label: "Status", width: 110 },
  { key: "actions", width: 150 },
];

type ProviderView = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: ProviderListResponse };
type ProviderInstance = z.infer<typeof ProviderInstanceListResponseSchema>["instances"][number];

function ConnectionBadge({ connection }: { connection: ProviderConnection }): ReactElement {
  if (connection.status === "connected") return <Badge variant="secondary" title={connection.summary}>Connected</Badge>;
  if (connection.status === "not-connected") return <Badge variant="destructive" title={connection.summary}>Not Connected</Badge>;
  return <Badge variant="outline" title={connection.summary}>Unknown</Badge>;
}

export function ProviderSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [view, setView] = useState<ProviderView>({ status: "loading" });
  const [instances, setInstances] = useState<ProviderInstance[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProviderInstance | null>(null);
  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setView({ status: "loading" });
    try {
      const [providers, instanceList] = await Promise.all([readJsonUnchecked<ProviderListResponse>("/api/admin/providers"), readJsonUnchecked<{ instances: ProviderInstance[] }>("/api/admin/provider-instances")]);
      setInstances(instanceList.instances);
      setView({ status: "loaded", data: providers });
    } catch (reason) {
      if (!silent) setView({ status: "failed", message: reason instanceof Error ? reason.message : "Provider configuration is not available." });
    }
  }, []);
  const { login, loginPending, startLogin, closeLogin } = useProviderLogin({ reload: load });
  useEffect(() => { void load(); }, [load]);
  const providers = view.status === "loaded" ? view.data.providers : [];
  const create = async (): Promise<void> => {
    if (!label.trim()) return;
    setBusy(true);
    setError("");
    try {
      await readJsonUnchecked("/api/admin/provider-instances", { method: "POST", body: JSON.stringify({ provider: "claude-code", label }) });
      setLabel("");
      setAddOpen(false);
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not add the provider.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string): Promise<void> => {
    setDeleteTarget(null);
    setError("");
    try {
      await readJsonUnchecked(`/api/admin/provider-instances/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not delete the provider.");
    }
  };
  const loginButton = (key: string, rowLabel: string, url: string): ReactElement => (
    <Button size="sm" variant="outline" aria-label={`Login to ${rowLabel}`} disabled={loginPending !== null} onClick={() => void startLogin(key, rowLabel, url).catch(reason => setError(reason instanceof Error ? reason.message : "Suplex could not open a sign-in pane."))}>{loginPending === key ? "Opening" : "Login"}</Button>
  );
  return <SettingsLayout title="Providers" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/providers", companyId)}>
    <SettingsContent width="wide" title="Providers" description="Suplex runs agents with these provider logins. Add a named login to give a project its own account." actions={<>
      <Button size="sm" variant="outline" disabled={view.status === "loading"} onClick={() => void load()}>Refresh</Button>
      <NewButton onClick={() => { setError(""); setAddOpen(true); }}>Add Provider</NewButton>
     </>}>
     {error ? <p role="alert" className="mb-3 text-xs text-destructive">{error}</p> : null}
    <SettingsDataTable label="Providers" columns={columns}>
      {view.status === "loading" ? <SettingsTableLoading columnCount={columns.length} /> : <SettingsTableGroup label="System" count={providers.length} columnCount={columns.length}>
        {providers.map((provider) => <SettingsTableRow key={`provider:${provider.id}`}>
          <SettingsTableCell className="truncate font-medium">{provider.label}</SettingsTableCell>
          <SettingsTableCell className="text-muted-foreground">System</SettingsTableCell>
          <SettingsTableCell>{provider.status === "configured"
            ? <Badge variant="secondary">Configured</Badge>
            : <div className="space-y-1"><Badge variant="destructive">Not installed</Badge><p className="text-xs text-muted-foreground">Set <code>{{ opencode: "SUPLEX_OPENCODE_COMMAND", devin: "SUPLEX_DEVIN_COMMAND", codex: "SUPLEX_CODEX_COMMAND", "claude-code": "SUPLEX_CLAUDE_COMMAND" }[provider.id]}</code>.</p></div>}</SettingsTableCell>
          <SettingsTableCell>{provider.modelCount}</SettingsTableCell>
          <SettingsTableCell><ConnectionBadge connection={provider.connection} /></SettingsTableCell>
          <SettingsTableCell>{provider.connection.status !== "connected" ? loginButton(`provider:${provider.id}`, provider.label, `/api/admin/providers/${encodeURIComponent(provider.id)}/login`) : null}</SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup>}
      {instances.length ? <SettingsTableGroup label="Company" count={instances.length} columnCount={columns.length}>
        {instances.map((instance) => <SettingsTableRow key={`instance:${instance.id}`}>
          <SettingsTableCell className="truncate font-medium">{instance.label}</SettingsTableCell>
          <SettingsTableCell className="text-muted-foreground">Company</SettingsTableCell>
          <SettingsTableCell className="truncate text-muted-foreground" title={instance.homeDirectory}>{instance.provider}</SettingsTableCell>
          <SettingsTableCell>{providers.find(provider => provider.id === instance.provider)?.modelCount ?? 0}</SettingsTableCell>
          <SettingsTableCell><ConnectionBadge connection={instance.connection} /></SettingsTableCell>
          <SettingsTableCell><div className="flex gap-1">
            {instance.connection.status !== "connected" ? loginButton(`instance:${instance.id}`, instance.label, `/api/admin/provider-instances/${encodeURIComponent(instance.id)}/login`) : null}
            <Button size="sm" variant="outline" onClick={() => { setError(""); setDeleteTarget(instance); }}>Delete</Button>
          </div></SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup> : null}
      {view.status === "loaded" && providers.length === 0 && instances.length === 0 ? <SettingsTableEmpty columnCount={columns.length}>No providers were found.</SettingsTableEmpty> : null}
     </SettingsDataTable>
     <AlertDialog open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {deleteTarget?.label}?</AlertDialogTitle><AlertDialogDescription>This deletes the local provider configuration. Change agent profiles and project provider restrictions that use it first.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (deleteTarget) void remove(deleteTarget.id); }}>Delete instance</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
     <Dialog open={addOpen} onOpenChange={open => { if (busy) return; setAddOpen(open); if (!open) setLabel(""); }}>
      <DialogContent showCloseButton={!busy}>
       <DialogHeader><DialogTitle>Add Provider</DialogTitle><DialogDescription>Suplex creates a local Claude Code instance with its own sign-in.</DialogDescription></DialogHeader>
       <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <FieldGroup>
         <Field><FieldLabel htmlFor="provider-instance-label">Name</FieldLabel><Input id="provider-instance-label" autoFocus disabled={busy} value={label} onChange={event => setLabel(event.target.value)} placeholder="Work laptop" required /></Field>
         <DialogFooter><DialogClose disabled={busy} render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><NewButton type="submit" disabled={busy || !label.trim()}>Add Provider</NewButton></DialogFooter>
        </FieldGroup>
       </form>
      </DialogContent>
     </Dialog>
    {view.status === "failed" ? <p role="alert" className="mt-3 text-xs text-muted-foreground">{view.message}</p> : null}
    </SettingsContent>
    <ProviderLoginTerminal login={login} onClose={() => void closeLogin()} />
  </SettingsLayout>;
}
