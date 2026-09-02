import { useState } from "react";
import { Send } from "lucide-react";

import { Button } from "../ui/button.js";
import { Field, FieldError, FieldLabel } from "../ui/field.js";
import { Textarea } from "../ui/textarea.js";
import type { TaskCommandEndpoint } from "../../../task-commands.js";
import { useCommandForm } from "./use-command-form.js";

export interface DecisionCommandView { endpoint: TaskCommandEndpoint; expectedRevision: number }

type DecisionPayload = { command: DecisionCommandView; note: string };
type DecisionAction = "approve" | "reject" | "changes";

export function PlanDecisionForm({ approveCommand, revisionCommand, busy, onSubmit, error }: { approveCommand?: DecisionCommandView; revisionCommand?: DecisionCommandView; busy: boolean; onSubmit: (payload: DecisionPayload) => Promise<void>; error?: string }) {
  const [changesOpen, setChangesOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);
  const submitDecision = async (action: DecisionAction, payload: DecisionPayload): Promise<void> => {
    setPendingAction(action);
    try { await onSubmit(payload); } finally { setPendingAction(null); }
  };
  const { value: changes, setValue: setChanges, errorRef, submit } = useCommandForm({ error, onSubmit: async (note) => { if (revisionCommand) await submitDecision("changes", { command: revisionCommand, note }); } });
  const disabled = busy || pendingAction !== null;
  const canRequestChanges = Boolean(revisionCommand) && !disabled && Boolean(changes.trim());
  const sendButton = <Button type="submit" size="icon-sm" disabled={!canRequestChanges} aria-label="Send requested changes" title="Send requested changes"><Send /></Button>;
  const status = pendingAction === "approve" ? "Approval submitted · Updating task…" : pendingAction === "reject" ? "Rejection submitted · Updating task…" : pendingAction === "changes" ? "Change request submitted · Updating task…" : null;

  return <div className="space-y-3" aria-busy={busy || pendingAction !== null} data-plan-decision-form>
    <div className="flex flex-wrap gap-2">
      {approveCommand ? <Button type="button" size="sm" disabled={disabled} onClick={() => void submitDecision("approve", { command: approveCommand, note: "Plan approved." })}>{pendingAction === "approve" ? "Approving…" : "Approve Plan"}</Button> : null}
      {revisionCommand ? <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => void submitDecision("reject", { command: revisionCommand, note: "Plan rejected." })}>{pendingAction === "reject" ? "Rejecting…" : "Reject Plan"}</Button> : null}
      {revisionCommand ? <Button type="button" size="sm" variant="outline" disabled={disabled} aria-expanded={changesOpen} onClick={() => setChangesOpen((open) => !open)}>Request Changes</Button> : null}
    </div>
    {status ? <p role="status" className="text-[11px] text-muted-foreground">{status}</p> : null}
    {changesOpen ? <form className="max-w-xl" onSubmit={(event) => void submit(event)}><Field><FieldLabel htmlFor="plan-requested-changes">Requested changes</FieldLabel><div className="relative"><Textarea id="plan-requested-changes" value={changes} onChange={(event) => setChanges(event.target.value)} onKeyDown={(event) => { if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || !canRequestChanges) return; event.preventDefault(); event.currentTarget.form?.requestSubmit(); }} maxLength={1_000} required placeholder="Describe the changes you want" className="pb-10" disabled={busy} /><div className="absolute right-2 bottom-2">{sendButton}</div></div></Field></form> : null}
    {error ? <FieldError ref={errorRef} tabIndex={-1}>{error}</FieldError> : null}
  </div>;
}
