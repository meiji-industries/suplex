import { CheckCircle2, CircleDashed, CircleDotDashed, CircleX, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

import { ACTIVE_PHASES, BLOCKED_PHASES, phaseLabel, type IssuePhase } from "../../../issue-phases.js";

export function taskStatusAppearance(phase: IssuePhase): { icon: LucideIcon; iconClass: string; badge: "secondary" | "success-light" | "warning-light" | "destructive-light" | "primary-light" } {
  if (phase === "done") return { icon: CheckCircle2, iconClass: "text-emerald-500", badge: "success-light" };
  if (BLOCKED_PHASES.has(phase) || phase === "blocked" || phase === "cancelled") return { icon: CircleX, iconClass: "text-rose-500", badge: "destructive-light" };
  if (["development", "repair_required", "releasing", "merge_conflict_resolving", "ci_repair_required"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-amber-500", badge: "warning-light" };
  if (["approval", "ready_for_development", "delivery_ready", "reviewing_delivery", "delivery_reviewed", "final_review", "accepted", "ready_reconciliation", "manual_merge"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-blue-500", badge: "primary-light" };
  return { icon: ACTIVE_PHASES.has(phase) ? CircleDotDashed : CircleDashed, iconClass: "text-muted-foreground", badge: "secondary" };
}

export function TaskStatusIcon({ phase }: { phase: IssuePhase }): ReactElement {
  const appearance = taskStatusAppearance(phase);
  const Icon = appearance.icon;
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${appearance.iconClass}`} />;
}

export function TaskStatus({ phase }: { phase: IssuePhase }): ReactElement {
  return <span data-task-status={phase} className="inline-flex items-center gap-1.5"><TaskStatusIcon phase={phase} /><span>{phaseLabel(phase)}</span></span>;
}
