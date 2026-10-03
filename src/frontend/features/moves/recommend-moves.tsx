import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareText, RotateCcw, SquareTerminal } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Shimmer } from "../../components/ai-elements/shimmer.js";
import { CompactCard } from "../../components/app/compact-card.js";
import { ProjectSelect } from "../../components/app/project-select.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Spinner } from "../../components/ui/spinner.js";
import type { MoveRecommendation } from "../../contracts/generated/MoveRecommendation.js";
import type { MoveResponse } from "../../contracts/generated/MoveResponse.js";
import type { ApiProject } from "../../shell/view-shared.js";
import { createMove, recommendMoves } from "./lib/move-api.js";
import { runnerLabels } from "./move-dialog.js";

const phrases = ["Reading package.json", "Looking for Makefile targets", "Checking mise tasks", "Reading CI workflows", "Looking in scripts and bin", "Reading the README", "Drafting moves"];

function Thinking(): ReactElement {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex(value => (value + 1) % phrases.length), 2400);
    return () => window.clearInterval(timer);
  }, []);
  return <div role="status" className="flex items-center justify-center gap-2 py-4 text-sm">
    <Spinner />
    <Shimmer key={index} as="span" duration={1.6}>{`${phrases[index]}…`}</Shimmer>
  </div>;
}

/**
 * Moves that the project's default Worker proposes after it reads the
 * repository. All are selected at first; import creates the selected ones.
 */
export function RecommendMoves({ companyId, projects, moves, initialProjectId, onImported }: {
  companyId: string;
  projects: ApiProject[];
  /** The company's moves. A recommendation whose name a project already uses stays hidden. */
  moves: MoveResponse[];
  initialProjectId: string;
  onImported: (count: number) => void;
}): ReactElement {
  const [projectId, setProjectId] = useState(initialProjectId);
  const queries = useQueryClient();
  // One read per project and session: the agent run takes minutes and costs tokens.
  const query = useQuery({
    queryKey: ["move-recommendations", projectId],
    queryFn: ({ signal }) => recommendMoves(projectId, signal),
    enabled: Boolean(projectId),
    staleTime: Infinity,
    retry: false,
  });
  const taken = new Set(moves.filter(move => move.projectId === projectId).map(move => move.name.trim().toLowerCase()));
  const recommendations = (query.data?.recommendations ?? []).filter(item => !taken.has(item.name.trim().toLowerCase()));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setSelected(new Set(query.data?.recommendations.map(item => item.name) ?? [])); setError(""); }, [query.data]);
  const toggle = (name: string, on: boolean): void => setSelected(current => { const next = new Set(current); if (on) next.add(name); else next.delete(name); return next; });
  const chosen = recommendations.filter(item => selected.has(item.name));
  const retry = (): void => { void queries.resetQueries({ queryKey: ["move-recommendations", projectId] }); };
  const importChosen = async (): Promise<void> => {
    setImporting(true); setError("");
    const failed: string[] = [];
    for (const item of chosen) {
      try { await createMove(companyId, { projectId, name: item.name, prompt: item.prompt, runner: item.runner, profileId: null, confirm: false }); }
      catch (cause) { failed.push(`${item.name}: ${cause instanceof Error ? cause.message : "not imported"}`); }
    }
    setImporting(false);
    const imported = chosen.length - failed.length;
    if (failed.length) {
      setSelected(new Set(chosen.filter(item => failed.some(line => line.startsWith(`${item.name}:`))).map(item => item.name)));
      setError(failed.join(" "));
    }
    if (imported) onImported(imported);
  };
  return <section aria-label="Recommended moves" className="grid gap-3">
    {!query.isFetching || projects.length > 1 ? <div className="flex flex-wrap items-center gap-2">
      {!query.isFetching && recommendations.length > 0 ? <h2 className="text-sm font-medium">Recommended moves</h2> : null}
      {projects.length > 1 ? <ProjectSelect label="Project to read" projects={projects} value={projectId} disabled={query.isFetching || importing} onChange={setProjectId} /> : null}
      {query.isFetching ? null : <Button variant="ghost" size="xs" onClick={retry}><RotateCcw />Read again</Button>}
    </div> : null}
    {query.isFetching ? <Thinking /> : query.isError ? <Alert variant="destructive"><AlertDescription>{query.error instanceof Error ? query.error.message : "The agent could not read the project."}</AlertDescription></Alert>
      : !recommendations.length ? <p className="py-6 text-center text-sm text-muted-foreground">No new moves found</p>
      : <>
        <ul className="grid gap-2 sm:grid-cols-2">{recommendations.map(item => <RecommendationCard key={item.name} item={item} checked={selected.has(item.name)} disabled={importing} onCheckedChange={on => toggle(item.name, on)} />)}</ul>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={importing} onClick={() => setSelected(chosen.length ? new Set() : new Set(recommendations.map(item => item.name)))}>{chosen.length ? "Select none" : "Select all"}</Button>
          <Button size="sm" disabled={importing || !chosen.length} onClick={() => void importChosen()}>{importing ? <Spinner /> : null}Import {chosen.length} {chosen.length === 1 ? "move" : "moves"}</Button>
        </div>
      </>}
  </section>;
}

function RecommendationCard({ item, checked, disabled, onCheckedChange }: { item: MoveRecommendation; checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void }): ReactElement {
  const id = `recommendation-${item.name.replace(/\W+/g, "-")}`;
  return <li className="min-w-0">
    <CompactCard htmlFor={id}>
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={value => onCheckedChange(value === true)} className="mt-0.5" />
      <span className="grid min-w-0 flex-1 gap-1.5">
        <span className="flex min-w-0 items-center gap-2"><span className="truncate font-medium">{item.name}</span><Badge variant="outline">{item.runner === "script" ? <SquareTerminal /> : <MessageSquareText />}{runnerLabels[item.runner]}</Badge></span>
        <span className={`line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground ${item.runner === "script" ? "font-mono" : ""}`}>{item.runner === "script" ? `$ ${item.prompt}` : item.prompt}</span>
        {item.reason || item.source ? <span className="text-[11px] text-muted-foreground">{[item.source, item.reason].filter(Boolean).join(" · ")}</span> : null}
      </span>
    </CompactCard>
  </li>;
}
