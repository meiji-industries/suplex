import { Archive, Square } from "lucide-react";
import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge.js";

/** Whether a shell run's terminal is open. */
export function RunBadge({ live }: { live: boolean }): ReactElement {
  return <Badge variant={live ? "default" : "outline"}>{live ? "Live" : "Ended"}</Badge>;
}

/** The run badge. Pointing at it offers Stop for a live run and Archive for an ended one. */
export function RunActionBadge({ live, label, onStop, onArchive }: { live: boolean; label: string; onStop: () => void; onArchive: () => void }): ReactElement {
  const action = live ? "Stop" : "Archive";
  return <button type="button" aria-label={`${action} ${label}`} title={action} className="group/run-action absolute top-1/2 right-1 -translate-y-1/2 rounded-4xl focus-visible:outline-2 focus-visible:outline-ring" onClick={live ? onStop : onArchive}>
    <span className="group-hover/run-action:hidden group-focus-visible/run-action:hidden"><RunBadge live={live} /></span>
    <span className="hidden group-hover/run-action:inline-flex group-focus-visible/run-action:inline-flex">{live ? <Badge variant="destructive"><Square />Stop</Badge> : <Badge variant="purple"><Archive />Archive</Badge>}</span>
  </button>;
}
