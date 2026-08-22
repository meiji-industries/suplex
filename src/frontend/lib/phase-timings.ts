import { ISSUE_PHASES, phaseLabel, type IssuePhase } from "../../issue-phases.js";

export type PhaseTimingActivity = { eventType: string; createdAt: string };

export type PhaseTiming = {
  phase: IssuePhase;
  label: string;
  startAt: string;
  endAt: string;
  durationMs: number;
  current: boolean;
};

function phaseFromEvent(eventType: string): IssuePhase | undefined {
  if (!eventType.startsWith("phase_")) return undefined;
  const phase = eventType.slice("phase_".length);
  return (ISSUE_PHASES as readonly string[]).includes(phase) ? phase as IssuePhase : undefined;
}

/** Derives each visit to a workflow phase from durable activity-feed rows. */
export function phaseTimings(activity: PhaseTimingActivity[], currentPhase: IssuePhase, asOf = new Date().toISOString()): PhaseTiming[] {
  const phaseChanges = activity
    .map((entry) => ({ phase: phaseFromEvent(entry.eventType), at: entry.createdAt }))
    .filter((entry): entry is { phase: IssuePhase; at: string } => entry.phase !== undefined && Number.isFinite(Date.parse(entry.at)))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const end = Number.isFinite(Date.parse(asOf)) ? asOf : new Date().toISOString();

  return phaseChanges.map((entry, index) => {
    const endAt = phaseChanges[index + 1]?.at ?? end;
    return {
      phase: entry.phase,
      label: phaseLabel(entry.phase),
      startAt: entry.at,
      endAt,
      durationMs: Math.max(0, Date.parse(endAt) - Date.parse(entry.at)),
      current: index === phaseChanges.length - 1 && entry.phase === currentPhase,
    };
  });
}

export function phaseTimingDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
