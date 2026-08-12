import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Field, FieldLabel } from "../ui/field.js";
import type { PublicPlanBlockerSubject } from "../../../plan-governance.js";
import { useCommandForm } from "./use-command-form.js";

export function PlanBlockerResponseForm({ subject, expectedRevision, busy, onSubmit, error }: { subject: PublicPlanBlockerSubject; expectedRevision: number; busy: boolean; onSubmit: (payload: { subject: PublicPlanBlockerSubject; expectedWorkflowRevision: number; answer: string; idempotencyKey: string }) => Promise<void>; error?: string }) {
  const { value: answer, setValue: setAnswer, errorRef, submit } = useCommandForm({ error, onSubmit: (value, idempotencyKey) => onSubmit({ subject, expectedWorkflowRevision: expectedRevision, answer: value, idempotencyKey }) });
  return <form className="space-y-2" onSubmit={(event) => void submit(event)} aria-busy={busy} data-plan-blocker-response-form><Field><FieldLabel htmlFor="plan-blocker-answer">Answer</FieldLabel><Input id="plan-blocker-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={1_000} required placeholder="Resolve the member decision" /></Field>{error ? <p ref={errorRef} role="alert" tabIndex={-1} className="text-xs text-destructive">{error}</p> : null}<Button type="submit" size="sm" disabled={busy || !answer.trim()}>{busy ? "Saving…" : "Respond"}</Button></form>;
}
