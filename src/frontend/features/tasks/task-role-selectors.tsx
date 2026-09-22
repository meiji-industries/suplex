import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ApiProfile } from "../../shell/view-shared.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";

export function TaskRoleSelector({ role, label: providedLabel, profiles, assignment, defaultProfileId, defaultChoiceLabel, showDefaultChoice = true, busy, onChange }: {
  role: "root" | "worker";
  /** Advisors reuse Coordinator (root) profiles under their own product label. */
  label?: string;
  profiles: ApiProfile[];
  assignment: string;
  defaultProfileId: string | undefined;
  defaultChoiceLabel?: string;
  showDefaultChoice?: boolean;
  busy: boolean;
  onChange: (profileId: string) => void;
}) {
  const label = providedLabel ?? (role === "root" ? "Coordinator" : "Worker");
  const available = profiles.filter(profile => profile.role === role && !profile.archivedAt);
  const selected = available.find(profile => profile.id === (assignment || defaultProfileId));
  // Role and profile stay visible together, so the same profile on several roles remains distinguishable.
  const choice = selected?.name ?? (defaultChoiceLabel ?? (providedLabel ? "Same as Coordinator" : "Project default"));
  const [open, setOpen] = useState(false);
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" aria-label={`${label} assignee: ${choice}`} disabled={busy} />}>
      {selected ? <EntityAvatar kind="agent" id={selected.id} name={selected.name} seed={selected.avatarSeed} size="xs" /> : null}
      <span className="truncate">{label}: {choice}</span><ChevronDown />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-96 max-w-[calc(100vw-2rem)]"><DropdownMenuRadioGroup value={assignment} onValueChange={value => { onChange(value); setOpen(false); }}>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {showDefaultChoice ? <DropdownMenuRadioItem value="">{defaultChoiceLabel ?? (providedLabel ? "Same as Coordinator" : "Project default")}</DropdownMenuRadioItem> : null}
      {available.map(profile => <DropdownMenuRadioItem key={profile.id} value={profile.id}>
        <EntityAvatar kind="agent" id={profile.id} name={profile.name} seed={profile.avatarSeed} />
        <span>{profile.name} · {profile.model} · {profile.reasoningLevel} · {profile.serviceTier}</span>
      </DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup></DropdownMenuContent>
  </DropdownMenu>;
}
