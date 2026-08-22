import { Badge } from "../ui/badge.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";

export interface MaterialityView { categories: string[]; artifactId: string; evidence?: Array<{ category: string; rationale: string; evidenceRefs: string[] }> }

export function MaterialitySummary({ value, detailsOnly = false }: { value: MaterialityView; detailsOnly?: boolean }) {
  const routine = value.categories.length === 0;
  const details = <>{routine ? <p className="text-[11px] text-muted-foreground">This plan can continue without approval.</p> : <div className="space-y-1">{value.categories.map((category) => { const evidence = value.evidence?.find((item) => item.category === category); return <details key={category}><summary className="cursor-pointer text-xs font-medium">{category}</summary>{evidence?.rationale ? <div className="pl-3 text-[11px] text-muted-foreground">{evidence.rationale}</div> : null}</details>; })}</div>}</>;
  return <section data-materiality>{detailsOnly ? details : <Accordion><AccordionItem value="approval"><AccordionTrigger><span>Approval <Badge variant="secondary">{routine ? "Auto-approved" : "Needs your approval"}</Badge></span></AccordionTrigger><AccordionContent>{details}</AccordionContent></AccordionItem></Accordion>}</section>;
}
