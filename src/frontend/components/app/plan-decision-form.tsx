import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Field, FieldLabel } from "../ui/field.js";
import type { PublicPlanDecisionSubject } from "../../../plan-governance.js";
import type { TaskCommandEndpoint } from "../../../task-commands.js";
import { useCommandForm } from "./use-command-form.js";

export interface DecisionCommandView { endpoint: TaskCommandEndpoint; expectedRevision: number; subject: PublicPlanDecisionSubject; idempotency?: string }

export function PlanDecisionForm({ command, actionLabel, busy, onSubmit, error }: { command: DecisionCommandView; actionLabel: string; busy: boolean; onSubmit: (payload: { subject: PublicPlanDecisionSubject; expectedRevision: number; note: string; idempotencyKey: string }) => Promise<void>; error?: string }) {
  const { value: note, setValue: setNote, errorRef, submit } = useCommandForm({ error, initialIdempotencyKey: command.idempotency, onSubmit: (value, idempotencyKey) => onSubmit({ subject: command.subject, expectedRevision: command.expectedRevision, note: value, idempotencyKey }) });
  const noteId = `plan-decision-note-${actionLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <form className="space-y-2" onSubmit={(event) => void submit(event)} aria-busy={busy} data-plan-decision-form><Field><FieldLabel htmlFor={noteId}>Decision note</FieldLabel><Input id={noteId} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1_000} required placeholder="Explain this decision" /></Field>{error ? <p ref={errorRef} role="alert" tabIndex={-1} className="text-xs text-destructive">{error}</p> : null}<Button type="submit" size="sm" disabled={busy || !note.trim()}>{busy ? "Saving…" : actionLabel}</Button></form>;
}
