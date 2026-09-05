import { useState } from "react";
import type { Task } from "../../../task-contracts.js";
import { Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireDescription, QuestionnaireError, QuestionnaireInput, QuestionnaireItem, QuestionnaireSubmit, QuestionnaireTitle } from "../ui/questionnaire.js";
import { Badge } from "../ui/badge.js";
import { Checkbox } from "../ui/checkbox.js";

export function TaskQuestion({ question, busy, onAnswer }: { question: NonNullable<Task["humanQuestion"]>; busy: boolean; onAnswer: (answer: { answer: string; confirmCommandsStopped: boolean }) => Promise<void> }) {
  const [answered, setAnswered] = useState(false);
  const [commandsStopped, setCommandsStopped] = useState(false);
  const choices = question.options.map(choice => ({ ...choice, value: `${choice.label}: ${choice.description}` }));
  const items = [{ name: "answer", required: true, choices, input: { label: "Other", placeholder: "Write another answer" } }];
  const valid = answered && (!question.requiresCommandCleanup || commandsStopped);
  return <section aria-label="Question"><Questionnaire aria-label="Answer necessary" items={items} onSubmit={async event => {
    event.preventDefault();
    if (busy || !valid) return;
    const answer = new FormData(event.currentTarget).get("answer");
    if (typeof answer === "string" && answer.trim()) await onAnswer({ answer: answer.trim(), confirmCommandsStopped: commandsStopped });
  }}>
    <QuestionnaireItem name="answer" required disabled={busy} onStatusChange={status => setAnswered(status === "answered")}>
      <QuestionnaireTitle>Answer necessary</QuestionnaireTitle>
      <QuestionnaireDescription>{question.text}</QuestionnaireDescription>
      <QuestionnaireChoices>
        {choices.map(choice => <QuestionnaireChoice key={choice.value} value={choice.value}><span>{choice.label} {choice.recommended ? <Badge variant="secondary">Recommended</Badge> : null}</span><QuestionnaireChoiceDescription>{choice.description}</QuestionnaireChoiceDescription></QuestionnaireChoice>)}
        <label className="grid gap-2"><span>Other</span><QuestionnaireInput aria-label="Answer" placeholder="Write another answer" /></label>
      </QuestionnaireChoices>
      <QuestionnaireError />
    </QuestionnaireItem>
    {question.requiresCommandCleanup ? <label className="flex items-center gap-2 text-xs"><Checkbox disabled={busy} checked={commandsStopped} onCheckedChange={checked => setCommandsStopped(checked === true)} />All commands from this session have stopped</label> : null}
    <QuestionnaireActions><QuestionnaireSubmit disabled={busy || !valid}>Answer and continue</QuestionnaireSubmit></QuestionnaireActions>
  </Questionnaire></section>;
}
