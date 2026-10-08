import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty.js";

/** Page-level empty, missing, or unavailable state. Use it instead of a lone muted sentence. */
export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: ReactNode; action?: ReactNode }): ReactElement {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia className="[zoom:1.25]" variant="icon"><Icon className="[stroke-width:0.8]" aria-hidden="true" /></EmptyMedia>
        <EmptyTitle className="font-normal text-2xl tracking-normal">{title}</EmptyTitle>
        {description ? <EmptyDescription className="leading-[26.16px] text-sm">{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
