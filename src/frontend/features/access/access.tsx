import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { AccessSettings } from "../../contracts/generated/AccessSettings.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { LoadingState } from "../../components/app/loading-state.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SettingRow, SettingsContent, SettingsLayout, SettingsSection } from "../settings/settings-layout.js";
import { readAccess, saveAccess } from "./access-api.js";

type NetworkState = Awaited<ReturnType<NonNullable<typeof window.suplexApp>["networkAccess"]>>;
const networkModeLabels = { local: "This Mac only", tailscale: "Tailscale", all: "Local network" } as const;

export function AccessView(): ReactElement {
  const { user, currentCompany } = useCompanyContext();
  const [policy, setPolicy] = useState<AccessSettings>();
  const [httpsOrigin, setHttpsOrigin] = useState<string | null>(null);
  const [serverNetworkMode, setServerNetworkMode] = useState<"local" | "tailscale" | "all" | null>(null);
  const [network, setNetwork] = useState<NetworkState>({ managed: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const companyId = currentCompany?.id ?? "";
  const reload = useCallback(async (): Promise<void> => {
    const response = await readAccess();
    setPolicy(response.settings); setHttpsOrigin(response.httpsOrigin); setServerNetworkMode(response.networkMode);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const unsubscribe = window.suplexApp?.onNetworkAccessChange(setNetwork);
    void readAccess(controller.signal).then((response) => {
      setPolicy(response.settings); setHttpsOrigin(response.httpsOrigin); setServerNetworkMode(response.networkMode);
    }).catch(() => setError("Suplex could not load access settings."));
    void window.suplexApp?.networkAccess().then(setNetwork).catch(() => setError("Suplex could not read the desktop network setting."));
    return () => { controller.abort(); unsubscribe?.(); };
  }, []);
  if (!user || user.role !== "admin") return <SettingsLayout title="Remote Access" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/access", companyId)}><SettingsContent title="Remote Access"><SettingsSection><SettingRow label="Access settings are not available" description="Only administrators can open this page." /></SettingsSection></SettingsContent></SettingsLayout>;
  if (!policy) return <SettingsLayout title="Remote Access" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/access", companyId)}><SettingsContent title="Remote Access">{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : <LoadingState />}</SettingsContent></SettingsLayout>;
  const externalOrigin = policy.externalHttpsOrigin ?? "";
  const setOrigin = (value: string): void => setPolicy({ externalHttpsOrigin: value || null });
  const save = async (): Promise<void> => { setBusy(true); setError(""); try { setPolicy((await saveAccess(policy)).settings); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Suplex could not save access settings."); } finally { setBusy(false); } };
  const restartNetwork = async (): Promise<void> => {
    if (!window.suplexApp) return;
    setError("");
    try {
      setNetwork(await window.suplexApp.restartNetworkAccess());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not restart network access.");
    }
  };
  return <SettingsLayout title="Remote Access" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/access", companyId)}><SettingsContent width="wide" title="Remote Access" description="Members must connect over Tailscale or the same local network. Remote access requires HTTPS and a Suplex account.">
    <SettingsSection title="Remote access">
      <SettingRow label="Network access" description={network.managed ? network.pending ? network.active === null ? "Suplex is stopped. Start Suplex to apply this setting." : `Active mode: ${networkModeLabels[network.active]}.` : "The desktop app manages this host." : "Open this page from this Mac in the desktop app to change the network."}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Select disabled={!network.managed || network.busy} value={network.managed ? network.preference : serverNetworkMode ?? "local"} onValueChange={(value) => { if (!window.suplexApp || (value !== "local" && value !== "tailscale" && value !== "all")) return; setError(""); void window.suplexApp.saveNetworkAccessPreference(value).then(setNetwork).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Suplex could not save the desktop network setting.")); }}><SelectTrigger aria-label="Network access"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">This Mac only</SelectItem><SelectItem value="tailscale">Tailscale</SelectItem><SelectItem value="all">Local network</SelectItem></SelectContent></Select>
          {network.managed && network.pending ? <><Badge variant="amber"><CircleAlert />Restart required</Badge>{network.active !== null ? <Button size="sm" disabled={network.busy} onClick={() => void restartNetwork()}>Restart</Button> : null}</> : null}
        </div>
      </SettingRow>
      <SettingRow label="HTTPS address" description="Tailscale provides HTTPS automatically. For a local network, configure an HTTPS reverse proxy."><Input aria-label="HTTPS address" placeholder="https://suplex.example.com" value={externalOrigin} onChange={(event) => setOrigin(event.target.value)} /></SettingRow>
      <SettingRow label="Save access settings"><Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button></SettingRow>
      {httpsOrigin ? <SettingRow label="HTTPS access" ><Button nativeButton={false} render={<a href={httpsOrigin} target="_blank" rel="noreferrer">Open HTTPS address</a>} variant="outline" size="sm" /></SettingRow> : null}
    </SettingsSection>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </SettingsContent></SettingsLayout>;
}
