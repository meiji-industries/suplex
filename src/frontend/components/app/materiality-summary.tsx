import { Badge } from "../ui/badge.js";

export interface MaterialityView { categories: string[]; artifactId: string; artifactSha256: string; evidence?: Array<{ category: string; rationale: string; evidenceRefs: string[] }> }

export function MaterialitySummary({ value }: { value: MaterialityView }) {
  const routine = value.categories.length === 0;
  return <section className="space-y-2" data-materiality><div className="flex items-center gap-2"><h3 className="text-xs font-semibold">Materiality</h3><Badge variant="secondary">{routine ? "Routine" : "Material"}</Badge></div>{routine ? <p className="text-[11px] text-muted-foreground">No material categories were declared or inferred.</p> : <div className="space-y-1">{value.categories.map((category) => { const evidence = value.evidence?.find((item) => item.category === category); return <details key={category}><summary className="cursor-pointer text-xs font-medium">{category}</summary><div className="space-y-1 pl-3 text-[11px] text-muted-foreground"><div>{evidence?.rationale ?? "Deterministic path evidence"}</div>{evidence?.evidenceRefs.map((ref) => <div key={ref}>{ref}</div>)}</div></details>; })}</div>}<div className="text-[11px] text-muted-foreground" title={value.artifactSha256}>Evidence artifact {value.artifactId.slice(0, 12)}…</div></section>;
}
