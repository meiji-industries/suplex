import { Badge } from "../ui/badge.js";

export interface SupplementalReviewView { reviewer: { name: string }; verdict: "approve" | "revise"; summary: string; concerns: Array<{ severity: "blocking" | "advisory"; text: string; step?: number | undefined }>; plannerResponse?: string | undefined }

export function SupplementalReviewPanel({ value }: { value: SupplementalReviewView }) {
  return <section className="space-y-2 border-t pt-3" data-supplemental-review><div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold">Reviewer’s take</h3><span className="text-[11px] text-muted-foreground">{value.reviewer.name}</span></div><p className="text-[12px] text-muted-foreground">{value.summary}</p>{value.concerns.length ? <ul className="space-y-1 text-[12px]">{value.concerns.map((concern, index) => <li className="flex items-start gap-2" key={`${concern.text}-${index}`}><Badge variant={concern.severity === "blocking" ? "destructive" : "secondary"}>{concern.severity}</Badge><span>{concern.text}{concern.step ? ` (step ${concern.step})` : ""}</span></li>)}</ul> : null}{value.plannerResponse ? <div className="border-l-2 pl-2 text-[12px] text-muted-foreground"><span className="font-medium text-foreground">Planner response: </span>{value.plannerResponse}</div> : null}</section>;
}
