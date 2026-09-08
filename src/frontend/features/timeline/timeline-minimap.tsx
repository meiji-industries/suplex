import {
  clampTimelineRange,
  minimumVisibleMs,
  type TimelineRange,
  type WorkTimelineSummary,
} from "./timeline-model.js";
import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

type AgentRole = "root" | "worker";

const roleColors: Record<AgentRole, string> = {
  root: "bg-blue-500",
  worker: "bg-amber-500",
};

export function TimelineMiniMap({
  summary,
  fullRange,
  visibleRange,
  onRangeChange,
}: {
  summary: WorkTimelineSummary;
  fullRange: TimelineRange;
  visibleRange: TimelineRange;
  onRangeChange: (range: TimelineRange) => void;
}): ReactElement {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: "left" | "move" | "right";
    originX: number;
    range: TimelineRange;
  } | null>(null);
  const spanMs = Math.max(1, fullRange.end - fullRange.start);
  const left = ((visibleRange.start - fullRange.start) / spanMs) * 100;
  const width = ((visibleRange.end - visibleRange.start) / spanMs) * 100;
  const laneIndex = new Map(
    summary.lanes.map((lane, index) => [lane.key, index]),
  );
  const laneHeight = 40 / Math.max(1, summary.lanes.length);

  const beginDrag = (
    mode: "left" | "move" | "right",
    event: ReactPointerEvent<HTMLElement>,
    range = visibleRange,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { mode, originX: event.clientX, range };
    surface.current?.setPointerCapture(event.pointerId);
  };
  const seek = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !surface.current) return;
    const rect = surface.current.getBoundingClientRect();
    const center =
      fullRange.start +
      Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)),
      ) *
        spanMs;
    const duration = visibleRange.end - visibleRange.start;
    const next = clampTimelineRange(
      { start: center - duration / 2, end: center + duration / 2 },
      fullRange,
    );
    onRangeChange(next);
    beginDrag("move", event, next);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || !surface.current) return;
    const delta =
      ((event.clientX - active.originX) /
        Math.max(1, surface.current.getBoundingClientRect().width)) *
      spanMs;
    const minimum = Math.min(minimumVisibleMs, spanMs);
    if (active.mode === "left")
      onRangeChange({
        start: Math.max(
          fullRange.start,
          Math.min(active.range.end - minimum, active.range.start + delta),
        ),
        end: active.range.end,
      });
    else if (active.mode === "right")
      onRangeChange({
        start: active.range.start,
        end: Math.min(
          fullRange.end,
          Math.max(active.range.start + minimum, active.range.end + delta),
        ),
      });
    else {
      const duration = active.range.end - active.range.start;
      const start = Math.max(
        fullRange.start,
        Math.min(fullRange.end - duration, active.range.start + delta),
      );
      onRangeChange({ start, end: start + duration });
    }
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (surface.current?.hasPointerCapture(event.pointerId))
      surface.current.releasePointerCapture(event.pointerId);
  };
  const nudge = (
    mode: "left" | "move" | "right",
    direction: -1 | 1,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta =
      direction *
      Math.max(spanMs / 100, (visibleRange.end - visibleRange.start) / 10);
    const minimum = Math.min(minimumVisibleMs, spanMs);
    if (mode === "left")
      onRangeChange({
        start: Math.max(
          fullRange.start,
          Math.min(visibleRange.end - minimum, visibleRange.start + delta),
        ),
        end: visibleRange.end,
      });
    else if (mode === "right")
      onRangeChange({
        start: visibleRange.start,
        end: Math.min(
          fullRange.end,
          Math.max(visibleRange.start + minimum, visibleRange.end + delta),
        ),
      });
    else {
      const duration = visibleRange.end - visibleRange.start;
      const start = Math.max(
        fullRange.start,
        Math.min(fullRange.end - duration, visibleRange.start + delta),
      );
      onRangeChange({ start, end: start + duration });
    }
  };

  return (
    <div className="border-t border-border/70 px-3 py-2 sm:px-4">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Overview</span>
        <span>Drag window or handles</span>
      </div>
      <div
        ref={surface}
        data-timeline-minimap
        className="relative h-12 touch-none select-none overflow-hidden border border-border/70 bg-muted/20"
        onPointerDown={seek}
        onPointerMove={move}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {summary.intervals.map((interval) => {
          const intervalLeft =
            ((interval.start - fullRange.start) / spanMs) * 100;
          const intervalWidth =
            ((interval.end - interval.start) / spanMs) * 100;
          const top = 4 + (laneIndex.get(interval.agentKey) ?? 0) * laneHeight;
          return (
            <span
              key={interval.id}
              className={`pointer-events-none absolute ${roleColors[interval.role]} ${interval.status === "failed" || interval.status === "cancelled" ? "opacity-40" : "opacity-80"}`}
              style={{
                left: `${intervalLeft}%`,
                top,
                width: `max(${intervalWidth}%, 2px)`,
                height: Math.max(2, laneHeight - 1),
              }}
            />
          );
        })}
        <button
          type="button"
          aria-label="Drag timeline viewport"
          title="Drag to pan the visible range"
          className="absolute inset-y-0 z-10 cursor-grab touch-none border border-foreground/60 bg-foreground/10 active:cursor-grabbing"
          style={{ left: `${left}%`, width: `${width}%` }}
          onPointerDown={(event) => beginDrag("move", event)}
          onKeyDown={(event) =>
            nudge("move", event.key === "ArrowLeft" ? -1 : 1, event)
          }
        />
        <button
          type="button"
          aria-label="Resize visible range from the left"
          title="Drag to resize"
          className="absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize touch-none border-x border-foreground/70 bg-background/70"
          style={{ left: `${left}%` }}
          onPointerDown={(event) => beginDrag("left", event)}
          onKeyDown={(event) =>
            nudge("left", event.key === "ArrowLeft" ? -1 : 1, event)
          }
        >
          <span className="mx-auto block h-4 w-px bg-foreground/70" />
        </button>
        <button
          type="button"
          aria-label="Resize visible range from the right"
          title="Drag to resize"
          className="absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize touch-none border-x border-foreground/70 bg-background/70"
          style={{ left: `${left + width}%` }}
          onPointerDown={(event) => beginDrag("right", event)}
          onKeyDown={(event) =>
            nudge("right", event.key === "ArrowLeft" ? -1 : 1, event)
          }
        >
          <span className="mx-auto block h-4 w-px bg-foreground/70" />
        </button>
      </div>
    </div>
  );
}
