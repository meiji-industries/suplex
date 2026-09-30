import { useState, type ReactElement } from "react";
import type { Task } from "../../contracts/tasks.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { continueTaskDelivery } from "./lib/task-api.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";

const pullRequestTargets: ReadonlyArray<Task["deliveryTarget"]> = ["pull_request_draft", "pull_request_ready", "merged"];

/** The delivery target. A running task, or a delivered pull request task, moves to a later target and the Coordinator continues toward it. */
export function TaskDeliveryProperty({ task, onChange }: { task: Task; onChange: (task: Task) => void }): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const label = (value: string | null) => taskDeliveryTargetOptions.find(option => option.value === value)?.label;
  const current = taskDeliveryTargetOptions.findIndex(option => option.value === task.deliveryTarget);
  const later = taskDeliveryTargetOptions.slice(current + 1);
  const editable = !task.archivedAt && later.length > 0 && task.configuration.integration?.repository?.kind !== "bitbucket"
    && (task.status === "active" || task.status === "delivered" && pullRequestTargets.includes(task.deliveryTarget));
  const change = async (value: Task["deliveryTarget"] | null) => {
    if (!value || value === task.deliveryTarget || pending) return;
    setPending(true); setError("");
    try { onChange(await continueTaskDelivery(task.id, value)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Suplex could not change the delivery target."); }
    finally { setPending(false); }
  };
  return <div className="space-y-1.5">
    <dt className="text-muted-foreground text-[14px] dark:text-[#d1d1d1]">Delivery</dt>
    <dd>{editable
      ? <Select value={task.deliveryTarget} disabled={pending} onValueChange={value => void change(value)}>
        <SelectTrigger size="sm" aria-label="Delivery target"><SelectValue>{label}</SelectValue></SelectTrigger>
        <SelectContent>{[taskDeliveryTargetOptions[current], ...later].map(option => option ? <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem> : null)}</SelectContent>
      </Select>
      : label(task.deliveryTarget)}</dd>
    {error ? <dd role="alert" className="text-xs text-destructive">{error}</dd> : null}
  </div>;
}
