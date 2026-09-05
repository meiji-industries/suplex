import { useState } from "react";
import type { Task } from "../../../task-contracts.js";
import { Question, QuestionActions, QuestionDescription, QuestionInput, QuestionOption, QuestionOptions, QuestionPrompt, QuestionSubmit, type QuestionValue } from "../ai-elements/question.js";
import { Badge } from "../ui/badge.js";
import { Checkbox } from "../ui/checkbox.js";

export function TaskQuestion({ question, busy, onAnswer }: { question: NonNullable<Task["humanQuestion"]>; busy: boolean; onAnswer: (answer: { answer: string; confirmCommandsStopped: boolean }) => Promise<void> }) {
  const [value, setValue] = useState<QuestionValue>({ selectedValues: [], text: "" });
  const [commandsStopped, setCommandsStopped] = useState(false);
  const selected = value.selectedValues[0];
  const other = selected === "other" || question.options.length === 0;
  const option = question.options.find((_, index) => String(index) === selected);
  const valid = (other ? Boolean(value.text.trim()) : Boolean(option)) && (!question.requiresCommandCleanup || commandsStopped);
  return <section aria-label="Question"><Question aria-label="Answer necessary" disabled={busy} value={value} onValueChange={setValue} onSubmit={async () => {
    if (!valid) return;
    const answer = other ? value.text.trim() : `${option!.label}: ${option!.description}${value.text.trim() ? `\n\n${value.text.trim()}` : ""}`;
    await onAnswer({ answer, confirmCommandsStopped: commandsStopped });
  }}>
    <QuestionPrompt>Answer necessary</QuestionPrompt>
    <QuestionDescription>{question.text}</QuestionDescription>
    <QuestionOptions aria-label="Your answer">
      {question.options.map((choice, index) => <QuestionOption className="max-w-full" key={index} value={String(index)}><span className="flex min-w-0 flex-col items-start gap-1 text-left"><span>{choice.label} {choice.recommended ? <Badge variant="secondary">Recommended</Badge> : null}</span><span>{choice.description}</span></span></QuestionOption>)}
      <QuestionOption value="other">Other</QuestionOption>
    </QuestionOptions>
    <QuestionInput aria-label="Answer" placeholder={other ? "Write your answer" : "Add details if necessary"} />
    {question.requiresCommandCleanup ? <label className="flex items-center gap-2 text-xs"><Checkbox checked={commandsStopped} onCheckedChange={checked => setCommandsStopped(checked === true)} />All commands from this session have stopped</label> : null}
    <QuestionActions><QuestionSubmit disabled={!valid}>Answer and continue</QuestionSubmit></QuestionActions>
  </Question></section>;
}
