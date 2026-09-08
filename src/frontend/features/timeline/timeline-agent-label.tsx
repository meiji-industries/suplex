import type { ReactElement } from "react";

import { EntityAvatar } from "../../components/app/entity-avatar.js";

export function TimelineAgentLabel({ avatarSeed, name, role, executionCount, duration }: {
  avatarSeed: string;
  name: string;
  role: string;
  executionCount: number;
  duration: string;
}): ReactElement {
  return <span className="flex min-w-0 items-center gap-2">
    <EntityAvatar kind="agent" id={avatarSeed} name={name} />
    <span className="min-w-0">
      <span className="block truncate text-xs font-medium">{name}</span>
      <span className="block truncate text-[11px] text-muted-foreground">{role} · {executionCount}× · {duration}</span>
    </span>
  </span>;
}
