import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Switch } from "../../components/ui/switch.js";
import { SettingRow } from "../settings/settings-layout.js";
import { base64UrlToBytes, deleteWebPushSubscription, readWebPushKey, saveWebPushSubscription } from "./lib/web-push-api.js";

const LABEL = "Notifications on this device";

type PushState = "unsupported" | "denied" | "off" | "on";

async function readState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  return subscription ? "on" : "off";
}

async function subscribe(): Promise<void> {
  if (await Notification.requestPermission() !== "granted") return;
  const { publicKey } = await readWebPushKey();
  const registration = await navigator.serviceWorker.ready;
  // An old subscription can belong to another host key.
  await (await registration.pushManager.getSubscription())?.unsubscribe();
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  await saveWebPushSubscription(subscription);
}

async function unsubscribe(): Promise<void> {
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!subscription) return;
  await deleteWebPushSubscription(subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe();
}

export function WebPushSetting(): ReactElement | null {
  const [state, setState] = useState<PushState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const refresh = useCallback(() => readState().then(setState, () => setState("off")), []);
  useEffect(() => { if (!window.suplexApp) void refresh(); }, [refresh]);

  if (window.suplexApp || !state) return null;
  if (state === "unsupported") return <SettingRow label={LABEL} description="This browser cannot show notifications. On iPhone or iPad, add Suplex to the Home Screen, then open it from there." />;

  const change = async (checked: boolean): Promise<void> => {
    setBusy(true); setError(false);
    try { await (checked ? subscribe() : unsubscribe()); }
    catch { setError(true); }
    finally { await refresh(); setBusy(false); }
  };
  return <>
    <SettingRow label={LABEL} description={state === "denied" ? "The browser blocks notifications for this site. Open the browser settings to allow them." : "Suplex sends a notification when a task needs your input."}>
      <Switch aria-label={LABEL} checked={state === "on"} disabled={busy || state === "denied"} onCheckedChange={checked => void change(checked)} />
    </SettingRow>
    {error ? <Alert variant="destructive"><AlertDescription>Suplex could not change notifications on this device.</AlertDescription></Alert> : null}
  </>;
}
