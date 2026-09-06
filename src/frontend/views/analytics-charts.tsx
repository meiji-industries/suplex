import { Area, AreaChart, CartesianGrid, Pie, PieChart, XAxis, YAxis } from "recharts";
import type { TaskAnalytics } from "../../task-analytics-contracts.js";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart.js";
import { taskStatusLabels } from "../components/app/task-status.js";
import { compact, money } from "../lib/analytics.js";
import { TaskControlStatusSchema } from "../../task-control.js";
import { usageIsUnpriced } from "../../task-analytics-metrics.js";

const colors = { delivered: "#10b981", active: "#3b82f6", waiting_human: "#f59e0b", cancelled: "#ef4444", backlog: "#94a3b8" };
const config = { root: { label: "Coordinator", color: "#3b82f6" }, worker: { label: "Worker", color: "#8b5cf6" } };

export function OutcomeChart({ tasks }: { tasks: TaskAnalytics[] }) {
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
}

export function SpendChart({ tasks }: { tasks: TaskAnalytics[] }) {
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
      <ChartTooltip content={<ChartTooltipContent formatter={(value, name) => <span>{name === "root" ? "Coordinator" : "Worker"}: {money(Number(value))}</span>} />} />
      <Area type="monotone" dataKey="root" stackId="cost" stroke="var(--color-root)" fill="var(--color-root)" fillOpacity={0.15} isAnimationActive={false} /><Area type="monotone" dataKey="worker" stackId="cost" stroke="var(--color-worker)" fill="var(--color-worker)" fillOpacity={0.15} isAnimationActive={false} />
    </AreaChart></ChartContainer><div className="flex gap-4 text-xs text-muted-foreground"><span><span className="text-blue-500">●</span> Coordinator</span><span><span className="text-violet-500">●</span> Worker</span>{!data.length ? <span>No measured spend</span> : null}</div>
  </section>;
}
