import { Badge } from "../ui/badge.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import type { PublicPlanSubject } from "../../../plan-governance.js";

export type PlanSubjectView = PublicPlanSubject;

export function PlanSubjectSummary({ subject, current = true, label, createdAt, detailsOnly = false }: { subject: PlanSubjectView; current?: boolean; label?: string; createdAt?: string; detailsOnly?: boolean }) {
  const details = createdAt ? <dl className="text-[11px] text-muted-foreground"><div><dt>Created</dt><dd>{createdAt}</dd></div></dl> : null;
  return <section data-plan-subject>{detailsOnly ? details : <Accordion><AccordionItem value={subject.outputId}><AccordionTrigger><span>{label ?? "Plan"} <Badge variant={current ? "secondary" : "outline"}>{current ? "Current" : "Earlier plan"}</Badge></span></AccordionTrigger><AccordionContent>{details}</AccordionContent></AccordionItem></Accordion>}</section>;
}
