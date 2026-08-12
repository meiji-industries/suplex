import { Badge } from "../ui/badge.js";

export interface PlanSubjectView {
  companyId: string;
  issueId: string;
  workflowId: string;
  outputId: string;
  finalVersion: number;
  artifactId: string;
  artifactSha256: string;
  originalPlanRevision: number;
  leadExecutionId: string;
  evidenceManifestArtifactId: string;
  evidenceManifestSha256: string;
}

export function PlanSubjectSummary({ subject, current = true, label, createdAt }: { subject: PlanSubjectView; current?: boolean; label?: string; createdAt?: string }) {
  return <section className="space-y-2" data-plan-subject><div className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-semibold">{label ?? (subject.finalVersion === 1 ? "Original plan" : `Final plan v${subject.finalVersion}`)}</h3><Badge variant={current ? "secondary" : "outline"}>{current ? "Current" : "Superseded"}</Badge></div><dl className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><div><dt>Artifact</dt><dd className="break-all">{subject.artifactId}</dd></div><div><dt>SHA-256</dt><dd className="break-all">{subject.artifactSha256}</dd></div><div><dt>Issue / workflow</dt><dd className="break-all">{subject.issueId} / {subject.workflowId}</dd></div><div><dt>Lineage</dt><dd>Original revision {subject.originalPlanRevision} · version {subject.finalVersion} · output {subject.outputId}</dd></div><div><dt>Lead execution</dt><dd className="break-all">{subject.leadExecutionId}</dd></div>{createdAt ? <div><dt>Created</dt><dd>{createdAt}</dd></div> : null}</dl></section>;
}
