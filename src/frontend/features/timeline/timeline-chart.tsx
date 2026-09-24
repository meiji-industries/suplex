import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";
import { TimelineAgentLabel } from "./timeline-agent-label.js";
import { withCompany } from "../../lib/api.js";
import {
  clampTimelineRange,
  type TimelineRange,
  type WorkTimelineSummary,
} from "./timeline-model.js";
import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { formatDuration, titleCase } from "./timeline-format.js";
import { TimelineMiniMap } from "./timeline-minimap.js";

type AgentRole = "root" | "worker";

const roleColors: Record<AgentRole, string> = {
  root: "bg-blue-500",
  worker: "bg-amber-500",
};

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function axisLabel(timestamp: number, durationMs: number): string {
  const options: Intl.DateTimeFormatOptions =
    durationMs <= 86_400_000
      ? {
          hour: "numeric",
          minute: "2-digit",
          ...(durationMs < 60_000 ? { second: "2-digit" as const } : {}),
        }
      : durationMs <= 8 * 86_400_000
        ? { weekday: "short", month: "short", day: "numeric" }
        : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(
    new Date(timestamp),
  );
}

export function WorkChart({
  summary,
  overview,
  range,
  fullRange,
  companyId,
  now,
  onRangeChange,
}: {
  summary: WorkTimelineSummary;
  overview: WorkTimelineSummary;
  range: TimelineRange;
  fullRange: TimelineRange;
  companyId: string;
  now: number;
  onRangeChange: (range: TimelineRange) => void;
}): ReactElement {
  const durationMs = range.end - range.start;
  const ticks = Array.from(
    { length: 6 },
    (_, index) => range.start + (durationMs * index) / 6,
  );
  const nowPosition = ((now - range.start) / durationMs) * 100;
  const chart = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<{ anchor: number; current: number } | null>(null);
  const [selection, setSelection] = useState<{
    anchor: number;
    current: number;
  } | null>(null);
  const fractionAt = (clientX: number, requirePlot = false): number | null => {
    const rect = chart.current?.getBoundingClientRect();
    if (!rect || (requirePlot && clientX < rect.left + 208)) return null;
    return Math.max(
      0,
      Math.min(1, (clientX - rect.left - 208) / Math.max(1, rect.width - 208)),
    );
  };
  const startSelection = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest("a, button"))
      return;
    const fraction = fractionAt(event.clientX, true);
    if (fraction === null) return;
    event.preventDefault();
    const next = { anchor: fraction, current: fraction };
    selectionRef.current = next;
    setSelection(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveSelection = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = selectionRef.current;
    const fraction = fractionAt(event.clientX);
    if (!active || fraction === null) return;
    const next = { ...active, current: fraction };
    selectionRef.current = next;
    setSelection(next);
  };
  const endSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
    apply: boolean,
  ): void => {
    const active = selectionRef.current;
    const releasedAt = fractionAt(event.clientX);
    selectionRef.current = null;
    setSelection(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const rect = chart.current?.getBoundingClientRect();
    if (
      !apply ||
      !active ||
      releasedAt === null ||
      !rect ||
      Math.abs(releasedAt - active.anchor) * (rect.width - 208) < 8
    )
      return;
    const startFraction = Math.min(active.anchor, releasedAt);
    const endFraction = Math.max(active.anchor, releasedAt);
    onRangeChange(
      clampTimelineRange(
        {
          start: range.start + durationMs * startFraction,
          end: range.start + durationMs * endFraction,
        },
        range,
      ),
    );
  };
  return (
    <TooltipProvider>
      <div
        className="min-w-0 border-t border-border/70"
        data-work-timeline
        data-range-start={range.start}
        data-range-end={range.end}
      >
        <div
          ref={chart}
          aria-label="Timeline chart. Drag across the plot to zoom."
          className="relative w-full min-w-0 cursor-crosshair touch-pan-y select-none"
          onPointerDown={startSelection}
          onPointerMove={moveSelection}
          onPointerUp={(event) => endSelection(event, true)}
          onPointerCancel={(event) => endSelection(event, false)}
        >
          <div className="flex h-9 border-b border-border/70 bg-muted/30 text-xs text-muted-foreground">
            <div className="flex w-52 shrink-0 items-center border-r border-border/70 px-3 font-medium sm:px-4">
              Agent
            </div>
            <div className="grid min-w-0 flex-1 grid-cols-3 items-center sm:grid-cols-6">
              {ticks.map((tick, index) => (
                <time
                  key={tick}
                  dateTime={new Date(tick).toISOString()}
                  className={`min-w-0 overflow-hidden border-r border-border/55 px-2 last:border-r-0 ${index % 2 ? "hidden sm:block" : ""}`}
                >
                  {axisLabel(tick, durationMs)}
                </time>
              ))}
            </div>
          </div>
          {summary.lanes.map((lane) => {
            const laneHeight = Math.max(38, 10 + lane.trackCount * 22);
            return (
              <div
                key={lane.key}
                className="flex border-b border-border/55 last:border-b-0"
                style={{ minHeight: laneHeight }}
              >
                <div className="flex w-52 shrink-0 items-center gap-2 border-r border-border/70 px-3 sm:px-4">
                  <TimelineAgentLabel
                    avatarSeed={lane.avatarSeed}
                    name={lane.name}
                    role={lane.roles.map(titleCase).join(" / ")}
                    executionCount={lane.intervals.length}
                    duration={formatDuration(lane.durationMs)}
                  />
                </div>
                <div className="relative min-w-0 flex-1 overflow-hidden bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[size:16.6667%_100%]">
                  {nowPosition >= 0 && nowPosition <= 100 ? (
                    <div
                      aria-label="Now"
                      className="absolute inset-y-0 z-[1] w-px bg-emerald-500"
                      style={{ left: `${nowPosition}%` }}
                    />
                  ) : null}
                  {lane.intervals.map((interval) => {
                    const left =
                      ((interval.start - range.start) / durationMs) * 100;
                    const width =
                      ((interval.end - interval.start) / durationMs) * 100;
                    const inactive =
                      interval.status === "failed" ||
                      interval.status === "cancelled";
                    return (
                      <div
                        key={interval.id}
                        className="absolute h-4"
                        style={{
                          left: `${left}%`,
                          top: 7 + interval.track * 22,
                          width: `max(${width}%, 5px)`,
                        }}
                      >
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <a
                                aria-label={`${interval.agentName} worked on ${interval.issueKey ? `${interval.issueKey} ` : ""}${interval.taskTitle} for ${formatDuration(interval.durationMs)}`}
                                className={`block h-full w-full rounded-sm border border-background/80 ${roleColors[interval.role]} ${inactive ? "opacity-45" : "opacity-85"} hover:opacity-100 focus-visible:outline-2 focus-visible:outline-ring`}
                                href={withCompany(
                                  `/tasks/${encodeURIComponent(interval.taskId)}`,
                                  companyId,
                                )}
                              />
                            }
                          />
                          <TooltipContent>
                            <span className="flex flex-col">
                              <span className="font-medium">
                                {interval.issueKey ? (
                                  <span className="mr-1.5 font-normal text-muted-foreground">
                                    {interval.issueKey}
                                  </span>
                                ) : null}
                                {interval.taskTitle}
                              </span>
                              <span>
                                {titleCase(interval.role)} · {interval.status} ·
                                attempt {interval.attempt}
                              </span>
                              <span>
                                {formatTimestamp(interval.start)} –{" "}
                                {formatTimestamp(interval.end)} ·{" "}
                                {formatDuration(interval.durationMs)}
                              </span>
                            </span>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {summary.lanes.length === 0 ? (
            <div className="flex h-14 border-b border-border/55">
              <div className="flex w-52 shrink-0 items-center border-r border-border/70 px-3 text-xs text-muted-foreground sm:px-4">
                No activity
              </div>
              <div className="min-w-0 flex-1 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[size:16.6667%_100%]" />
            </div>
          ) : null}
          {selection ? (
            <div className="pointer-events-none absolute inset-y-9 left-52 right-0 z-20">
              <span
                className="absolute inset-y-0 border-x border-primary bg-primary/15"
                style={{
                  left: `${Math.min(selection.anchor, selection.current) * 100}%`,
                  width: `${Math.abs(selection.current - selection.anchor) * 100}%`,
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
      <TimelineMiniMap
        summary={overview}
        fullRange={fullRange}
        visibleRange={range}
        onRangeChange={onRangeChange}
      />
    </TooltipProvider>
  );
}
