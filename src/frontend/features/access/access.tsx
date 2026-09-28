import { startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { RemoteAccessPolicy } from "../../contracts/generated/RemoteAccessPolicy.js";
import type { CredentialSummary } from "../../contracts/generated/CredentialSummary.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { LoadingState } from "../../components/app/loading-state.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { PasskeysSection } from "../admin/passkeys-section.js";
import { SettingRow, SettingsContent, SettingsLayout, SettingsSection } from "../settings/settings-layout.js";
import { beginPasskey, finishPasskey, readAccess, removePasskey, renamePasskey, revokePasskey, saveAccess } from "./access-api.js";

type NetworkState = Awaited<ReturnType<NonNullable<typeof window.suplexApp>["networkAccess"]>>;
type OpenPolicy = Extract<RemoteAccessPolicy, { kind: "open" }>;

function OwnPasskey({ credential, reload, onError }: { credential: CredentialSummary; reload: () => Promise<void>; onError: (message: string) => void }): ReactElement {
  const [label, setLabel] = useState(credential.label);
  const [busy, setBusy] = useState(false);
  return <SettingRow label={credential.label} description={credential.rpId ? `Works at ${credential.rpId}` : "Created before Suplex recorded the passkey address."}>
    <div className="flex items-center gap-2">
      <Input aria-label={`Name for ${credential.label}`} value={label} onChange={(event) => setLabel(event.target.value)} />
      <Button variant="outline" size="sm" disabled={busy || !label.trim() || label === credential.label} onClick={() => { setBusy(true); onError(""); void renamePasskey(credential.id, label).then(reload).catch(() => onError("Suplex could not rename the passkey.")).finally(() => setBusy(false)); }}>Save</Button>
      <Button variant="destructive" size="sm" disabled={busy} onClick={() => { setBusy(true); onError(""); void removePasskey(credential.id).then(reload).catch(() => onError("Suplex could not remove the passkey.")).finally(() => setBusy(false)); }}>Remove</Button>
    </div>
  </SettingRow>;
}

export function AccessView(): ReactElement {
  const { user, currentCompany } = useCompanyContext();
  const [policy, setPolicy] = useState<RemoteAccessPolicy>();
  const [lastOpenPolicy, setLastOpenPolicy] = useState<OpenPolicy>();
  const [users, setUsers] = useState<Awaited<ReturnType<typeof readAccess>>["users"]>([]);
  const [credentials, setCredentials] = useState<Awaited<ReturnType<typeof readAccess>>["credentials"]>([]);
  const [httpsOrigin, setHttpsOrigin] = useState<string | null>(null);
  const [serverNetworkMode, setServerNetworkMode] = useState<"local" | "tailscale" | "all" | null>(null);
  const [network, setNetwork] = useState<NetworkState>({ managed: false });
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const companyId = currentCompany?.id ?? "";
  const reload = useCallback(async (): Promise<void> => {
    const response = await readAccess();
    setPolicy(response.policy); if (response.policy.kind === "open") setLastOpenPolicy(response.policy); setUsers(response.users); setCredentials(response.credentials); setHttpsOrigin(response.httpsOrigin); setServerNetworkMode(response.networkMode);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readAccess(controller.signal).then((response) => {
      setPolicy(response.policy); if (response.policy.kind === "open") setLastOpenPolicy(response.policy); setUsers(response.users); setCredentials(response.credentials); setHttpsOrigin(response.httpsOrigin); setServerNetworkMode(response.networkMode);
    }).catch(() => setError("Suplex could not load access settings."));
    void window.suplexApp?.networkAccess().then(setNetwork).catch(() => setError("Suplex could not read the desktop network setting."));
    return () => controller.abort();
  }, []);
  if (!user || user.role !== "admin") return <SettingsLayout title="Access" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/access", companyId)}><SettingsContent title="Access"><SettingsSection><SettingRow label="Access settings are not available" description="Only administrators can open this page." /></SettingsSection></SettingsContent></SettingsLayout>;
  if (!policy) return <SettingsLayout title="Access" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/access", companyId)}><SettingsContent title="Access">{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : <LoadingState />}</SettingsContent></SettingsLayout>;
  const activeUsers = users.filter((candidate) => candidate.status === "active");
  const own = credentials.filter((credential) => credential.userId === user.id && !credential.revokedAt);
  const requireHttps = policy.kind === "passkeys" || policy.requireHttps;
  const externalOrigin = policy.externalHttpsOrigin ?? "";
  const setOrigin = (value: string): void => {
    const externalHttpsOrigin = value || null;
    if (policy.kind === "open") {
      const next = { ...policy, externalHttpsOrigin };
      setPolicy(next);
      setLastOpenPolicy(next);
      return;
    }
    setPolicy({ ...policy, externalHttpsOrigin });
    setLastOpenPolicy((draft) => draft ? { ...draft, externalHttpsOrigin } : draft);
  };
  const save = async (): Promise<void> => { setBusy(true); setError(""); try { setPolicy((await saveAccess(policy)).policy); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Suplex could not save access settings."); } finally { setBusy(false); } };
  const enroll = async (): Promise<void> => { setBusy(true); setError(""); try { const offered = await beginPasskey(); const response = await startRegistration({ optionsJSON: offered.options }); await finishPasskey(offered.challengeId, label, response); setLabel(""); await reload(); } catch { setError("Suplex could not add the passkey."); } finally { setBusy(false); } };
  return <SettingsLayout title="Access" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/access", companyId)}><SettingsContent width="wide" title="Access" description="Control remote access to this Suplex host.">
    <SettingsSection title="Remote access">
      <SettingRow label="Network access" description={network.managed ? "The desktop app manages this host." : "Open this page from this Mac in the desktop app to change the network."}>
        <Select disabled={!network.managed || network.busy} value={network.managed ? network.mode : serverNetworkMode ?? "local"} onValueChange={(value) => { if (!window.suplexApp || (value !== "local" && value !== "tailscale" && value !== "all")) return; setError(""); void window.suplexApp.setNetworkAccess(value).then(setNetwork).catch(() => setError("Suplex could not change the desktop network setting.")); }}><SelectTrigger aria-label="Network access"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">This Mac only</SelectItem><SelectItem value="tailscale">Tailscale</SelectItem><SelectItem value="all">All networks</SelectItem></SelectContent></Select>
      </SettingRow>
      <SettingRow label="Require HTTPS" description="Remote HTTP requests are rejected. Configure Tailscale Serve or a loopback reverse proxy."><Checkbox aria-label="Require HTTPS" checked={requireHttps} disabled={policy.kind === "passkeys"} onCheckedChange={(checked) => { if (policy.kind === "open") { const next = { ...policy, requireHttps: checked }; setPolicy(next); setLastOpenPolicy(next); } }} /></SettingRow>
      <SettingRow label="HTTPS address" description="Use the public HTTPS origin for the proxy and passkeys."><Input aria-label="HTTPS address" placeholder="https://suplex.example.com" value={externalOrigin} onChange={(event) => setOrigin(event.target.value)} /></SettingRow>
      <SettingRow label="Require sign-in" description="Remote users sign in with a passkey. This setting also requires HTTPS."><Checkbox aria-label="Require sign-in" checked={policy.kind === "passkeys"} onCheckedChange={(checked) => { if (checked && policy.kind === "open") { setLastOpenPolicy(policy); setPolicy({ kind: "passkeys", externalHttpsOrigin: policy.externalHttpsOrigin }); } else if (!checked && policy.kind === "passkeys") { setPolicy(lastOpenPolicy ?? { kind: "open", requireHttps: true, defaultUserId: activeUsers[0]?.id ?? user.id, externalHttpsOrigin: policy.externalHttpsOrigin }); } }} /></SettingRow>
      {policy.kind === "open" ? <SettingRow label="Default user" description="Remote requests without a passkey use this account and its current permissions."><Select value={policy.defaultUserId} onValueChange={(value) => { if (value) { const next = { ...policy, defaultUserId: value }; setPolicy(next); setLastOpenPolicy(next); } }}><SelectTrigger aria-label="Default user"><SelectValue /></SelectTrigger><SelectContent>{activeUsers.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.displayName}</SelectItem>)}</SelectContent></Select></SettingRow> : null}
      <SettingRow label="Save access settings"><Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button></SettingRow>
      {httpsOrigin ? <SettingRow label="HTTPS access" description="Open this address before you add a passkey or require sign-in."><Button render={<a href={httpsOrigin} target="_blank" rel="noreferrer">Open HTTPS address</a>} variant="outline" size="sm" /></SettingRow> : null}
    </SettingsSection>
    <SettingsSection title="Your passkeys" description="Add passkeys at the HTTPS address that remote users will open.">
      <SettingRow label="Add a passkey" description={httpsOrigin ? `This passkey will work at ${new URL(httpsOrigin).hostname}.` : "Configure an HTTPS address first."}><div className="flex items-center gap-2"><Input aria-label="Passkey name" placeholder="MacBook Touch ID" value={label} onChange={(event) => setLabel(event.target.value)} /><Button size="sm" disabled={busy || !label.trim() || window.location.origin !== httpsOrigin} onClick={() => void enroll()}>Add</Button></div></SettingRow>
      {own.map((credential) => <OwnPasskey key={credential.id} credential={credential} reload={reload} onError={setError} />)}
    </SettingsSection>
    <PasskeysSection credentials={credentials.filter((credential) => credential.userId !== user.id)} users={users} currentUserId={user.id} pendingAction={pendingAction} onRevokeCredential={(credential) => { const action = `credential:${credential.id}`; if (pendingAction !== action) { setPendingAction(action); return; } setBusy(true); setError(""); void revokePasskey(credential.id).then(reload).then(() => setPendingAction("")).catch(() => setError("Suplex could not revoke the passkey.")).finally(() => setBusy(false)); }} onClearPendingAction={() => setPendingAction("")} />
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </SettingsContent></SettingsLayout>;
}
