import { type TimelineTask } from "../../contracts/timeline.js";
import { addDays } from "./timeline-format.js";
import type { ApiProject } from "../../shell/view-shared.js";

export type { TimelineTask } from "../../contracts/timeline.js";
export type AgentRole = "root" | "worker";
export type TimelineRange = { start: number; end: number };

export type WorkInterval = {
  id: string;
  taskId: string;
  issueKey: string | null;
  taskTitle: string;
  projectName: string;
  agentKey: string;
  agentName: string;
  avatarSeed: string;
  role: AgentRole;
  status: string;
  attempt: number;
  start: number;
  end: number;
  durationMs: number;
  track: number;
};

export type WorkLane = {
  key: string;
  name: string;
  avatarSeed: string;
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

export const minimumVisibleMs = 15 * 60_000;

export function trimTimelineRange(
  bounds: TimelineRange,
  intervals: TimelineRange[],
  now: number,
): TimelineRange {
  const end = Math.min(bounds.end, now);
  const start = Math.min(bounds.start, end);
  const active = intervals.filter(
    (interval) => interval.end > start && interval.start < end,
  );
  if (!active.length) return bounds;
  return {
    start: active.reduce(
      (first, interval) => Math.min(first, Math.max(start, interval.start)),
      end,
    ),
    end: active.reduce(
      (last, interval) => Math.max(last, Math.min(end, interval.end)),
      start,
    ),
  };
}

export function clampTimelineRange(
  range: TimelineRange,
  bounds: TimelineRange,
  minimumDurationMs = minimumVisibleMs,
): TimelineRange {
  const available = Math.max(0, bounds.end - bounds.start);
  const minimum = Math.min(minimumDurationMs, available);
  let start = Math.max(
    bounds.start,
    Math.min(bounds.end, Math.min(range.start, range.end)),
  );
  let end = Math.max(
    bounds.start,
    Math.min(bounds.end, Math.max(range.start, range.end)),
  );
  if (end - start < minimum) {
    const center = (start + end) / 2;
    start = center - minimum / 2;
    end = center + minimum / 2;
  }
  if (start < bounds.start) {
    end += bounds.start - start;
    start = bounds.start;
  }
  if (end > bounds.end) {
    start -= end - bounds.end;
    end = bounds.end;
  }
  return {
    start: Math.max(bounds.start, start),
    end: Math.min(bounds.end, end),
  };
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function dateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function presetRange(
  preset: "today" | "7-days" | "30-days",
  now: Date,
): { start: number; end: number } {
  const end = addDays(startOfDay(now), 1);
  const days = preset === "today" ? 1 : preset === "7-days" ? 7 : 30;
  return { start: addDays(end, -days).getTime(), end: end.getTime() };
}

export function customRange(
  start: string,
  end: string,
): { start: number; end: number } {
  const rangeStart = startOfDay(dateFromInput(start));
  return {
    start: rangeStart.getTime(),
    end: addDays(startOfDay(dateFromInput(end)), 1).getTime(),
  };
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

function addTotal(
  totals: Map<string, WorkTotal>,
  key: string,
  label: string,
  secondary: string,
  durationMs: number,
  issueKey: string | null = null,
): void {
  const current = totals.get(key);
  if (current) {
    current.durationMs += durationMs;
    current.invocationCount += 1;
  } else {
    totals.set(key, {
      key,
      label,
      issueKey,
      secondary,
      durationMs,
      invocationCount: 1,
    });
  }
}

export function summarizeAgentTime(
  tasks: TimelineTask[],
  projects: Pick<ApiProject, "id" | "name">[],
  range: { start: number; end: number },
  now: number,
): WorkTimelineSummary {
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const intervals: WorkInterval[] = [];
  const ticketTotals = new Map<string, WorkTotal>();
  const dayTotals = new Map<string, WorkTotal>();
  const projectTotals = new Map<
    string,
    {
      ticketTotals: Map<string, WorkTotal>;
      dayTotals: Map<string, WorkTotal>;
      durationMs: number;
    }
  >();

  for (const task of tasks) {
    for (const invocation of task.activity) {
      const rawStart = Date.parse(invocation.startedAt);
      const rawEnd = invocation.finishedAt
        ? Date.parse(invocation.finishedAt)
        : now;
      const start = Math.max(rawStart, range.start);
      const end = Math.min(rawEnd, range.end, now);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        continue;

      const interval: WorkInterval = {
        id: invocation.id,
        taskId: task.id,
        issueKey: task.issueKey,
        taskTitle: task.title,
        projectName: projectNames.get(task.projectId) ?? "Unknown project",
        agentKey: invocation.agentId,
        agentName: invocation.agentName,
        avatarSeed: invocation.avatarSeed,
        role: invocation.role,
        status: invocation.status,
        attempt: invocation.attempt,
        start,
        end,
        durationMs: end - start,
        track: 0,
      };
      intervals.push(interval);
      addTotal(
        ticketTotals,
        task.id,
        task.title,
        interval.projectName,
        interval.durationMs,
        task.issueKey,
      );
      const projectTotal = projectTotals.get(task.projectId) ?? {
        ticketTotals: new Map(),
        dayTotals: new Map(),
        durationMs: 0,
      };
      addTotal(
        projectTotal.ticketTotals,
        task.id,
        task.title,
        interval.projectName,
        interval.durationMs,
        task.issueKey,
      );
      projectTotal.durationMs += interval.durationMs;
      projectTotals.set(task.projectId, projectTotal);

      for (
        let day = startOfDay(new Date(start));
        day.getTime() < end;
        day = addDays(day, 1)
      ) {
        const nextDay = addDays(day, 1);
        const durationMs =
          Math.min(end, nextDay.getTime()) - Math.max(start, day.getTime());
        if (durationMs > 0) {
          const key = dateInputValue(day);
          const label = new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          }).format(day);
          addTotal(dayTotals, key, label, "Summed agent time", durationMs);
          addTotal(
            projectTotal.dayTotals,
            key,
            label,
            "Summed agent time",
            durationMs,
          );
        }
      }
    }
  }

  intervals.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.id.localeCompare(right.id),
  );
  const laneMap = new Map<string, WorkLane>();
  for (const interval of intervals) {
    const lane = laneMap.get(interval.agentKey) ?? {
      key: interval.agentKey,
      name: interval.agentName,
      avatarSeed: interval.avatarSeed,
      roles: [],
      intervals: [],
      durationMs: 0,
      trackCount: 1,
    };
    if (!lane.roles.includes(interval.role)) lane.roles.push(interval.role);
    lane.intervals.push(interval);
    lane.durationMs += interval.durationMs;
    laneMap.set(interval.agentKey, lane);
  }
  const lanes = [...laneMap.values()];
  for (const lane of lanes) lane.trackCount = assignTracks(lane.intervals);
  lanes.sort(
    (left, right) =>
      left.intervals[0]!.start - right.intervals[0]!.start ||
      left.name.localeCompare(right.name),
  );

  const projectGroups = [...projectTotals.entries()]
    .map(([projectId, totals]) => ({
      projectId,
      projectName: projectNames.get(projectId) ?? "Unknown project",
      ticketTotals: [...totals.ticketTotals.values()].sort(
        (left, right) =>
          right.durationMs - left.durationMs ||
          left.label.localeCompare(right.label),
      ),
      dayTotals: [...totals.dayTotals.values()].sort((left, right) =>
        right.key.localeCompare(left.key),
      ),
      durationMs: totals.durationMs,
    }))
    .sort(
      (left, right) =>
        right.durationMs - left.durationMs ||
        left.projectName.localeCompare(right.projectName),
    );

  return {
    intervals,
    lanes,
    ticketTotals: [...ticketTotals.values()].sort(
      (left, right) =>
        right.durationMs - left.durationMs ||
        left.label.localeCompare(right.label),
    ),
    dayTotals: [...dayTotals.values()].sort((left, right) =>
      right.key.localeCompare(left.key),
    ),
    projectGroups,
    durationMs: intervals.reduce(
      (total, interval) => total + interval.durationMs,
      0,
    ),
  };
}
