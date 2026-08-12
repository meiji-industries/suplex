import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Badge } from "../ui/badge.js";

type LeadPlanContent = {
  kind: "plan";
  summary: string;
  reproduction: string | null;
  rootCauseAnalysis: string | null;
  steps: Array<{ number: number; instruction: string; entryPoint?: string | null; completionCriterion?: string; verification: string }>;
  compatibilityAnalysis: string;
  operationalAnalysis: string;
  verificationStrategy: string;
  unresolvedTechnicalQuestions: string[];
};

type DecisionBlockerContent = {
  kind: "decision_blocker";
  summary: string;
  evidence: string;
  owner: "human";
  question: string;
  nextAction: string;
};

export type TaskLeadOutput = {
  kind: "plan" | "decision_blocker";
  summary: string;
  content: LeadPlanContent | DecisionBlockerContent;
};

function detailLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export function TaskLeadPlan({
  output,
  planRevision,
  planMaterial,
  materialCategories,
}: {
  output: TaskLeadOutput;
  planRevision: number | null | undefined;
  planMaterial: boolean | null | undefined;
  materialCategories: string[];
}) {
  if (output.content.kind === "decision_blocker") {
    return (
      <section data-task-lead-plan className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">Decision blocker</h3>
          <Badge variant="destructive">Human decision</Badge>
        </div>
        <Alert>
          <AlertTitle>{output.content.question}</AlertTitle>
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

  return (
    <section data-task-lead-plan className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">Lead plan</h3>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {planRevision ? <Badge variant="outline">Revision {planRevision}</Badge> : null}
          {planMaterial ? <Badge variant="secondary">Material</Badge> : null}
          {materialCategories.map((category) => <Badge key={category} variant="outline">{detailLabel(category)}</Badge>)}
        </div>
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-5">{output.summary}</p>
      <Accordion multiple>
        {output.content.steps.map((step) => (
          <AccordionItem key={step.number} value={`step-${step.number}`}>
            <AccordionTrigger>
              <span className="min-w-0 pr-3 text-[13px] leading-5">{step.instruction}</span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-1 pl-1 text-[13px] sm:grid-cols-[76px_minmax(0,1fr)]">
                {step.entryPoint ? <><span className="font-medium text-muted-foreground">Entry</span><p className="whitespace-pre-wrap">{step.entryPoint}</p></> : null}
                {step.completionCriterion ? <><span className="font-medium text-muted-foreground">Complete</span><p className="whitespace-pre-wrap">{step.completionCriterion}</p></> : null}
                <span className="font-medium text-muted-foreground">Verify</span>
                <p className="whitespace-pre-wrap">{step.verification}</p>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
        {contextItems.length || output.content.unresolvedTechnicalQuestions.length ? (
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
        ) : null}
      </Accordion>
    </section>
  );
}
