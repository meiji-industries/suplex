import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { z } from "zod";
import { Server } from "lucide-react";
import type { CliProviderSummary, EndpointProviderSummary, ProviderConnection, ProviderInstanceListResponseSchema, ProviderListResponse } from "../../contracts/providers.js";
import type { LocalEndpointTestStatus } from "../../contracts/generated/LocalEndpointTestStatus.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Badge } from "../../components/ui/badge.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field.js";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
import { SettingsContent, SettingsLayout } from "./settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableLoading, SettingsTableRow, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import { ProviderLoginTerminal, useProviderLogin } from "./provider-login.js";
import { ProviderInstallCommand } from "../../components/app/provider-installation.js";
import { ProviderIcon } from "../../components/app/provider-icons.js";
import { CHECK_STATUS_LABELS, LOCAL_ENDPOINT_TITLE, useLocalEndpointForm } from "./local-endpoint-form.js";
import { deleteLocalEndpoint } from "./lib/local-endpoint-api.js";

// The groups show the scope, so there is no Scope column. Configuration takes the remaining width.
const columns: SettingsTableColumn[] = [
  { key: "provider", label: "Provider", width: 190 },
  { key: "configuration", label: "Configuration" },
  { key: "models", label: "Models", width: 80, align: "center" },
  { key: "status", label: "Status", width: 140 },
  { key: "actions", width: 150 },
];

// One height for every row: a 32px button plus the cell padding and the divider.
const rowHeight = "h-[53px]";

type ProviderView = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: ProviderListResponse };
type ProviderInstance = z.infer<typeof ProviderInstanceListResponseSchema>["instances"][number];
type DeleteTarget = { kind: "instance"; id: string; label: string } | { kind: "endpoint"; id: string; label: string };
type AddKind = "instance" | "endpoint";

const CHECK_BADGES: Record<LocalEndpointTestStatus, "secondary" | "outline" | "destructive"> = { "model-listed": "secondary", reachable: "outline", error: "destructive" };

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
  const [addKind, setAddKind] = useState<AddKind>("instance");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
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
  const endpointForm = useLocalEndpointForm(() => load(true));
  useEffect(() => { void load(); }, [load]);
  const rows = view.status === "loaded" ? view.data.providers : [];
  // A row without `kind` is a tool row.
  const providers = rows.filter((row): row is CliProviderSummary => row.kind !== "local-endpoint");
  const endpoints = rows.filter((row): row is EndpointProviderSummary => row.kind === "local-endpoint");
  const busyAdding = busy || endpointForm.busy !== null;
  const closeAdd = (): void => { setAddOpen(false); setLabel(""); setAddKind("instance"); endpointForm.reset(); };
  const create = async (): Promise<void> => {
    if (addKind === "endpoint") {
      if (await endpointForm.add()) closeAdd();
      return;
    }
    if (!label.trim()) return;
    setBusy(true);
    setError("");
    try {
      await readJsonUnchecked("/api/admin/provider-instances", { method: "POST", body: JSON.stringify({ provider: "claude-code", label }) });
      closeAdd();
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not add the provider.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (target: DeleteTarget): Promise<void> => {
    setDeleteTarget(null);
    setError("");
    try {
      if (target.kind === "endpoint") await deleteLocalEndpoint(target.id);
      else await readJsonUnchecked(`/api/admin/provider-instances/${encodeURIComponent(target.id)}`, { method: "DELETE" });
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
     {providers.some(provider => provider.status !== "configured") ? <p className="mb-3 text-xs text-muted-foreground">Install a missing provider on the machine that runs Suplex. Then select Refresh.</p> : null}
    <SettingsDataTable label="Providers" columns={columns}>
      {view.status === "loading" ? <SettingsTableLoading columnCount={columns.length} /> : <SettingsTableGroup label="System" count={providers.length} columnCount={columns.length}>
        {providers.map((provider) => <SettingsTableRow key={`provider:${provider.id}`} className={rowHeight}>
          <SettingsTableCell><span className="flex min-w-0 items-center gap-2"><ProviderIcon provider={provider.id} tone="mono" /><span className="truncate font-medium">{provider.label}</span></span></SettingsTableCell>
          <SettingsTableCell>{provider.status === "configured"
            ? <Badge variant="secondary">Configured</Badge>
            : <div className="flex min-w-0 items-center gap-2"><Badge variant="destructive">Not installed</Badge><ProviderInstallCommand provider={provider.id} /></div>}</SettingsTableCell>
          <SettingsTableCell className="text-center tabular-nums">{provider.modelCount}</SettingsTableCell>
          <SettingsTableCell><ConnectionBadge connection={provider.connection} /></SettingsTableCell>
          <SettingsTableCell>{provider.connection.status !== "connected" ? loginButton(`provider:${provider.id}`, provider.label, `/api/admin/providers/${encodeURIComponent(provider.id)}/login`) : null}</SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup>}
      {instances.length ? <SettingsTableGroup label="Company" count={instances.length} columnCount={columns.length}>
        {instances.map((instance) => <SettingsTableRow key={`instance:${instance.id}`} className={rowHeight}>
          <SettingsTableCell><span className="flex min-w-0 items-center gap-2"><ProviderIcon provider={instance.provider} tone="mono" /><span className="truncate font-medium">{instance.label}</span></span></SettingsTableCell>
          <SettingsTableCell className="truncate text-muted-foreground" title={instance.homeDirectory}>{providers.find(provider => provider.id === instance.provider)?.label ?? instance.provider}</SettingsTableCell>
          <SettingsTableCell className="text-center tabular-nums">{providers.find(provider => provider.id === instance.provider)?.modelCount ?? 0}</SettingsTableCell>
          <SettingsTableCell><ConnectionBadge connection={instance.connection} /></SettingsTableCell>
          <SettingsTableCell><div className="flex gap-1">
            {instance.connection.status !== "connected" ? loginButton(`instance:${instance.id}`, instance.label, `/api/admin/provider-instances/${encodeURIComponent(instance.id)}/login`) : null}
            <Button size="sm" variant="outline" onClick={() => { setError(""); setDeleteTarget({ kind: "instance", id: instance.id, label: instance.label }); }}>Delete</Button>
          </div></SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup> : null}
      {endpoints.length ? <SettingsTableGroup label="Endpoints" count={endpoints.length} columnCount={columns.length}>
        {endpoints.map((endpoint) => <SettingsTableRow key={`endpoint:${endpoint.id}`} className={rowHeight}>
          <SettingsTableCell><span className="flex min-w-0 items-center gap-2"><Server className="size-4 shrink-0" aria-hidden="true" /><span className="truncate font-medium">{endpoint.label}</span></span></SettingsTableCell>
          <SettingsTableCell className="truncate text-muted-foreground" title={endpoint.endpoint.baseUrl}>{endpoint.endpoint.modelId} · {endpoint.endpoint.baseUrl}</SettingsTableCell>
          <SettingsTableCell className="text-center tabular-nums">{endpoint.modelCount}</SettingsTableCell>
          <SettingsTableCell><ConnectionBadge connection={endpoint.connection} /></SettingsTableCell>
          <SettingsTableCell><Button size="sm" variant="outline" aria-label={`Delete ${endpoint.label}`} onClick={() => { setError(""); setDeleteTarget({ kind: "endpoint", id: endpoint.id, label: endpoint.label }); }}>Delete</Button></SettingsTableCell>
        </SettingsTableRow>)}
      </SettingsTableGroup> : null}
      {view.status === "loaded" && rows.length === 0 && instances.length === 0 ? <SettingsTableEmpty columnCount={columns.length}>No providers were found.</SettingsTableEmpty> : null}
     </SettingsDataTable>
     <AlertDialog open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {deleteTarget?.label}?</AlertDialogTitle><AlertDialogDescription>{deleteTarget?.kind === "endpoint" ? "Suplex deletes the endpoint and its API key. Agents cannot use its model after that." : "This deletes the local provider configuration. Change agent profiles and project provider restrictions that use it first."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (deleteTarget) void remove(deleteTarget); }}>{deleteTarget?.kind === "endpoint" ? "Delete the endpoint" : "Delete instance"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
     <Dialog open={addOpen} onOpenChange={open => { if (busyAdding) return; if (open) setAddOpen(true); else closeAdd(); }}>
      <DialogContent showCloseButton={!busyAdding}>
       <DialogHeader><DialogTitle>Add Provider</DialogTitle><DialogDescription>{addKind === "endpoint" ? "Suplex runs the model of an OpenAI-compatible server with OpenCode, Pi, or OMP." : "Suplex creates a local Claude Code instance with its own sign-in."}</DialogDescription></DialogHeader>
       <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <FieldGroup>
         <FieldSet disabled={busyAdding}>
          <FieldLegend variant="label">Provider</FieldLegend>
          <RadioGroup value={addKind} onValueChange={value => { setAddKind(value === "endpoint" ? "endpoint" : "instance"); setError(""); }}>
           <Field orientation="horizontal"><RadioGroupItem id="provider-kind-instance" value="instance" /><FieldLabel htmlFor="provider-kind-instance">Claude Code instance</FieldLabel></Field>
           <Field orientation="horizontal"><RadioGroupItem id="provider-kind-endpoint" value="endpoint" /><FieldLabel htmlFor="provider-kind-endpoint">{LOCAL_ENDPOINT_TITLE}</FieldLabel></Field>
          </RadioGroup>
         </FieldSet>
         {addKind === "instance"
          ? <Field><FieldLabel htmlFor="provider-instance-label">Name</FieldLabel><Input id="provider-instance-label" autoFocus disabled={busy} value={label} onChange={event => setLabel(event.target.value)} placeholder="Work laptop" required /></Field>
          : <>
           <Field><FieldLabel htmlFor="provider-endpoint-url">Base URL</FieldLabel><Input id="provider-endpoint-url" autoComplete="off" disabled={busyAdding} value={endpointForm.fields.baseUrl} onChange={event => endpointForm.change({ baseUrl: event.target.value })} placeholder="http://127.0.0.1:8080/v1" required /></Field>
           <Field><FieldLabel htmlFor="provider-endpoint-key">API key (optional)</FieldLabel><Input id="provider-endpoint-key" type="password" autoComplete="off" disabled={busyAdding} value={endpointForm.fields.apiKey} onChange={event => endpointForm.change({ apiKey: event.target.value })} /></Field>
           <Field><FieldLabel htmlFor="provider-endpoint-model">Model id</FieldLabel><Input id="provider-endpoint-model" autoComplete="off" disabled={busyAdding} value={endpointForm.fields.modelId} onChange={event => endpointForm.change({ modelId: event.target.value })} placeholder="qwen3-coder" required /></Field>
           {endpointForm.check ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant={CHECK_BADGES[endpointForm.check.status]}>{CHECK_STATUS_LABELS[endpointForm.check.status]}</Badge>{endpointForm.check.summary}</p> : null}
           {endpointForm.error ? <p role="alert" className="text-xs text-destructive">{endpointForm.error}</p> : null}
          </>}
         <DialogFooter>
          <DialogClose disabled={busyAdding} render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
          {addKind === "endpoint" ? <Button type="button" variant="outline" size="sm" disabled={busyAdding || !endpointForm.valid} onClick={() => void endpointForm.runCheck()}>Check</Button> : null}
          <NewButton type="submit" disabled={busyAdding || (addKind === "endpoint" ? !endpointForm.valid : !label.trim())}>Add Provider</NewButton>
         </DialogFooter>
        </FieldGroup>
       </form>
      </DialogContent>
     </Dialog>
    {view.status === "failed" ? <p role="alert" className="mt-3 text-xs text-muted-foreground">{view.message}</p> : null}
    </SettingsContent>
    <ProviderLoginTerminal login={login} onClose={() => void closeLogin()} />
  </SettingsLayout>;
}
