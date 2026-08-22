import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardFooter } from "../ui/card.js";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { DeveloperExecutionEventResponse, TaskResponse } from "../../../http/contracts/tasks.js";

export type DeveloperExecutionView = NonNullable<TaskResponse["developerExecution"]>;
export type DeveloperExecutionEventView = DeveloperExecutionEventResponse;

function duration(startedAt: string, finishedAt: string | null, now: number): string {
  const seconds = Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DeveloperEvidence({ execution, onViewChanges }: { execution: DeveloperExecutionView; onViewChanges: () => void }): ReactElement {
  const running = ["starting", "running", "cancelling"].includes(execution.status) && !execution.finishedAt;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const blocked = execution.status === "blocked";
  return <Card data-developer-evidence size="sm" aria-label="Developer execution">
    <CardContent>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><span className="min-w-0 truncate">Attempt {execution.attempt} · <code title={execution.branchName}>{execution.branchName}</code></span><Badge variant={execution.status === "completed" ? "secondary" : blocked || execution.status === "failed" ? "destructive" : "outline"}>{execution.status}</Badge><span className="tabular-nums text-muted-foreground">{duration(execution.startedAt, execution.finishedAt, now)}</span></div>
      {execution.summary ? <p className={blocked ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{execution.summary}</p> : null}
    </CardContent>
    <CardFooter><Button variant="link" size="sm" onClick={onViewChanges}>View changes</Button></CardFooter>
  </Card>;
}
