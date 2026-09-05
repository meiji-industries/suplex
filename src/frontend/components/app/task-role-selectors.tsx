import { ChevronDown } from "lucide-react";
import type { ApiProfile } from "../../lib/view-shared.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { ProfileAvatar } from "./profile-avatar.js";

export function TaskRoleSelector({ role, profiles, assignment, defaultProfileId, busy, onChange }: {
  role: "root" | "worker";
  profiles: ApiProfile[];
  assignment: string;
  defaultProfileId: string | undefined;
  busy: boolean;
  onChange: (profileId: string) => void;
}) {
  const label = role === "root" ? "Root" : "Worker";
  const available = profiles.filter(profile => profile.role === role && !profile.archivedAt);
  const selected = available.find(profile => profile.id === (assignment || defaultProfileId));
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" aria-label={`${label} assignee: ${selected?.name ?? "Project default"}`} disabled={busy} />}>
      {selected ? <ProfileAvatar name={selected.name} seed={selected.avatarSeed} size="xs" /> : null}
      {selected?.name ?? label}<ChevronDown />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-96 max-w-[calc(100vw-2rem)]"><DropdownMenuRadioGroup value={assignment} onValueChange={onChange}>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioItem value="">Project default</DropdownMenuRadioItem>
      {available.map(profile => <DropdownMenuRadioItem key={profile.id} value={profile.id}>
        <ProfileAvatar name={profile.name} seed={profile.avatarSeed} />
        <span>{profile.name} · {profile.model} · {profile.reasoningLevel} · {profile.serviceTier}</span>
      </DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup></DropdownMenuContent>
  </DropdownMenu>;
}
