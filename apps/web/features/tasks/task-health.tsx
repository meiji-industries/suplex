import { useEffect, useState, type ReactElement } from "react";
import type { z } from "zod";
import { Badge } from "../../components/ui/badge.js";
import type { HarnessKind } from "../../contracts/harness-kind.js";
import type { TaskHealthSchema } from "../../contracts/task-responses.js";

export type TaskHealth = z.infer<typeof TaskHealthSchema>;

const providerLabels = { opencode: "OpenCode", "claude-code": "Claude Code", devin: "Devin", codex: "Codex", pi: "Pi", omp: "OMP" } satisfies Record<HarnessKind, string>;

/** A task without a usual turn time gets this much time before it shows no progress. */
export const NO_PROGRESS_FLOOR_MS = 10 * 60_000;

/** The time since the last progress when it is more than the floor and more than twice the usual turn time, else `null`. */
export function noProgressFor(health: TaskHealth, now: number): number | null {
  if (!health.lastProgressAt) return null;
  const elapsed = now - Date.parse(health.lastProgressAt);
  if (!Number.isFinite(elapsed)) return null;
  return elapsed > Math.max(NO_PROGRESS_FLOOR_MS, 2 * (health.usualTurnSeconds ?? 0) * 1_000) ? elapsed : null;
}

function duration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * One dense row that shows why a task does not advance: a provider that is not connected, retries of the current work,
 * and no progress for longer than usual. A healthy task shows nothing. These are display observations only.
 */
export function TaskHealthBadges({ health, className = "" }: { health: TaskHealth | undefined; className?: string }): ReactElement | null {
  const [now, setNow] = useState(Date.now);
  const lastProgressAt = health?.lastProgressAt;
  useEffect(() => {
    if (!lastProgressAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [lastProgressAt]);
  if (!health) return null;
  const notConnected = health.providers.filter(provider => provider.status === "not-connected");
  const stalled = noProgressFor(health, now);
  if (!notConnected.length && !health.retries && stalled === null) return null;
  return <span data-task-health className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
    {notConnected.map((provider, index) => <Badge key={`${provider.provider}-${index}`} variant="destructive" data-task-health-provider={provider.provider} title={provider.summary}>{providerLabels[provider.provider]} is not connected</Badge>)}
    {health.retries ? <Badge variant="secondary" data-task-health-retries={health.retries}>Retried {health.retries} {health.retries === 1 ? "time" : "times"}</Badge> : null}
    {stalled !== null && lastProgressAt ? <Badge variant="outline" data-task-health-stalled title={`Last progress ${new Date(lastProgressAt).toLocaleString()}`}>No progress for {duration(stalled)}</Badge> : null}
  </span>;
}
