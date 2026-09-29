import { memo, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Pie, PieChart, XAxis, YAxis } from "recharts";
import type { TaskAnalytics } from "../../contracts/analytics.js";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart.js";
import { taskStatusLabels } from "../tasks/task-status.js";
import { compact, money } from "./lib/analytics.js";
import { activityMetrics, buildActivity, type ActivityMetric } from "./lib/activity.js";
import { TaskControlStatusSchema } from "../../contracts/task-control.js";
import { usageIsUnpriced } from "./lib/usage-metrics.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";

const colors = { delivered: "#10b981", active: "#3b82f6", waiting_human: "#f59e0b", cancelled: "#ef4444", queued: "#0ea5e9", backlog: "#94a3b8" };
const config = { root: { label: "Coordinator", color: "#3b82f6" }, worker: { label: "Delegated", color: "#8b5cf6" } };

export const OutcomeChart = memo(function OutcomeChart({ tasks }: { tasks: TaskAnalytics[] }) {
  const data = TaskControlStatusSchema.options.map(status => ({ name: taskStatusLabels[status], value: tasks.filter(task => task.status === status).length, fill: colors[status] }));
  return <section className="min-w-0 border-b p-4 lg:border-b-0 lg:border-r" aria-label="Delivery outcomes">
    <h2 className="text-sm font-medium">Delivery outcomes</h2>
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1"><ChartContainer config={Object.fromEntries(Object.keys(colors).map(key => [key, { label: key }]))} className="h-48 w-full">
        <PieChart accessibilityLayer><Pie data={tasks.length ? data.filter(row => row.value) : [{ name: "No tasks", value: 1, fill: "#e2e8f0" }]} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="85%" strokeWidth={2} isAnimationActive={false} /><ChartTooltip content={<ChartTooltipContent />} /></PieChart>
      </ChartContainer></div>
      <dl className="grid gap-3 text-xs">{data.map(row => <div key={row.name} className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: row.fill }} /><dt>{row.name}</dt><dd className="ml-auto pl-4 tabular-nums">{row.value} <span className="text-muted-foreground">{tasks.length ? Math.round(row.value / tasks.length * 100) : 0}%</span></dd></div>)}</dl>
    </div><p className="text-xs text-muted-foreground">Share of all {tasks.length} tasks in this cohort. Delivery follows each task's target.</p>
  </section>;
});

export const SpendChart = memo(function SpendChart({ tasks }: { tasks: TaskAnalytics[] }) {
  const days = new Map<string, { date: string; root: number; worker: number }>();
  for (const task of tasks) for (const usage of task.usage) {
    if (usageIsUnpriced(usage)) continue;
    const date = new Date(usage.startedAt).toISOString().slice(0, 10);
    const row = days.get(date) ?? { date, root: 0, worker: 0 };
    row[usage.role] += usage.cost; days.set(date, row);
  }
  const data = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return <section className="min-w-0 p-4" aria-label="Estimated spend over time"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">Estimated spend over time</h2><span className="text-xs text-muted-foreground">USD · UTC days</span></div>
    <ChartContainer config={config} className="h-48 w-full"><AreaChart data={data} accessibilityLayer margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} /><XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={30} tickFormatter={value => String(value).slice(5)} /><YAxis width={45} tickLine={false} axisLine={false} tickFormatter={value => `$${compact(Number(value))}`} />
      <ChartTooltip content={<ChartTooltipContent formatter={(value, name) => <span>{name === "root" ? "Coordinator" : "Delegated"}: {money(Number(value))}</span>} />} />
      <Area type="monotone" dataKey="root" stackId="cost" stroke="var(--color-root)" fill="var(--color-root)" fillOpacity={0.15} isAnimationActive={false} /><Area type="monotone" dataKey="worker" stackId="cost" stroke="var(--color-worker)" fill="var(--color-worker)" fillOpacity={0.15} isAnimationActive={false} />
    </AreaChart></ChartContainer><div className="flex gap-4 text-xs text-muted-foreground"><span><span className="text-blue-500">●</span> Coordinator</span><span><span className="text-violet-500">●</span> Delegated</span>{!data.length ? <span>No measured spend</span> : null}</div>
  </section>;
});

const metricLabels: Record<ActivityMetric, string> = { spend: "Spend", tokens: "Tokens", turns: "Turns" };
const activityMetricOptions = activityMetrics.map(metric => ({ metric, value: `activity-${metric}` }));
const levelColors = ["bg-muted", "bg-primary/20", "bg-primary/40", "bg-primary/65", "bg-primary"];

export const ActivityChart = memo(function ActivityChart({ tasks }: { tasks: TaskAnalytics[] }) {
  const [metric, setMetric] = useState<ActivityMetric>("spend");
  const activity = useMemo(() => buildActivity(tasks, metric, new Date()), [tasks, metric]);
  const formatValue = (value: number) => metric === "spend" ? money(value) : compact(value);
  const streakDays = `${activity.stats.longestStreak} ${activity.stats.longestStreak === 1 ? "day" : "days"}`;
  return <section className="min-w-0 border-b p-4" aria-label="Activity">
    <div className="mb-3 flex items-center gap-3"><h2 className="mr-auto text-sm font-medium">Activity</h2><Select value={`activity-${metric}`} onValueChange={value => { const nextMetric = activityMetricOptions.find(item => item.value === value)?.metric; if (nextMetric) setMetric(nextMetric); }}><SelectTrigger aria-label="Activity metric" size="sm"><SelectValue /></SelectTrigger><SelectContent>{activityMetricOptions.map(option => <SelectItem key={option.metric} value={option.value}>{metricLabels[option.metric]}</SelectItem>)}</SelectContent></Select></div>
    <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4"><div><dt className="text-muted-foreground">Longest streak</dt><dd className="mt-0.5 font-medium tabular-nums">{streakDays}</dd></div><div><dt className="text-muted-foreground">Avg / day</dt><dd className="mt-0.5 font-medium tabular-nums">{formatValue(activity.stats.averagePerDay)}</dd></div><div><dt className="text-muted-foreground">Avg / week</dt><dd className="mt-0.5 font-medium tabular-nums">{formatValue(activity.stats.averagePerWeek)}</dd></div><div><dt className="text-muted-foreground">Total</dt><dd className="mt-0.5 font-medium tabular-nums">{formatValue(activity.stats.total)}</dd></div></dl>
    <div role="group" aria-label={`${metricLabels[metric]} activity by local day`} className="overflow-x-auto pb-1"><div className="min-w-max"><div className="ml-5 flex h-4 gap-1 overflow-visible text-[11px] text-muted-foreground">{activity.weeks.map((_, week) => <span key={week} className="relative w-3 shrink-0">{activity.monthLabels.find(label => label.week === week) ? <span aria-hidden="true" className="absolute whitespace-nowrap">{activity.monthLabels.find(label => label.week === week)?.label}</span> : null}</span>)}</div><div className="flex gap-1"><div aria-hidden="true" className="grid grid-rows-7 gap-1 pt-0.5 text-[11px] leading-3 text-muted-foreground"><span /><span>M</span><span /><span>W</span><span /><span>F</span><span /></div><div className="flex gap-1">{activity.weeks.map((week, index) => <div key={index} className="grid grid-rows-7 gap-1">{week.cells.map(cell => cell.future ? <span key={cell.date} aria-hidden="true" className="invisible size-3" /> : <span key={cell.date} role="img" title={`${cell.date}: ${formatValue(cell.value)}`} aria-label={`${cell.date}: ${formatValue(cell.value)}`} className={`size-3 rounded-sm ${levelColors[cell.level]}`} />)}</div>)}</div></div></div></div>
    <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground"><span>Less</span>{levelColors.map((color, index) => <span key={index} aria-hidden="true" className={`size-3 rounded-sm ${color}`} />)}<span>More</span>{activity.stats.total === 0 ? <span className="ml-3">No activity in this period</span> : null}</div>
    <p className="mt-2 text-xs text-muted-foreground">Local days. Averages use all {activity.stats.days} days and {activity.stats.weeks} weeks in the chart.</p>
  </section>;
});
