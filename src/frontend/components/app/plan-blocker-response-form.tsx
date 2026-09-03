import { useState } from "react";
import { Send } from "lucide-react";

import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card.js";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "../ui/field.js";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group.js";
import { Textarea } from "../ui/textarea.js";
import { useCommandForm } from "./use-command-form.js";

const OTHER = "__other__";

type PlanBlockerPrompt = {
  header: string;
  question: string;
  evidence: string;
  nextAction: string;
  options: Array<{ label: string; description: string }>;
};

export function PlanBlockerResponseForm({ blocker, expectedRevision, busy, onSubmit, error }: { blocker: PlanBlockerPrompt; expectedRevision: number; busy: boolean; onSubmit: (payload: { expectedWorkflowRevision: number; answer: string; idempotencyKey: string }) => Promise<void>; error?: string }) {
  const hasChoices = blocker.options.length > 0;
  const [selected, setSelected] = useState(blocker.options.length ? "" : OTHER);
  const { value: answer, setValue: setAnswer, errorRef, submit } = useCommandForm({ error, onSubmit: (value, idempotencyKey) => onSubmit({ expectedWorkflowRevision: expectedRevision, answer: value, idempotencyKey }) });
  const select = (value: string) => { setSelected(value); setAnswer(value === OTHER ? "" : value); };
  const canSubmit = !busy && (!hasChoices || Boolean(selected)) && Boolean(answer.trim());
  const sendButton = <Button type="submit" size="icon-sm" disabled={!canSubmit} aria-label="Send response" title="Send response"><Send /></Button>;
  const composer = <div className="relative"><Textarea id="plan-blocker-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || !canSubmit) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }} maxLength={1_000} required placeholder="Write your answer" className="pb-10" disabled={busy} /><div className="absolute right-2 bottom-2">{sendButton}</div></div>;

  return (
    <form onSubmit={(event) => void submit(event)} aria-busy={busy} data-plan-blocker-response-form>
      <Card size="sm" data-plan-blocker>
        <CardHeader>
          <CardTitle>{blocker.header}</CardTitle>
          <CardDescription>{blocker.question}</CardDescription>
          <CardAction><Badge variant="destructive">Human decision</Badge></CardAction>
        </CardHeader>
        <CardContent>
          {hasChoices ? <FieldSet>
            <FieldLegend variant="label">Choose one</FieldLegend>
            <FieldContent>
              <FieldDescription>{blocker.evidence}</FieldDescription>
              <FieldDescription><span className="font-medium text-foreground">Next:</span> {blocker.nextAction}</FieldDescription>
            </FieldContent>
            <RadioGroup value={selected} onValueChange={select} aria-label={blocker.question}>
              {blocker.options.map((option, index) => {
                const id = `plan-blocker-option-${index}`;
                return <FieldLabel key={option.label} htmlFor={id}><Field orientation="horizontal"><FieldContent><FieldTitle>{option.label}</FieldTitle><FieldDescription>{option.description}</FieldDescription></FieldContent><RadioGroupItem id={id} value={option.label} /></Field></FieldLabel>;
              })}
              <FieldLabel htmlFor="plan-blocker-option-other"><Field orientation="horizontal"><FieldContent><FieldTitle>Other</FieldTitle><FieldDescription>Write a different answer.</FieldDescription></FieldContent><RadioGroupItem id="plan-blocker-option-other" value={OTHER} /></Field></FieldLabel>
            </RadioGroup>
            {selected === OTHER ? <Field><FieldLabel htmlFor="plan-blocker-answer">Other answer</FieldLabel>{composer}</Field> : null}
            {error ? <FieldError ref={errorRef} tabIndex={-1}>{error}</FieldError> : null}
          </FieldSet> : <Field><FieldLabel htmlFor="plan-blocker-answer">Answer</FieldLabel>{composer}{error ? <FieldError ref={errorRef} tabIndex={-1}>{error}</FieldError> : null}</Field>}
        </CardContent>
        {hasChoices && selected !== OTHER ? <CardFooter className="justify-end">{sendButton}</CardFooter> : null}
      </Card>
    </form>
  );
}
