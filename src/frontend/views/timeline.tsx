import { ChartNoAxesGantt, ChevronRight, Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Collapsible } from "../components/ui/collapsible.js";
import { Input } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip.js";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { EntityAvatar } from "../components/app/entity-avatar.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { readJson, withCompany } from "../lib/api.js";
import { TaskTimelineResponseSchema, type TimelineTask } from "../../task-timeline-contracts.js";
import type { ApiProject } from "../lib/view-shared.js";

type RangePreset = "today" | "7-days" | "30-days" | "custom";
type AgentRole = "root" | "worker";
type TimelineRange = { start: number; end: number };

export type { TimelineTask } from "../../task-timeline-contracts.js";

type WorkInterval = {
  id: string;
  taskId: string;
  issueKey: string | null;
  taskTitle: string;
  projectName: string;
  agentKey: string;
  agentName: string;
  avatarSeed?: string;
  role: AgentRole;
  status: string;
  attempt: number;
  start: number;
  end: number;
  durationMs: number;
  track: number;
};

type WorkLane = {
  key: string;
  name: string;
  avatarSeed?: string;
  roles: AgentRole[];
  intervals: WorkInterval[];
  durationMs: number;
  trackCount: number;
};

export type WorkTotal = {
  key: string;
  label: string;
  issueKey: string | null;
  secondary: string;
  invocationCount: number;
  durationMs: number;
};

export type WorkProjectGroup = {
  projectId: string;
  projectName: string;
  ticketTotals: WorkTotal[];
  dayTotals: WorkTotal[];
  durationMs: number;
};

export type WorkTimelineSummary = {
  intervals: WorkInterval[];
  lanes: WorkLane[];
  ticketTotals: WorkTotal[];
  dayTotals: WorkTotal[];
  projectGroups: WorkProjectGroup[];
  durationMs: number;
};

const roleColors: Record<AgentRole, string> = {
  root: "bg-blue-500",
  worker: "bg-amber-500",
};

const minimumVisibleMs = 15 * 60_000;

export function trimTimelineRange(bounds: TimelineRange, intervals: TimelineRange[], now: number): TimelineRange {
  const end = Math.min(bounds.end, now);
  const start = Math.min(bounds.start, end);
  const active = intervals.filter(interval => interval.end > start && interval.start < end);
  if (!active.length) return bounds;
  return {
    start: active.reduce((first, interval) => Math.min(first, Math.max(start, interval.start)), end),
    end: active.reduce((last, interval) => Math.max(last, Math.min(end, interval.end)), start),
  };
}

export function clampTimelineRange(range: TimelineRange, bounds: TimelineRange, minimumDurationMs = minimumVisibleMs): TimelineRange {
  const available = Math.max(0, bounds.end - bounds.start);
  const minimum = Math.min(minimumDurationMs, available);
  let start = Math.max(bounds.start, Math.min(bounds.end, Math.min(range.start, range.end)));
  let end = Math.max(bounds.start, Math.min(bounds.end, Math.max(range.start, range.end)));
  if (end - start < minimum) {
    const center = (start + end) / 2;
    start = center - minimum / 2;
    end = center + minimum / 2;
  }
  if (start < bounds.start) { end += bounds.start - start; start = bounds.start; }
  if (end > bounds.end) { start -= end - bounds.end; end = bounds.end; }
  return { start: Math.max(bounds.start, start), end: Math.min(bounds.end, end) };
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function dateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function presetRange(preset: Exclude<RangePreset, "custom">, now: Date): { start: number; end: number } {
  const end = addDays(startOfDay(now), 1);
  const days = preset === "today" ? 1 : preset === "7-days" ? 7 : 30;
  return { start: addDays(end, -days).getTime(), end: end.getTime() };
}

function customRange(start: string, end: string): { start: number; end: number } {
  const rangeStart = startOfDay(dateFromInput(start));
  return { start: rangeStart.getTime(), end: addDays(startOfDay(dateFromInput(end)), 1).getTime() };
}

function titleCase(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function assignTracks(intervals: WorkInterval[]): number {
  const trackEnds: number[] = [];
  for (const interval of intervals) {
    const openTrack = trackEnds.findIndex((end) => end <= interval.start);
    interval.track = openTrack === -1 ? trackEnds.length : openTrack;
    trackEnds[interval.track] = interval.end;
  }
  return Math.max(1, trackEnds.length);
}

function addTotal(totals: Map<string, WorkTotal>, key: string, label: string, secondary: string, durationMs: number, issueKey: string | null = null): void {
  const current = totals.get(key);
  if (current) {
    current.durationMs += durationMs;
    current.invocationCount += 1;
  } else {
    totals.set(key, { key, label, issueKey, secondary, durationMs, invocationCount: 1 });
  }
}

export function summarizeAgentTime(tasks: TimelineTask[], projects: Pick<ApiProject, "id" | "name">[], range: { start: number; end: number }, now: number): WorkTimelineSummary {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const intervals: WorkInterval[] = [];
  const ticketTotals = new Map<string, WorkTotal>();
  const dayTotals = new Map<string, WorkTotal>();
  const projectTotals = new Map<string, { ticketTotals: Map<string, WorkTotal>; dayTotals: Map<string, WorkTotal>; durationMs: number }>();

  for (const task of tasks) {
    for (const invocation of task.activity) {
      const rawStart = Date.parse(invocation.startedAt);
      const rawEnd = invocation.finishedAt ? Date.parse(invocation.finishedAt) : now;
      const start = Math.max(rawStart, range.start);
      const end = Math.min(rawEnd, range.end, now);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

      const agentKey = invocation.agentId ?? `role:${invocation.role}`;
      const interval: WorkInterval = {
        id: invocation.id,
        taskId: task.id,
        issueKey: task.issueKey,
        taskTitle: task.title,
        projectName: projectNames.get(task.projectId) ?? "Unknown project",
        agentKey,
        agentName: invocation.agentName ?? titleCase(invocation.role),
        ...(invocation.avatarSeed ? { avatarSeed: invocation.avatarSeed } : {}),
        role: invocation.role,
        status: invocation.status,
        attempt: invocation.attempt,
        start,
        end,
        durationMs: end - start,
        track: 0,
      };
      intervals.push(interval);
      addTotal(ticketTotals, task.id, task.title, interval.projectName, interval.durationMs, task.issueKey);
      const projectTotal = projectTotals.get(task.projectId) ?? { ticketTotals: new Map(), dayTotals: new Map(), durationMs: 0 };
      addTotal(projectTotal.ticketTotals, task.id, task.title, interval.projectName, interval.durationMs, task.issueKey);
      projectTotal.durationMs += interval.durationMs;
      projectTotals.set(task.projectId, projectTotal);

      for (let day = startOfDay(new Date(start)); day.getTime() < end; day = addDays(day, 1)) {
        const nextDay = addDays(day, 1);
        const durationMs = Math.min(end, nextDay.getTime()) - Math.max(start, day.getTime());
        if (durationMs > 0) {
          const key = dateInputValue(day);
          const label = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(day);
          addTotal(dayTotals, key, label, "Summed agent time", durationMs);
          addTotal(projectTotal.dayTotals, key, label, "Summed agent time", durationMs);
        }
      }
    }
  }

  intervals.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
  const laneMap = new Map<string, WorkLane>();
  for (const interval of intervals) {
    const lane = laneMap.get(interval.agentKey) ?? { key: interval.agentKey, name: interval.agentName, ...(interval.avatarSeed ? { avatarSeed: interval.avatarSeed } : {}), roles: [], intervals: [], durationMs: 0, trackCount: 1 };
    if (!lane.roles.includes(interval.role)) lane.roles.push(interval.role);
    lane.intervals.push(interval);
    lane.durationMs += interval.durationMs;
    laneMap.set(interval.agentKey, lane);
  }
  const lanes = [...laneMap.values()];
  for (const lane of lanes) lane.trackCount = assignTracks(lane.intervals);
  lanes.sort((left, right) => left.intervals[0]!.start - right.intervals[0]!.start || left.name.localeCompare(right.name));

  const projectGroups = [...projectTotals.entries()].map(([projectId, totals]) => ({
    projectId,
    projectName: projectNames.get(projectId) ?? "Unknown project",
    ticketTotals: [...totals.ticketTotals.values()].sort((left, right) => right.durationMs - left.durationMs || left.label.localeCompare(right.label)),
    dayTotals: [...totals.dayTotals.values()].sort((left, right) => right.key.localeCompare(left.key)),
    durationMs: totals.durationMs,
  })).sort((left, right) => right.durationMs - left.durationMs || left.projectName.localeCompare(right.projectName));

  return {
    intervals,
    lanes,
    ticketTotals: [...ticketTotals.values()].sort((left, right) => right.durationMs - left.durationMs || left.label.localeCompare(right.label)),
    dayTotals: [...dayTotals.values()].sort((left, right) => right.key.localeCompare(left.key)),
    projectGroups,
    durationMs: intervals.reduce((total, interval) => total + interval.durationMs, 0),
  };
}

function formatDuration(durationMs: number): string {
  if (durationMs <= 0) return "0m";
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function axisLabel(timestamp: number, durationMs: number): string {
  const options: Intl.DateTimeFormatOptions = durationMs <= 86_400_000
    ? { hour: "numeric", minute: "2-digit", ...(durationMs < 60_000 ? { second: "2-digit" as const } : {}) }
    : durationMs <= 8 * 86_400_000
      ? { weekday: "short", month: "short", day: "numeric" }
      : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(new Date(timestamp));
}

function SummaryTable({ label, totals, companyId, tickets = false }: { label: string; totals: WorkTotal[]; companyId: string; tickets?: boolean }): ReactElement {
  const totalDurationMs = totals.reduce((total, item) => total + item.durationMs, 0);
  return (
    <section aria-label={label} className="min-w-0 border-t border-border/70 lg:border-r lg:last:border-r-0">
      <div className="flex h-9 items-center justify-between border-b border-border/70 bg-muted/30 px-3 text-xs sm:px-4">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{totals.length} · {formatDuration(totalDurationMs)}</span>
      </div>
      {totals.length === 0 ? <div className="px-3 py-6 text-xs text-muted-foreground sm:px-4">No recorded time in this range.</div> : (
        <table className="w-full text-left text-xs">
          <thead className="sr-only"><tr><th>Item</th><th>Invocations</th><th>Time</th></tr></thead>
          <tbody>
            {totals.map((total) => (
              <tr key={total.key} className="border-b border-border/55 last:border-b-0">
                <td className="min-w-0 px-3 py-2 sm:px-4">
                  {tickets ? <a className="block truncate font-medium hover:underline" href={withCompany(`/tasks/${encodeURIComponent(total.key)}`, companyId)}>{total.issueKey ? <span className="mr-1.5 font-normal text-muted-foreground">{total.issueKey}</span> : null}{total.label}</a> : <span className="block font-medium">{total.label}</span>}
                  <span className="block truncate text-[11px] text-muted-foreground">{total.secondary}</span>
                </td>
                <td className="w-20 px-2 py-2 text-right text-muted-foreground">{total.invocationCount}×</td>
                <td className="w-24 px-3 py-2 text-right font-medium tabular-nums sm:px-4">{formatDuration(total.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function TimelineTotals({ summary, groupByProject, companyId }: { summary: WorkTimelineSummary; groupByProject: boolean; companyId: string }): ReactElement {
  const groups = summary.projectGroups.length > 0 ? summary.projectGroups : [{ projectId: "empty", projectName: "", ticketTotals: [], dayTotals: [], durationMs: 0 }];
  if (!groupByProject) return <div className="grid lg:grid-cols-2"><SummaryTable label="Daily agent-hours" totals={summary.dayTotals} companyId={companyId} /><SummaryTable label="Ticket totals" totals={summary.ticketTotals} companyId={companyId} tickets /></div>;
  return <div>{groups.map((group) => group.projectName ? <Collapsible.Root key={group.projectId} className="group/timeline-project"><Collapsible.Trigger data-project-header={group.projectName} className="flex h-9 w-full items-center gap-2 border-t border-border/70 bg-muted/30 px-3 text-left text-xs font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-4"><ChevronRight className="size-3 text-muted-foreground transition-transform group-data-[open]/timeline-project:rotate-90" /><span>{group.projectName}</span><span className="ml-auto">{group.ticketTotals.length} tickets · {formatDuration(group.durationMs)}</span></Collapsible.Trigger><Collapsible.Panel><div className="grid lg:grid-cols-2"><SummaryTable label="Daily agent-hours" totals={group.dayTotals} companyId={companyId} /><SummaryTable label="Ticket totals" totals={group.ticketTotals} companyId={companyId} tickets /></div></Collapsible.Panel></Collapsible.Root> : <div key={group.projectId} className="grid lg:grid-cols-2"><SummaryTable label="Daily agent-hours" totals={group.dayTotals} companyId={companyId} /><SummaryTable label="Ticket totals" totals={group.ticketTotals} companyId={companyId} tickets /></div>)}</div>;
}

function TimelineMiniMap({ summary, fullRange, visibleRange, onRangeChange }: { summary: WorkTimelineSummary; fullRange: TimelineRange; visibleRange: TimelineRange; onRangeChange: (range: TimelineRange) => void }): ReactElement {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "left" | "move" | "right"; originX: number; range: TimelineRange } | null>(null);
  const spanMs = Math.max(1, fullRange.end - fullRange.start);
  const left = (visibleRange.start - fullRange.start) / spanMs * 100;
  const width = (visibleRange.end - visibleRange.start) / spanMs * 100;
  const laneIndex = new Map(summary.lanes.map((lane, index) => [lane.key, index]));
  const laneHeight = 40 / Math.max(1, summary.lanes.length);

  const beginDrag = (mode: "left" | "move" | "right", event: ReactPointerEvent<HTMLElement>, range = visibleRange): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { mode, originX: event.clientX, range };
    surface.current?.setPointerCapture(event.pointerId);
  };
  const seek = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !surface.current) return;
    const rect = surface.current.getBoundingClientRect();
    const center = fullRange.start + Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))) * spanMs;
    const duration = visibleRange.end - visibleRange.start;
    const next = clampTimelineRange({ start: center - duration / 2, end: center + duration / 2 }, fullRange);
    onRangeChange(next);
    beginDrag("move", event, next);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || !surface.current) return;
    const delta = (event.clientX - active.originX) / Math.max(1, surface.current.getBoundingClientRect().width) * spanMs;
    const minimum = Math.min(minimumVisibleMs, spanMs);
    if (active.mode === "left") onRangeChange({ start: Math.max(fullRange.start, Math.min(active.range.end - minimum, active.range.start + delta)), end: active.range.end });
    else if (active.mode === "right") onRangeChange({ start: active.range.start, end: Math.min(fullRange.end, Math.max(active.range.start + minimum, active.range.end + delta)) });
    else {
      const duration = active.range.end - active.range.start;
      const start = Math.max(fullRange.start, Math.min(fullRange.end - duration, active.range.start + delta));
      onRangeChange({ start, end: start + duration });
    }
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (surface.current?.hasPointerCapture(event.pointerId)) surface.current.releasePointerCapture(event.pointerId);
  };
  const nudge = (mode: "left" | "move" | "right", direction: -1 | 1, event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = direction * Math.max(spanMs / 100, (visibleRange.end - visibleRange.start) / 10);
    const minimum = Math.min(minimumVisibleMs, spanMs);
    if (mode === "left") onRangeChange({ start: Math.max(fullRange.start, Math.min(visibleRange.end - minimum, visibleRange.start + delta)), end: visibleRange.end });
    else if (mode === "right") onRangeChange({ start: visibleRange.start, end: Math.min(fullRange.end, Math.max(visibleRange.start + minimum, visibleRange.end + delta)) });
    else {
      const duration = visibleRange.end - visibleRange.start;
      const start = Math.max(fullRange.start, Math.min(fullRange.end - duration, visibleRange.start + delta));
      onRangeChange({ start, end: start + duration });
    }
  };

  return (
    <div className="border-t border-border/70 px-3 py-2 sm:px-4">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>Overview</span><span>Drag window or handles</span></div>
      <div ref={surface} data-timeline-minimap className="relative h-12 touch-none select-none overflow-hidden border border-border/70 bg-muted/20" onPointerDown={seek} onPointerMove={move} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {summary.intervals.map((interval) => {
          const intervalLeft = (interval.start - fullRange.start) / spanMs * 100;
          const intervalWidth = (interval.end - interval.start) / spanMs * 100;
          const top = 4 + (laneIndex.get(interval.agentKey) ?? 0) * laneHeight;
          return <span key={interval.id} className={`pointer-events-none absolute ${roleColors[interval.role]} ${interval.status === "failed" || interval.status === "cancelled" ? "opacity-40" : "opacity-80"}`} style={{ left: `${intervalLeft}%`, top, width: `max(${intervalWidth}%, 2px)`, height: Math.max(2, laneHeight - 1) }} />;
        })}
        <button type="button" aria-label="Drag timeline viewport" title="Drag to pan the visible range" className="absolute inset-y-0 z-10 cursor-grab touch-none border border-foreground/60 bg-foreground/10 active:cursor-grabbing" style={{ left: `${left}%`, width: `${width}%` }} onPointerDown={(event) => beginDrag("move", event)} onKeyDown={(event) => nudge("move", event.key === "ArrowLeft" ? -1 : 1, event)} />
        <button type="button" aria-label="Resize visible range from the left" title="Drag to resize" className="absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize touch-none border-x border-foreground/70 bg-background/70" style={{ left: `${left}%` }} onPointerDown={(event) => beginDrag("left", event)} onKeyDown={(event) => nudge("left", event.key === "ArrowLeft" ? -1 : 1, event)}><span className="mx-auto block h-4 w-px bg-foreground/70" /></button>
        <button type="button" aria-label="Resize visible range from the right" title="Drag to resize" className="absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize touch-none border-x border-foreground/70 bg-background/70" style={{ left: `${left + width}%` }} onPointerDown={(event) => beginDrag("right", event)} onKeyDown={(event) => nudge("right", event.key === "ArrowLeft" ? -1 : 1, event)}><span className="mx-auto block h-4 w-px bg-foreground/70" /></button>
      </div>
    </div>
  );
}

function WorkChart({ summary, overview, range, fullRange, companyId, now, onRangeChange }: { summary: WorkTimelineSummary; overview: WorkTimelineSummary; range: TimelineRange; fullRange: TimelineRange; companyId: string; now: number; onRangeChange: (range: TimelineRange) => void }): ReactElement {
  const durationMs = range.end - range.start;
  const ticks = Array.from({ length: 6 }, (_, index) => range.start + durationMs * index / 6);
  const nowPosition = (now - range.start) / durationMs * 100;
  const chart = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<{ anchor: number; current: number } | null>(null);
  const [selection, setSelection] = useState<{ anchor: number; current: number } | null>(null);
  const fractionAt = (clientX: number, requirePlot = false): number | null => {
    const rect = chart.current?.getBoundingClientRect();
    if (!rect || (requirePlot && clientX < rect.left + 208)) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left - 208) / Math.max(1, rect.width - 208)));
  };
  const startSelection = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest("a, button")) return;
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
  const endSelection = (event: ReactPointerEvent<HTMLDivElement>, apply: boolean): void => {
    const active = selectionRef.current;
    const releasedAt = fractionAt(event.clientX);
    selectionRef.current = null;
    setSelection(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const rect = chart.current?.getBoundingClientRect();
    if (!apply || !active || releasedAt === null || !rect || Math.abs(releasedAt - active.anchor) * (rect.width - 208) < 8) return;
    const startFraction = Math.min(active.anchor, releasedAt);
    const endFraction = Math.max(active.anchor, releasedAt);
    onRangeChange(clampTimelineRange({ start: range.start + durationMs * startFraction, end: range.start + durationMs * endFraction }, range));
  };
  return (
    <TooltipProvider>
      <div className="min-w-0 border-t border-border/70" data-work-timeline data-range-start={range.start} data-range-end={range.end}>
        <div ref={chart} aria-label="Timeline chart. Drag across the plot to zoom." className="relative w-full min-w-0 cursor-crosshair touch-pan-y select-none" onPointerDown={startSelection} onPointerMove={moveSelection} onPointerUp={(event) => endSelection(event, true)} onPointerCancel={(event) => endSelection(event, false)}>
          <div className="flex h-9 border-b border-border/70 bg-muted/30 text-[11px] text-muted-foreground">
            <div className="flex w-52 shrink-0 items-center border-r border-border/70 px-3 font-medium sm:px-4">Agent</div>
            <div className="grid min-w-0 flex-1 grid-cols-3 items-center sm:grid-cols-6">
              {ticks.map((tick, index) => <time key={tick} dateTime={new Date(tick).toISOString()} className={`min-w-0 overflow-hidden border-r border-border/55 px-2 last:border-r-0 ${index % 2 ? "hidden sm:block" : ""}`}>{axisLabel(tick, durationMs)}</time>)}
            </div>
          </div>
          {summary.lanes.map((lane) => {
            const laneHeight = Math.max(38, 10 + lane.trackCount * 22);
            return (
              <div key={lane.key} className="flex border-b border-border/55 last:border-b-0" style={{ minHeight: laneHeight }}>
                <div className="flex w-52 shrink-0 items-center gap-2 border-r border-border/70 px-3 sm:px-4">
                  {lane.avatarSeed ? <EntityAvatar kind="agent" id={lane.avatarSeed} name={lane.name} /> : <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{lane.name[0]?.toUpperCase()}</span>}
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{lane.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{lane.roles.map(titleCase).join(" / ")} · {lane.intervals.length}× · {formatDuration(lane.durationMs)}</span>
                  </span>
                </div>
                <div className="relative min-w-0 flex-1 overflow-hidden bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[size:16.6667%_100%]">
                  {nowPosition >= 0 && nowPosition <= 100 ? <div aria-label="Now" className="absolute inset-y-0 z-[1] w-px bg-emerald-500" style={{ left: `${nowPosition}%` }} /> : null}
                  {lane.intervals.map((interval) => {
                    const left = (interval.start - range.start) / durationMs * 100;
                    const width = (interval.end - interval.start) / durationMs * 100;
                    const inactive = interval.status === "failed" || interval.status === "cancelled";
                    return (
                      <div key={interval.id} className="absolute h-4" style={{ left: `${left}%`, top: 7 + interval.track * 22, width: `max(${width}%, 5px)` }}>
                        <Tooltip>
                          <TooltipTrigger render={<a aria-label={`${interval.agentName} worked on ${interval.issueKey ? `${interval.issueKey} ` : ""}${interval.taskTitle} for ${formatDuration(interval.durationMs)}`} className={`block h-full w-full rounded-sm border border-background/80 ${roleColors[interval.role]} ${inactive ? "opacity-45" : "opacity-85"} hover:opacity-100 focus-visible:outline-2 focus-visible:outline-ring`} href={withCompany(`/tasks/${encodeURIComponent(interval.taskId)}`, companyId)} />} />
                          <TooltipContent><span className="flex flex-col"><span className="font-medium">{interval.issueKey ? <span className="mr-1.5 font-normal text-muted-foreground">{interval.issueKey}</span> : null}{interval.taskTitle}</span><span>{titleCase(interval.role)} · {interval.status} · attempt {interval.attempt}</span><span>{formatTimestamp(interval.start)} – {formatTimestamp(interval.end)} · {formatDuration(interval.durationMs)}</span></span></TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {summary.lanes.length === 0 ? <div className="flex h-14 border-b border-border/55"><div className="flex w-52 shrink-0 items-center border-r border-border/70 px-3 text-xs text-muted-foreground sm:px-4">No activity</div><div className="min-w-0 flex-1 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[size:16.6667%_100%]" /></div> : null}
          {selection ? <div className="pointer-events-none absolute inset-y-9 left-52 right-0 z-20"><span className="absolute inset-y-0 border-x border-primary bg-primary/15" style={{ left: `${Math.min(selection.anchor, selection.current) * 100}%`, width: `${Math.abs(selection.current - selection.anchor) * 100}%` }} /></div> : null}
        </div>
      </div>
      <TimelineMiniMap summary={overview} fullRange={fullRange} visibleRange={range} onRangeChange={onRangeChange} />
    </TooltipProvider>
  );
}

export function TimelineView(): ReactElement {
  const { currentCompany, loading, reloadCompanies } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [tasks, setTasks] = useState<TimelineTask[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [error, setError] = useState("");
  const [unavailableSessions, setUnavailableSessions] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [preset, setPreset] = useState<RangePreset>("7-days");
  const [customStart, setCustomStart] = useState(() => dateInputValue(addDays(new Date(), -6)));
  const [customEnd, setCustomEnd] = useState(() => dateInputValue(new Date()));
  const [zoomRange, setZoomRange] = useState<TimelineRange | null>(null);
  const [groupByProject, setGroupByProject] = useState(false);
  const requestToken = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setError("");
    if (!companyId || loading) { setLoadedCompanyId(""); setTasks([]); setProjects([]); return; }
    try {
      const [taskResult, projectResult] = await Promise.all([
        readJson(`/api/companies/${encodeURIComponent(companyId)}/timeline`).then(value => TaskTimelineResponseSchema.parse(value)),
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      ]);
      if (token !== requestToken.current) return;
      setTasks(taskResult.tasks); setUnavailableSessions(taskResult.unavailableSessions); setProjects(projectResult.projects); setLoadedCompanyId(companyId); setNow(Date.now());
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else { await reloadCompanies(); setError("Timeline is not available"); }
    }
  }, [companyId, loading, reloadCompanies]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!companyId) return;
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [companyId, reload]);

  const today = dateInputValue(new Date(now));
  const sourceRange = useMemo(() => preset === "custom" ? customRange(customStart, customEnd) : presetRange(preset, dateFromInput(today)), [customEnd, customStart, preset, today]);
  const overview = useMemo(() => summarizeAgentTime(tasks, projects, sourceRange, now), [now, projects, sourceRange, tasks]);
  const defaultRange = useMemo(() => trimTimelineRange(sourceRange, overview.intervals, now), [sourceRange, overview, now]);
  const visibleRange = zoomRange ? clampTimelineRange(zoomRange, sourceRange) : defaultRange;
  useEffect(() => setZoomRange(null), [sourceRange, companyId]);
  const updateVisibleRange = useCallback((next: TimelineRange): void => setZoomRange(clampTimelineRange(next, sourceRange)), [sourceRange]);
  const scaleVisibleRange = useCallback((factor: number): void => {
    setZoomRange((selected) => {
      const current = selected ? clampTimelineRange(selected, sourceRange) : defaultRange;
      const center = (current.start + current.end) / 2;
      const duration = (current.end - current.start) * factor;
      return clampTimelineRange({ start: center - duration / 2, end: center + duration / 2 }, sourceRange);
    });
  }, [sourceRange, defaultRange]);
  const summary = useMemo(() => summarizeAgentTime(tasks, projects, visibleRange, now), [now, projects, tasks, visibleRange]);
  const scopeLoaded = Boolean(companyId) && loadedCompanyId === companyId;
  const displayedStart = preset === "custom" ? customStart : dateInputValue(new Date(sourceRange.start));
  const displayedEnd = preset === "custom" ? customEnd : dateInputValue(new Date(sourceRange.end - 1));
  const changeStart = (value: string): void => { if (!value) return; setCustomStart(value); setCustomEnd(value > displayedEnd ? value : displayedEnd); setPreset("custom"); };
  const changeEnd = (value: string): void => { if (!value) return; setCustomEnd(value); setCustomStart(value < displayedStart ? value : displayedStart); setPreset("custom"); };
  const fullRangeVisible = visibleRange.start === sourceRange.start && visibleRange.end === sourceRange.end;

  return (
    <ApplicationFrame title="Timeline" headerActions={<ChartNoAxesGantt className="size-3.5 text-muted-foreground" />} headerRight={<span className="hidden text-[11px] text-muted-foreground sm:inline" title="Concurrent agent invocations are summed">Recorded agent time · <strong className="font-medium text-foreground">{formatDuration(summary.durationMs)}</strong></span>}>
      <div className="min-h-[calc(100vh-2.5rem)] bg-background text-foreground">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5 sm:px-4">
          <Tabs value={preset} onValueChange={(value) => setPreset(value as RangePreset)}>
            <TabsList>
              <TabsTrigger value="today">Today</TabsTrigger>
              <TabsTrigger value="7-days">7 days</TabsTrigger>
              <TabsTrigger value="30-days">30 days</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <label className="w-36"><span className="sr-only">Timeline start date</span><Input aria-label="Timeline start date" type="date" max={displayedEnd} value={displayedStart} onChange={(event) => changeStart(event.target.value)} /></label>
            <span>to</span>
            <label className="w-36"><span className="sr-only">Timeline end date</span><Input aria-label="Timeline end date" type="date" min={displayedStart} max={dateInputValue(new Date(now))} value={displayedEnd} onChange={(event) => changeEnd(event.target.value)} /></label>
          </div>
        </div>
        <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 px-3 py-1 text-[11px] text-muted-foreground sm:px-4">
          {(Object.keys(roleColors) as AgentRole[]).map((role) => <span key={role} className="flex items-center gap-1.5"><span className={`size-2 rounded-sm ${roleColors[role]}`} />{titleCase(role)}</span>)}
          <span className="flex items-center gap-1.5"><span className="h-3 w-px bg-emerald-500" />Now</span>
          <span className="ml-auto hidden sm:inline">Drag chart to zoom</span>
          <div className="flex items-center gap-1" aria-label="Timeline zoom controls">
            <Button type="button" variant="outline" size="icon-xs" aria-label="Zoom out" title="Zoom out" disabled={fullRangeVisible} onClick={() => scaleVisibleRange(2)}><Minus /></Button>
            <Button type="button" variant="outline" size="icon-xs" aria-label="Zoom in" title="Zoom in" disabled={visibleRange.end - visibleRange.start <= minimumVisibleMs} onClick={() => scaleVisibleRange(0.5)}><Plus /></Button>
            <Button type="button" variant="outline" size="icon-xs" aria-label="Reset zoom" title="Reset zoom" disabled={fullRangeVisible} onClick={() => setZoomRange(sourceRange)}><RotateCcw /></Button>
          </div>
        </div>
        {error ? <div className="p-3 sm:p-4"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        {scopeLoaded && unavailableSessions > 0 ? <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Some session history is not available. Totals include available history only.</p> : null}
        {!scopeLoaded && !error ? <div className="space-y-px p-2" aria-label="Loading timeline" aria-busy="true"><Skeleton className="h-9 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : null}
        {scopeLoaded && overview.intervals.length === 0 ? <div className="px-4 py-8 text-xs text-muted-foreground">No agent activity in this range.</div> : null}
        {scopeLoaded ? <WorkChart summary={summary} overview={overview} range={visibleRange} fullRange={sourceRange} companyId={companyId} now={now} onRangeChange={updateVisibleRange} /> : null}
        {scopeLoaded ? <div className="flex h-8 items-center gap-2 border-b border-border/70 px-3 text-[11px] text-muted-foreground sm:px-4"><label className="flex items-center gap-2"><Checkbox checked={groupByProject} onCheckedChange={(checked) => setGroupByProject(checked === true)} />Group by project</label></div> : null}
        {scopeLoaded ? <TimelineTotals summary={summary} groupByProject={groupByProject} companyId={companyId} /> : null}
      </div>
    </ApplicationFrame>
  );
}
