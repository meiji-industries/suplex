import { ProfileFields } from "./profile-fields.js";
import { useProfileDraft } from "./lib/profile-draft.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SettingsContent, SettingsLayout, SettingsSection, SettingRow } from "../settings/settings-layout.js";
import { readTaskAgentExpiry, saveTaskAgentExpiry, taskAgentExpiryOptions } from "../tasks/task-agent-expiry.js";
import { withCompany } from "../../lib/api.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Save } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { LoadingState } from "../../components/app/loading-state.js";
import type { AccountResponse } from "../../contracts/generated/AccountResponse.js";
import { getAccount, logoutAccount } from "../account/lib/account-api.js";

export function ProfileView(): ReactElement {
  const { user, currentCompany, loading, updateProfile } = useCompanyContext();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [taskAgentExpiry, setTaskAgentExpiry] = useState(readTaskAgentExpiry);
  const [account, setAccount] = useState<AccountResponse>();

  useEffect(() => { void getAccount().then(setAccount).catch(() => undefined); }, []);

  const { profile, changeProfile } = useProfileDraft(user, user?.id === "user_development" ? account?.account?.email : undefined);
  const { displayName, title, username, avatarSeed } = profile;


  const save = async (): Promise<void> => {
    if (!user) return;
    const nextName = displayName.trim();
    const next = username.trim();
    if (!nextName || !next || busy || (nextName === user.displayName && next === user.username && avatarSeed === user.avatarSeed && title.trim() === user.title)) return;
    setBusy(true); setSaved(false); setError("");
    try { await updateProfile({ displayName: nextName, username: next, avatarSeed, title: title.trim() }); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Suplex could not save the profile."); }
    finally { setBusy(false); }
  };
  const companyId = currentCompany?.id;
  const logout = async (): Promise<void> => {
    setError("");
    try { await logoutAccount(); window.location.assign("/"); }
    catch { setError("Suplex could not log out of the Suplex account."); }
  };

  return <SettingsLayout title="Profile" companyId={companyId ?? ""} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/profile", companyId)}>
    <SettingsContent title="Profile" actions={user ? <Button type="submit" form="profile-form" size="sm" disabled={busy || !displayName.trim() || !username.trim() || (displayName.trim() === user.displayName && username.trim() === user.username && avatarSeed === user.avatarSeed && title.trim() === user.title)}><Save />{saved ? "Saved" : "Save"}</Button> : null}>
    {loading || !user ? <LoadingState /> : <>
    <form id="profile-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SettingsSection>
        <ProfileFields userId={user.id} email={user.id === "user_development" ? account?.account?.email : undefined} value={profile} disabled={busy} onChange={changes => { changeProfile(changes); setSaved(false); }} />
      </SettingsSection>
    </form>
    <SettingsSection>
      <SettingRow label="Inactive task agents">
        <Select value={String(taskAgentExpiry)} onValueChange={value => { if (value !== null) setTaskAgentExpiry(saveTaskAgentExpiry(Number(value))); }}>
          <SelectTrigger size="sm" aria-label="Inactive task agents"><SelectValue /></SelectTrigger>
          <SelectContent>{taskAgentExpiryOptions.map(option => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>
      {account?.configured && account.account && account.canManage ? <SettingRow label="Suplex account">
        <Button type="button" variant="destructive" size="sm" onClick={() => void logout()}>Log out</Button>
      </SettingRow> : null}
    </SettingsSection>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </>}
    </SettingsContent>
  </SettingsLayout>;
}
