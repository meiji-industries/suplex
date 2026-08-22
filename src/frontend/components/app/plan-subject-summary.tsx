import { Badge } from "../ui/badge.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import type { PublicPlanSubject } from "../../../plan-governance.js";

export type PlanSubjectView = PublicPlanSubject;

export function PlanSubjectSummary({ subject, current = true, label, createdAt, detailsOnly = false }: { subject: PlanSubjectView; current?: boolean; label?: string; createdAt?: string; detailsOnly?: boolean }) {
  const details = <dl className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><div><dt>Artifact</dt><dd className="break-all">{subject.artifactId}</dd></div><div><dt>Issue / workflow</dt><dd className="break-all">{subject.issueId} / {subject.workflowId}</dd></div><div><dt>Lineage</dt><dd>Original revision {subject.originalPlanRevision} · version {subject.finalVersion} · output {subject.outputId}</dd></div><div><dt>Planner execution</dt><dd className="break-all">{subject.leadExecutionId}</dd></div>{createdAt ? <div><dt>Created</dt><dd>{createdAt}</dd></div> : null}</dl>;
  return <section data-plan-subject>{detailsOnly ? details : <Accordion><AccordionItem value={subject.outputId}><AccordionTrigger><span>{label ?? (subject.finalVersion === 1 ? "Original plan" : `Final plan v${subject.finalVersion}`)} <Badge variant={current ? "secondary" : "outline"}>{current ? "Current" : "Superseded"}</Badge></span></AccordionTrigger><AccordionContent>{details}</AccordionContent></AccordionItem></Accordion>}</section>;
}
