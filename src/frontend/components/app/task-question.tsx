import { useState } from "react";
import type { Task } from "../../../task-contracts.js";
import { Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireDescription, QuestionnaireError, QuestionnaireInput, QuestionnaireItem, QuestionnaireSubmit, QuestionnaireTitle } from "../ui/questionnaire.js";
import { Badge } from "../ui/badge.js";
import { Checkbox } from "../ui/checkbox.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import type { TaskLimitDecision } from "../../../task-limits.js";

export function TaskQuestion({ question, busy, onAnswer, onLimitDecision }: { question: NonNullable<Task["humanQuestion"]>; busy: boolean; onAnswer: (answer: { answer: string; confirmCommandsStopped: boolean }) => Promise<void>; onLimitDecision: (decision: TaskLimitDecision) => Promise<void> }) {
  const [answered, setAnswered] = useState(false);
  const [commandsStopped, setCommandsStopped] = useState(false);
  const [budgetUsd, setBudgetUsd] = useState(question.kind === "task_limit" ? String(question.pause.proposedLimits.budgetUsd) : "0");
  const [maxTurns, setMaxTurns] = useState(question.kind === "task_limit" ? String(question.pause.proposedLimits.maxTurns) : "0");
  if (question.kind === "task_limit") {
    const budget = Number(budgetUsd);
    const turns = Number(maxTurns);
    const validLimits = budgetUsd.trim() !== "" && Number.isFinite(budget) && budget >= 0 && maxTurns.trim() !== "" && Number.isInteger(turns) && turns >= 0;
    return <section aria-label="Task limit" className="space-y-3">
      <div className="space-y-1"><h3 className="text-sm font-medium">Task limit reached</h3><p className="text-xs text-muted-foreground">{question.text}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void onLimitDecision({ kind: "add_allowance" })}>Add allowance and continue</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onLimitDecision({ kind: "cancel_task" })}>Cancel task</Button>
      </div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (validLimits && !busy) void onLimitDecision({ kind: "change_limits", limits: { budgetUsd: budget, maxTurns: turns } }); }}>
        <label className="grid gap-1 text-xs"><span>Budget in USD</span><Input aria-label="Task budget in USD" type="number" min="0" step="0.01" inputMode="decimal" value={budgetUsd} onChange={event => setBudgetUsd(event.target.value)} /></label>
        <label className="grid gap-1 text-xs"><span>Maximum turns</span><Input aria-label="Maximum task turns" type="number" min="0" step="1" inputMode="numeric" value={maxTurns} onChange={event => setMaxTurns(event.target.value)} /></label>
        <Button size="sm" variant="outline" type="submit" disabled={busy || !validLimits}>Change limits and continue</Button>
      </form>
      <p className="text-xs text-muted-foreground">Set either limit to 0 to disable it.</p>
    </section>;
  }
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
