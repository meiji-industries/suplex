import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";
import { Maximize2, Minimize2, RotateCcw, Square, SquareTerminal, X, Zap } from "lucide-react";

import wordmark from "../../assets/suplex-wordmark.svg?inline";

import { EmptyState } from "../../components/app/empty-state.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { ProjectLabel } from "../../components/app/project-label.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import type { MoveResponse } from "../../contracts/generated/MoveResponse.js";
import type { MoveRunResponse } from "../../contracts/generated/MoveRunResponse.js";
import { relativeTime, type ApiProject } from "../../shell/view-shared.js";
import { endMoveRun, getMoveRun, moveRunTerminalPath } from "./lib/move-api.js";

const RunTranscript = lazy(() => import("./run-transcript.js").then(module => ({ default: module.RunTranscript })));
const PaneTerminal = lazy(() => import("../tasks/task-chat/live-pane-terminal.js").then(module => ({ default: module.PaneTerminal })));

/** A move's terminal under one bar that summarizes the run. It fills the page and can expand to full screen. */
export function MoveRunView({ move, runId, project, onClose, onStartAgain }: {
  move: MoveResponse;
  runId: string;
  project: ApiProject | undefined;
  onClose: () => void;
  onStartAgain: (run: MoveRunResponse) => void;
}): ReactElement {
  const [run, setRun] = useState<MoveRunResponse | null>(null);
  const [error, setError] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let current = true;
    const read = (): void => {
      getMoveRun(runId)
        .then(next => { if (current) { setRun(next); setError(""); } })
        .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : "The run is not available"); });
    };
    read();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") read(); }, 3000);
    return () => { current = false; window.clearInterval(timer); };
  }, [runId]);
  const live = run?.live ?? !error;
  const end = async (): Promise<void> => {
    await endMoveRun(runId).catch(() => undefined);
    setRun(current => current ? { ...current, live: false } : current);
  };
  return <div className={fullscreen ? "fixed inset-0 z-50 flex flex-col bg-background" : "flex min-h-0 flex-1 flex-col"} {...(fullscreen ? { role: "dialog", "aria-modal": true, "aria-label": move.name } : {})}>
    <div className="flex h-11 shrink-0 items-center gap-3 border-b px-3 text-sm">
      {fullscreen ? <><img src={wordmark} alt="Suplex" className="h-4 w-auto invert dark:invert-0" /><Zap className="hidden size-4 shrink-0 text-primary sm:block" aria-hidden="true" /><span className="truncate font-medium">{move.name}</span></> : null}
      <span className="hidden min-w-0 items-center gap-1.5 text-muted-foreground sm:flex"><ProjectLabel project={project} fallback="Not available" /></span>
      {run ? <span className="hidden min-w-0 items-center gap-1 overflow-hidden md:flex">{Object.entries(run.inputs).map(([name, value]) => <Badge key={name} variant="outline">{name} {value || "∅"}</Badge>)}</span> : null}
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className={live ? "size-1.5 rounded-full bg-primary motion-safe:animate-pulse" : "size-1.5 rounded-full bg-muted-foreground/40"} aria-hidden="true" />
        {live ? "Live" : "Ended"}<span className="hidden sm:inline">{run ? ` · ${relativeTime(run.startedAt)}` : ""}</span>
        {run?.startedBy ? <span className="hidden items-center gap-1.5 sm:flex">·{run.startedById ? <EntityAvatar kind="user" id={run.startedById} name={run.startedBy} size="xs" /> : null}{run.startedBy}</span> : null}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {live ? <Button variant="ghost" size="sm" onClick={() => void end()}><Square />Stop</Button> : null}
        <Button variant="ghost" size="sm" disabled={!run} aria-label="Start again" title="Start again" onClick={() => { if (run) onStartAgain(run); }}><RotateCcw /><span className="hidden sm:inline">Start again</span></Button>
        <Button variant="ghost" size="icon-sm" aria-label={fullscreen ? "Exit full screen" : "Full screen"} title={fullscreen ? "Exit full screen" : "Full screen"} onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close" title="Close" onClick={onClose}><X /></Button>
      </div>
    </div>
    <div className="flex min-h-0 flex-1 flex-col p-2">
      {live ? <Suspense fallback={null}><PaneTerminal path={moveRunTerminalPath(runId)} interactive paneId={runId} label={`Terminal for ${move.name}`} /></Suspense> : error ? <EmptyState icon={SquareTerminal} title={error} /> : <Suspense fallback={null}><RunTranscript runId={runId} label={`Saved terminal for ${move.name}`} /></Suspense>}
    </div>
  </div>;
}
