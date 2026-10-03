import { RefreshCw } from "lucide-react";
import { AvatarEditor } from "../../components/app/entity-avatar.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import type { ApiUser } from "../../lib/api.js";
import { SettingRow } from "../settings/settings-layout.js";

type ProfileFieldsValue = Pick<ApiUser, "displayName" | "username" | "title" | "avatarSeed">;

export function ProfileFields({ userId, email, value, onChange, disabled = false }: {
  userId: string;
  email: string | undefined;
  value: ProfileFieldsValue;
  onChange: (changes: Partial<ProfileFieldsValue>) => void;
  disabled?: boolean;
}) {
  return <>
    <SettingRow label="Profile picture">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Regenerate avatar" title="Regenerate avatar" disabled={disabled} onClick={() => onChange({ avatarSeed: crypto.randomUUID() })}><RefreshCw aria-hidden="true" /></Button>
        <AvatarEditor compact kind="user" id={userId} name={value.displayName} seed={value.avatarSeed || value.username} />
      </div>
    </SettingRow>
    <SettingRow label="Email"><p className="break-all text-sm">{email ?? "Not available"}</p></SettingRow>
    <SettingRow label="Full name" htmlFor="display-name">
      <div className="w-full sm:w-60"><Input size="sm" id="display-name" autoComplete="name" maxLength={120} disabled={disabled} value={value.displayName} onChange={event => onChange({ displayName: event.target.value })} /></div>
    </SettingRow>
    <SettingRow label="Title" htmlFor="profile-title">
      <div className="w-full sm:w-60"><Input size="sm" id="profile-title" autoComplete="organization-title" maxLength={120} disabled={disabled} value={value.title} onChange={event => onChange({ title: event.target.value })} /></div>
    </SettingRow>
    <SettingRow label="Username" htmlFor="username">
      <div className="w-full sm:w-60"><Input size="sm" id="username" autoComplete="username" maxLength={64} disabled={disabled} value={value.username} onChange={event => onChange({ username: event.target.value })} /></div>
    </SettingRow>
  </>;
}
