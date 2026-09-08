import { ChartNoAxesGantt, Minus, Plus, RotateCcw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { TimelineTotals } from "./timeline-totals.js";
import { WorkChart } from "./timeline-chart.js";
import {
  clampTimelineRange,
  customRange,
  dateFromInput,
  dateInputValue,
  minimumVisibleMs,
  presetRange,
  summarizeAgentTime,
  trimTimelineRange,
  type AgentRole,
  type TimelineRange,
} from "./timeline-model.js";
import { readJson } from "../../lib/api.js";
import {
  TaskTimelineResponseSchema,
  type TimelineTask,
} from "../../../tasks/timeline/contracts.js";
import type { ApiProject } from "../../shell/view-shared.js";
import { addDays, formatDuration, titleCase } from "./timeline-format.js";

type RangePreset = "today" | "7-days" | "30-days" | "custom";

const roleColors: Record<AgentRole, string> = {
  root: "bg-blue-500",
  worker: "bg-amber-500",
};

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
  const [customStart, setCustomStart] = useState(() =>
    dateInputValue(addDays(new Date(), -6)),
  );
  const [customEnd, setCustomEnd] = useState(() => dateInputValue(new Date()));
  const [zoomRange, setZoomRange] = useState<TimelineRange | null>(null);
  const [groupByProject, setGroupByProject] = useState(false);
  const requestToken = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setError("");
    if (!companyId || loading) {
      setLoadedCompanyId("");
      setTasks([]);
      setProjects([]);
      return;
    }
    try {
      const [taskResult, projectResult] = await Promise.all([
        readJson(
          `/api/companies/${encodeURIComponent(companyId)}/timeline`,
        ).then((value) => TaskTimelineResponseSchema.parse(value)),
        readJson<{ projects: ApiProject[] }>(
          `/api/companies/${encodeURIComponent(companyId)}/projects`,
        ),
      ]);
      if (token !== requestToken.current) return;
      setTasks(taskResult.tasks);
      setUnavailableSessions(taskResult.unavailableSessions);
      setProjects(projectResult.projects);
      setLoadedCompanyId(companyId);
      setNow(Date.now());
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (
        reason instanceof Error &&
        reason.message === "Authentication required"
      )
        window.location.assign("/auth");
      else {
        await reloadCompanies();
        setError("Timeline is not available");
      }
    }
  }, [companyId, loading, reloadCompanies]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!companyId) return;
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [companyId, reload]);

  const today = dateInputValue(new Date(now));
  const sourceRange = useMemo(
    () =>
      preset === "custom"
        ? customRange(customStart, customEnd)
        : presetRange(preset, dateFromInput(today)),
    [customEnd, customStart, preset, today],
  );
  const overview = useMemo(
    () => summarizeAgentTime(tasks, projects, sourceRange, now),
    [now, projects, sourceRange, tasks],
  );
  const defaultRange = useMemo(
    () => trimTimelineRange(sourceRange, overview.intervals, now),
    [sourceRange, overview, now],
  );
  const visibleRange = zoomRange
    ? clampTimelineRange(zoomRange, sourceRange)
    : defaultRange;
  useEffect(() => setZoomRange(null), [sourceRange, companyId]);
  const updateVisibleRange = useCallback(
    (next: TimelineRange): void =>
      setZoomRange(clampTimelineRange(next, sourceRange)),
    [sourceRange],
  );
  const scaleVisibleRange = useCallback(
    (factor: number): void => {
      setZoomRange((selected) => {
        const current = selected
          ? clampTimelineRange(selected, sourceRange)
          : defaultRange;
        const center = (current.start + current.end) / 2;
        const duration = (current.end - current.start) * factor;
        return clampTimelineRange(
          { start: center - duration / 2, end: center + duration / 2 },
          sourceRange,
        );
      });
    },
    [sourceRange, defaultRange],
  );
  const summary = useMemo(
    () => summarizeAgentTime(tasks, projects, visibleRange, now),
    [now, projects, tasks, visibleRange],
  );
  const scopeLoaded = Boolean(companyId) && loadedCompanyId === companyId;
  const displayedStart =
    preset === "custom"
      ? customStart
      : dateInputValue(new Date(sourceRange.start));
  const displayedEnd =
    preset === "custom"
      ? customEnd
      : dateInputValue(new Date(sourceRange.end - 1));
  const changeStart = (value: string): void => {
    if (!value) return;
    setCustomStart(value);
    setCustomEnd(value > displayedEnd ? value : displayedEnd);
    setPreset("custom");
  };
  const changeEnd = (value: string): void => {
    if (!value) return;
    setCustomEnd(value);
    setCustomStart(value < displayedStart ? value : displayedStart);
    setPreset("custom");
  };
  const fullRangeVisible =
    visibleRange.start === sourceRange.start &&
    visibleRange.end === sourceRange.end;

  return (
    <ApplicationFrame
      title="Timeline"
      headerActions={
        <ChartNoAxesGantt className="size-3.5 text-muted-foreground" />
      }
      headerRight={
        <span
          className="hidden text-[11px] text-muted-foreground sm:inline"
          title="Concurrent agent invocations are summed"
        >
          Recorded agent time ·{" "}
          <strong className="font-medium text-foreground">
            {formatDuration(summary.durationMs)}
          </strong>
        </span>
      }
    >
      <div className="min-h-[calc(100vh-2.5rem)] bg-background text-foreground">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5 sm:px-4">
          <Tabs
            value={preset}
            onValueChange={(value) => setPreset(value as RangePreset)}
          >
            <TabsList>
              <TabsTrigger value="today">Today</TabsTrigger>
              <TabsTrigger value="7-days">7 days</TabsTrigger>
              <TabsTrigger value="30-days">30 days</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <label className="w-36">
              <span className="sr-only">Timeline start date</span>
              <Input
                aria-label="Timeline start date"
                type="date"
                max={displayedEnd}
                value={displayedStart}
                onChange={(event) => changeStart(event.target.value)}
              />
            </label>
            <span>to</span>
            <label className="w-36">
              <span className="sr-only">Timeline end date</span>
              <Input
                aria-label="Timeline end date"
                type="date"
                min={displayedStart}
                max={dateInputValue(new Date(now))}
                value={displayedEnd}
                onChange={(event) => changeEnd(event.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 px-3 py-1 text-[11px] text-muted-foreground sm:px-4">
          {(Object.keys(roleColors) as AgentRole[]).map((role) => (
            <span key={role} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-sm ${roleColors[role]}`} />
              {titleCase(role)}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-px bg-emerald-500" />
            Now
          </span>
          <span className="ml-auto hidden sm:inline">Drag chart to zoom</span>
          <div
            className="flex items-center gap-1"
            aria-label="Timeline zoom controls"
          >
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={fullRangeVisible}
              onClick={() => scaleVisibleRange(2)}
            >
              <Minus />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={
                visibleRange.end - visibleRange.start <= minimumVisibleMs
              }
              onClick={() => scaleVisibleRange(0.5)}
            >
              <Plus />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Reset zoom"
              title="Reset zoom"
              disabled={fullRangeVisible}
              onClick={() => setZoomRange(sourceRange)}
            >
              <RotateCcw />
            </Button>
          </div>
        </div>
        {error ? (
          <div className="p-3 sm:p-4">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {scopeLoaded && unavailableSessions > 0 ? (
          <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
            Some session history is not available. Totals include available
            history only.
          </p>
        ) : null}
        {!scopeLoaded && !error ? (
          <div
            className="space-y-px p-2"
            aria-label="Loading timeline"
            aria-busy="true"
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : null}
        {scopeLoaded && overview.intervals.length === 0 ? (
          <div className="px-4 py-8 text-xs text-muted-foreground">
            No agent activity in this range.
          </div>
        ) : null}
        {scopeLoaded ? (
          <WorkChart
            summary={summary}
            overview={overview}
            range={visibleRange}
            fullRange={sourceRange}
            companyId={companyId}
            now={now}
            onRangeChange={updateVisibleRange}
          />
        ) : null}
        {scopeLoaded ? (
          <div className="flex h-8 items-center gap-2 border-b border-border/70 px-3 text-[11px] text-muted-foreground sm:px-4">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={groupByProject}
                onCheckedChange={(checked) =>
                  setGroupByProject(checked === true)
                }
              />
              Group by project
            </label>
          </div>
        ) : null}
        {scopeLoaded ? (
          <TimelineTotals
            summary={summary}
            groupByProject={groupByProject}
            companyId={companyId}
          />
        ) : null}
      </div>
    </ApplicationFrame>
  );
}
