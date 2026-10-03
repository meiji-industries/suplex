import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { AvatarEditor } from "../../components/app/entity-avatar.js";
import { SettingsContent, SettingsLayout, SettingsSection, SettingRow } from "../settings/settings-layout.js";
import { readTaskAgentExpiry, saveTaskAgentExpiry, taskAgentExpiryOptions } from "../tasks/task-agent-expiry.js";
import { withCompany } from "../../lib/api.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { RefreshCw, Save } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { LoadingState } from "../../components/app/loading-state.js";
import type { AccountResponse } from "../../contracts/generated/AccountResponse.js";
import { getAccount, logoutAccount } from "../account/lib/account-api.js";

export function ProfileView(): ReactElement {
  const { user, currentCompany, loading, updateProfile } = useCompanyContext();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [avatarSeed, setAvatarSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [taskAgentExpiry, setTaskAgentExpiry] = useState(readTaskAgentExpiry);
  const [account, setAccount] = useState<AccountResponse>();

  useEffect(() => { void getAccount().then(setAccount).catch(() => undefined); }, []);

  useEffect(() => { setDisplayName(user?.displayName ?? ""); setUsername(user?.username ?? ""); setAvatarSeed(user?.avatarSeed ?? ""); setSaved(false); }, [user?.avatarSeed, user?.displayName, user?.username]);

  const save = async (): Promise<void> => {
    if (!user) return;
    const nextName = displayName.trim();
    const next = username.trim();
    if (!nextName || !next || busy || (nextName === user.displayName && next === user.username && avatarSeed === user.avatarSeed)) return;
    setBusy(true); setSaved(false); setError("");
    try { await updateProfile({ displayName: nextName, username: next, avatarSeed }); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update profile"); }
    finally { setBusy(false); }
  };
  const companyId = currentCompany?.id;
  const logout = async (): Promise<void> => {
    setError("");
    try { await logoutAccount(); window.location.assign("/"); }
    catch { setError("Suplex could not log out of the Suplex account."); }
  };

  return <SettingsLayout title="Profile" companyId={companyId ?? ""} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/profile", companyId)}>
    <SettingsContent title="Profile">
    {loading || !user ? <LoadingState /> : <>
    <SettingsSection>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <SettingRow label="Name" description="Shown anywhere your account appears.">
          <Input size="sm" id="display-name" value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSaved(false); }} />
        </SettingRow>
        <SettingRow label="Username" description="2–64 characters: letters, numbers, dots, hyphens, underscores, or @.">
          <Input size="sm" id="username" value={username} onChange={(event) => { setUsername(event.target.value); setSaved(false); }} />
        </SettingRow>
        <SettingRow label="Avatar" description="Used anywhere your account appears. Regenerate changes the default image.">
          <div className="flex flex-wrap items-center gap-2"><AvatarEditor kind="user" id={user.id} name={displayName || user.displayName} seed={avatarSeed || user.username} /><Button type="button" variant="ghost" size="icon-xs" aria-label="Regenerate avatar" title="Regenerate avatar" onClick={() => { setAvatarSeed(crypto.randomUUID()); setSaved(false); }}><RefreshCw aria-hidden="true" /></Button><Button type="submit" size="sm" disabled={busy || !displayName.trim() || !username.trim() || (displayName.trim() === user.displayName && username.trim() === user.username && avatarSeed === user.avatarSeed)}><Save className="size-3.5" />{busy ? "Saving…" : saved ? "Saved" : "Save"}</Button></div>
        </SettingRow>
      </form>
      <SettingRow label="Inactive task agents" description="Keep idle and stopped agents visible for this long.">
        <Select value={String(taskAgentExpiry)} onValueChange={value => { if (value !== null) setTaskAgentExpiry(saveTaskAgentExpiry(Number(value))); }}>
          <SelectTrigger size="sm" aria-label="Inactive task agents"><SelectValue /></SelectTrigger>
          <SelectContent>{taskAgentExpiryOptions.map(option => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>
      {account?.configured && account.account ? <SettingRow label="Suplex account" description={`Logged in as ${account.account.email}`}>
        {account.canManage ? <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>Log out</Button> : null}
      </SettingRow> : null}
    </SettingsSection>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </>}
    </SettingsContent>
  </SettingsLayout>;
}
