import { useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { ChevronDown } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Badge } from "../ui/badge.js";
import { Collapsible } from "../ui/collapsible.js";
import { Plan, PlanAction, PlanContent, PlanDescription, PlanFooter, PlanHeader, PlanTitle, PlanTrigger } from "../ui/plan.js";
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator } from "../ui/timeline.js";
import { Markdown } from "./markdown.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";

export type TaskLeadOutput = NonNullable<TaskResponse["leadOutput"]>;

export function TaskLeadPlan({
  output,
  decisionControls,
  collapsible = false,
}: {
  output: TaskLeadOutput;
  decisionControls?: ReactNode;
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
  const [openSteps, setOpenSteps] = useState<string[]>([]);
  const headingText = `Plan: ${output.content.gitPresentation?.pullRequestTitle ?? "Planner plan"}`;
  const details = <>
    <Markdown source={output.summary} />
        <Timeline orientation="vertical" value={0} data-plan-steps>
          {output.content.steps.map((step) => {
            return (
              <TimelineItem key={step.number} step={step.number}>
                <Collapsible.Root open={openSteps.includes(`step-${step.number}`)} onOpenChange={(open) => setOpenSteps((steps) => open ? [...steps, `step-${step.number}`] : steps.filter((value) => value !== `step-${step.number}`))}>
                  <TimelineHeader>
                    <TimelineSeparator />
                    <TimelineIndicator className="flex size-6 items-center justify-center border-none bg-muted text-[11px] font-semibold text-muted-foreground">{step.number}</TimelineIndicator>
                    <Collapsible.Trigger className="group/plan-step flex w-full items-start justify-between gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <div className="min-w-0 text-[13px] leading-5"><span>Step {step.number} — </span><Markdown source={step.instruction} /></div>
                      <ChevronDown className="mt-0.5 size-4 shrink-0 transition-transform group-data-[panel-open]/plan-step:rotate-180" />
                    </Collapsible.Trigger>
                  </TimelineHeader>
                  <Collapsible.Panel render={<TimelineContent />}>
                  <div className="grid gap-1 pl-1 text-[13px] sm:grid-cols-[76px_minmax(0,1fr)]">
                    {step.entryPoint ? <><span className="font-medium text-muted-foreground">Entry</span><Markdown source={step.entryPoint} /></> : null}
                    {step.completionCriterion ? <><span className="font-medium text-muted-foreground">Complete</span><Markdown source={step.completionCriterion} /></> : null}
                    <span className="font-medium text-muted-foreground">Verify</span>
                    <Markdown source={step.verification} />
                  </div>
                  </Collapsible.Panel>
                </Collapsible.Root>
              </TimelineItem>
            );
          })}
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
                      <dd><Markdown source={value} /></dd>
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
    <Plan data-task-lead-plan defaultOpen={!collapsible}>
      <PlanHeader>
        <PlanTitle>{headingText}</PlanTitle>
        {output.content.gitPresentation?.pullRequestDescription ? <PlanDescription>{output.content.gitPresentation.pullRequestDescription}</PlanDescription> : null}
        <PlanAction><PlanTrigger label={`Toggle ${headingText}`} /></PlanAction>
      </PlanHeader>
      <PlanContent><div className="flex flex-col gap-3">{details}</div></PlanContent>
      {decisionControls ? <PlanFooter className="justify-end" data-plan-decision-controls>{decisionControls}</PlanFooter> : null}
    </Plan>
  );
}
