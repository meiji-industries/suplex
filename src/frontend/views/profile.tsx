import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { ProfileAvatar } from "../components/app/profile-avatar.js";
import { SettingsLayout, SettingsSection, SettingRow } from "../components/app/settings-layout.js";
import { withCompany } from "../lib/api.js";
import { RefreshCw, Save } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

export function ProfileView(): ReactElement {
  const { user, currentCompany, loading, updateProfile } = useCompanyContext();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [avatarSeed, setAvatarSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setDisplayName(user?.displayName ?? ""); setUsername(user?.username ?? ""); setAvatarSeed(user?.avatarSeed ?? ""); setSaved(false); }, [user?.avatarSeed, user?.displayName, user?.username]);

  if (loading || !user) return <ApplicationFrame title="Profile"><div className="p-4 text-xs text-muted-foreground">Loading profile…</div></ApplicationFrame>;

  const save = async (): Promise<void> => {
    const nextName = displayName.trim();
    const next = username.trim();
    if (!nextName || !next || busy || (nextName === user.displayName && next === user.username && avatarSeed === user.avatarSeed)) return;
    setBusy(true); setSaved(false); setError("");
    try { await updateProfile({ displayName: nextName, username: next, avatarSeed }); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update profile"); }
    finally { setBusy(false); }
  };
  const companyId = currentCompany?.id;

  return <SettingsLayout title="Profile" companyId={companyId ?? ""} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/profile", companyId)}>
    <SettingsSection title="Profile">
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <SettingRow label="Name" description="Shown anywhere your account appears.">
          <Input id="display-name" value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSaved(false); }} />
        </SettingRow>
        <SettingRow label="Username" description="2–64 characters: letters, numbers, dots, hyphens, underscores, or @.">
          <Input id="username" value={username} onChange={(event) => { setUsername(event.target.value); setSaved(false); }} />
        </SettingRow>
        <SettingRow label="Avatar" description="Used anywhere your account appears.">
          <div className="flex items-center gap-2"><ProfileAvatar name={displayName || user.displayName} seed={avatarSeed || user.username} size="lg" collection="pixel-art-neutral" /><Button type="button" variant="ghost" size="icon-xs" aria-label="Regenerate avatar" title="Regenerate avatar" onClick={() => { setAvatarSeed(crypto.randomUUID()); setSaved(false); }}><RefreshCw aria-hidden="true" /></Button><Button type="submit" size="sm" disabled={busy || !displayName.trim() || !username.trim() || (displayName.trim() === user.displayName && username.trim() === user.username && avatarSeed === user.avatarSeed)}><Save className="size-3.5" />{busy ? "Saving…" : saved ? "Saved" : "Save"}</Button></div>
        </SettingRow>
      </form>
    </SettingsSection>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </SettingsLayout>;
}
