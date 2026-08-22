import { useState, type KeyboardEvent } from "react";

import { Button } from "../ui/button.js";
import { Field, FieldLabel } from "../ui/field.js";
import { Textarea } from "../ui/textarea.js";

export function TellPlannerForm({ disabled, disabledReason, onSubmit }: { disabled: boolean; disabledReason?: string | undefined; onSubmit: (note: string, commandId: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = !disabled && !submitting && Boolean(note.trim());
  const submit = async (): Promise<void> => {
    const value = note.trim();
    if (!canSubmit || !value) return;
    setSubmitting(true);
    try {
      await onSubmit(value, crypto.randomUUID());
      setNote("");
    } finally {
      setSubmitting(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing || !canSubmit) return;
    event.preventDefault();
    void submit();
  };
  return <form data-tell-planner-form className="border-t pt-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Field>
      <FieldLabel htmlFor="tell-planner-note">Tell the Planner</FieldLabel>
      <Textarea id="tell-planner-note" value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={onKeyDown} placeholder="Add, remove, or undo something in the plan" disabled={disabled || submitting} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">{disabledReason ?? "Cmd/Ctrl+Enter to send"}</p>
        <Button size="sm" type="submit" disabled={!canSubmit}>{submitting ? "Sending…" : "Tell the Planner"}</Button>
      </div>
    </Field>
  </form>;
}
