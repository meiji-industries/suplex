import { useEffect, useState, type ReactNode } from "react";
import { DeveloperEvidence, type DeveloperExecutionEventView, type DeveloperExecutionView } from "../tasks/developer-evidence.js";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { ChevronDown } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardFooter } from "../ui/card.js";
import { Collapsible } from "../ui/collapsible.js";
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator } from "../ui/timeline.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";

export type TaskLeadOutput = NonNullable<TaskResponse["leadOutput"]>;

export function TaskLeadPlan({
  output,
  decisionControls,
  stepProgress,
  collapsible = false,
}: {
  output: TaskLeadOutput;
  decisionControls?: ReactNode;
  stepProgress?: { taskId: string; execution: DeveloperExecutionView; events: DeveloperExecutionEventView[]; terminalSteps: Record<number, "completed" | "blocked">; repository?: string | undefined };
  collapsible?: boolean;
}) {
  if (output.content.kind === "decision_blocker") {
    const content = output.content;
    const question = ("askUserQuestion" in content ? content.askUserQuestion.question : undefined) ?? ("question" in content ? content.question : undefined) ?? content.summary;
    return (
      <section data-task-lead-plan className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">Decision blocker</h3>
          <Badge variant="destructive">Human decision</Badge>
        </div>
        <Alert>
          <AlertTitle>{question}</AlertTitle>
          <AlertDescription>
            <p>{output.content.evidence}</p>
            <p><span className="font-medium text-foreground">Next:</span> {output.content.nextAction}</p>
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const contextItems = [
    output.content.reproduction ? ["Reproduction", output.content.reproduction] : null,
    output.content.rootCauseAnalysis ? ["Root cause", output.content.rootCauseAnalysis] : null,
    ["Compatibility", output.content.compatibilityAnalysis],
    ["Operations", output.content.operationalAnalysis],
    ["Verification strategy", output.content.verificationStrategy],
  ].filter((item): item is [string, string] => item !== null && Boolean(item[1]));
  const terminal = new Map<number, string>(Object.entries(stepProgress?.terminalSteps ?? {}).map(([step, status]) => [Number(step), status]));
  for (const event of stepProgress?.events ?? []) if (event.stepNumber !== null && ["step_completed", "step_blocked"].includes(event.kind)) terminal.set(event.stepNumber, event.kind === "step_completed" ? "completed" : "blocked");
  const started = [...(stepProgress?.events ?? [])].reverse().find((event) => event.kind === "step_started" && event.stepNumber !== null && !terminal.has(event.stepNumber));
  const currentStep = started?.stepNumber ?? (stepProgress?.execution.currentStep != null && !terminal.has(stepProgress.execution.currentStep) ? stepProgress.execution.currentStep : null);
  const executionStep = [...(stepProgress?.events ?? [])].reverse().find((event) => event.stepNumber !== null)?.stepNumber ?? stepProgress?.execution.currentStep ?? null;
  const activeStep = currentStep === null ? null : `step-${currentStep}`;
  const [openSteps, setOpenSteps] = useState<string[]>(activeStep ? [activeStep] : []);
  useEffect(() => {
    if (stepProgress) setOpenSteps(activeStep ? [activeStep] : []);
  }, [activeStep, stepProgress?.execution.id]);

  const heading = <span className="font-semibold">Plan: {output.content.gitPresentation?.pullRequestTitle ?? "Analyst plan"}</span>;
  const details = <>
    <p className="whitespace-pre-wrap text-[13px] leading-5">{output.summary}</p>
        <Timeline value={currentStep ?? Math.max(0, ...terminal.keys())} orientation="vertical" data-plan-steps>
          {output.content.steps.map((step) => (
            <Collapsible.Root key={step.number} open={openSteps.includes(`step-${step.number}`)} onOpenChange={(open) => setOpenSteps((steps) => open ? [...steps, `step-${step.number}`] : steps.filter((value) => value !== `step-${step.number}`))}>
              <TimelineItem step={step.number} aria-current={currentStep === step.number ? "step" : undefined}>
                <TimelineHeader>
                  <TimelineSeparator />
                  <TimelineIndicator />
                  <Collapsible.Trigger className="group/plan-step flex w-full items-start justify-between gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="min-w-0 text-[13px] leading-5">Step {step.number} · {terminal.get(step.number) ?? (currentStep === step.number ? "active" : "pending")} — {step.instruction}</span>
                    <ChevronDown className="mt-0.5 size-4 shrink-0 transition-transform group-data-[panel-open]/plan-step:rotate-180" />
                  </Collapsible.Trigger>
                </TimelineHeader>
                <Collapsible.Panel render={<TimelineContent />}>
                {stepProgress && executionStep === step.number ? <div className="mb-3"><DeveloperEvidence taskId={stepProgress.taskId} execution={stepProgress.execution} repository={stepProgress.repository} /></div> : null}
                <div className="grid gap-1 pl-1 text-[13px] sm:grid-cols-[76px_minmax(0,1fr)]">
                  {step.entryPoint ? <><span className="font-medium text-muted-foreground">Entry</span><p className="whitespace-pre-wrap">{step.entryPoint}</p></> : null}
                  {step.completionCriterion ? <><span className="font-medium text-muted-foreground">Complete</span><p className="whitespace-pre-wrap">{step.completionCriterion}</p></> : null}
                  <span className="font-medium text-muted-foreground">Verify</span>
                  <p className="whitespace-pre-wrap">{step.verification}</p>
                </div>
                {(stepProgress?.events ?? []).some((event) => event.stepNumber === step.number && !["step_started", "step_completed"].includes(event.kind)) ? <div className="mt-2 grid gap-1" data-step-events={step.number}>{stepProgress!.events.filter((event) => event.stepNumber === step.number && !["step_started", "step_completed"].includes(event.kind)).map((event) => <div className="grid min-h-8 min-w-0 grid-cols-[3rem_minmax(0,1fr)_3.5rem] items-center gap-2 border-l-2 border-border pl-2 text-xs" key={event.eventId}><span>#{event.sequence}</span><code className="break-words whitespace-pre-wrap">{event.summary}</code><span className={event.exitCode !== null && event.exitCode !== 0 ? "font-medium text-destructive" : "text-muted-foreground"}>{event.kind === "step_blocked" ? "blocked" : event.kind === "file_change" ? "changed" : event.exitCode === null ? "—" : `exit ${event.exitCode}`}</span></div>)}</div> : null}
                </Collapsible.Panel>
              </TimelineItem>
            </Collapsible.Root>
          ))}
        </Timeline>
          {contextItems.length || output.content.unresolvedTechnicalQuestions.length ? (
          <Accordion>
            <AccordionItem value="implementation-context">
              <AccordionTrigger>Implementation context</AccordionTrigger>
              <AccordionContent>
                <dl className="space-y-3 text-[13px]">
                  {contextItems.map(([label, value]) => (
                    <div key={label} className="grid gap-1 sm:grid-cols-[132px_minmax(0,1fr)]">
                      <dt className="font-medium text-muted-foreground">{label}</dt>
                      <dd className="whitespace-pre-wrap">{value}</dd>
                    </div>
                  ))}
                  {output.content.unresolvedTechnicalQuestions.length ? (
                    <div className="grid gap-1 sm:grid-cols-[132px_minmax(0,1fr)]">
                      <dt className="font-medium text-muted-foreground">Open questions</dt>
                      <dd><ul className="list-disc space-y-1 pl-4">{output.content.unresolvedTechnicalQuestions.map((question) => <li key={question}>{question}</li>)}</ul></dd>
                    </div>
                  ) : null}
                </dl>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          ) : null}
  </>;
  return (
    <Card data-task-lead-plan size="sm">
      <CardContent>
        {collapsible ? <Collapsible.Root>
          <Collapsible.Trigger render={<Button variant="ghost" size="sm" />}><span className="flex w-full flex-wrap items-center justify-between gap-2">{heading}<ChevronDown /></span></Collapsible.Trigger>
          <Collapsible.Panel><div className="mt-3 flex flex-col gap-3">{details}</div></Collapsible.Panel>
        </Collapsible.Root> : <><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">{heading}</h3></div>{details}</>}
      </CardContent>
      {decisionControls ? <CardFooter data-plan-decision-controls>{decisionControls}</CardFooter> : null}
    </Card>
  );
}
