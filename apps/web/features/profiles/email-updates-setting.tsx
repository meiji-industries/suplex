import { useEffect, useState, type ReactElement } from "react";

import { Switch } from "../../components/ui/switch.js";
import { SettingRow } from "../settings/settings-layout.js";
import { EMAIL_UPDATES_SETTING_DESCRIPTION, EMAIL_UPDATES_SETTING_LABEL, getEmailUpdates, setEmailUpdates } from "../account/lib/account-api.js";

/** Shown only when this person has a linked Suplex account on this host. */
export function EmailUpdatesSetting(): ReactElement | null {
  const [subscribed, setSubscribed] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void getEmailUpdates().then(result => { if (result.available) setSubscribed(result.subscribed); }).catch(() => undefined); }, []);
  if (subscribed === undefined) return null;
  const change = async (checked: boolean): Promise<void> => {
    setBusy(true); setError("");
    try { setSubscribed((await setEmailUpdates(checked, "settings")).subscribed); }
    catch { setError("Suplex could not save your email choice. Retry."); }
    finally { setBusy(false); }
  };
  return <SettingRow label={EMAIL_UPDATES_SETTING_LABEL} description={error || EMAIL_UPDATES_SETTING_DESCRIPTION}>
    <Switch aria-label={EMAIL_UPDATES_SETTING_LABEL} checked={subscribed} disabled={busy} onCheckedChange={checked => void change(checked)} />
  </SettingRow>;
}
