import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownToLine, BarChart3, RefreshCw } from "lucide-react";
import { AnalyticsResponseSchema, type AnalyticsResponse } from "../../contracts/analytics.js";
import { percentile, usageMetrics } from "./lib/usage-metrics.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { CostValue } from "../../components/app/cost-value.js";
import { TaskStatus } from "../tasks/task-status.js";
import { taskDeliveryTargetOptions } from "../tasks/task-delivery-target.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import { compact, duration } from "./lib/analytics.js";
import type { ApiProject } from "../../shell/view-shared.js";
import { AnalyticsProjects } from "./analytics-projects.js";

const OutcomeChart = lazy(() => import("./analytics-charts.js").then(module => ({ default: module.OutcomeChart })));
const SpendChart = lazy(() => import("./analytics-charts.js").then(module => ({ default: module.SpendChart })));
const ActivityChart = lazy(() => import("./analytics-charts.js").then(module => ({ default: module.ActivityChart })));

function Filter({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <Select value={value} onValueChange={value => { if (value !== null) onChange(value); }}><SelectTrigger aria-label={label} size="sm"><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}
function Metric({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return <div className="min-w-0 border-b border-r px-4 py-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</dd><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>;
}
function taskUsageIsPartial(task: AnalyticsResponse["tasks"][number]): boolean {
  return task.staleSessions > 0 || task.observedSessions < task.sessions || task.usage.some(entry => entry.completedAt === null);
}

export function AnalyticsView() {
  const companyId = useCompanyContext().currentCompany?.id;
  const [data, setData] = useState<AnalyticsResponse>();
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [project, setProject] = useState("all");
  const [period, setPeriod] = useState("30");
  const [delivery, setDelivery] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("cost");
  useEffect(() => { setData(undefined); setProjects([]); setProject("all"); }, [companyId]);
  useEffect(() => {
    if (!companyId) return;
    let closed = false;
    const load = async () => {
      try {
        const [result, projectResult] = await Promise.all([
          readJsonUnchecked(`/api/companies/${encodeURIComponent(companyId)}/analytics`).then(value => AnalyticsResponseSchema.parse(value)),
          readJsonUnchecked<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
        ]);
        if (!closed) { setData(result); setProjects(projectResult.projects); setError(""); }
      } catch (error) { if (!closed) setError(error instanceof Error ? error.message : "Analytics is not available"); }
    };
    void load(); const timer = setInterval(() => void load(), 30_000);
    return () => { closed = true; clearInterval(timer); };
  }, [companyId, refresh]);
  const tasks = useMemo(() => (data?.tasks ?? []).filter(task => (project === "all" || task.projectId === project)
    && (delivery === "all" || task.deliveryTarget === delivery)
    && (period === "all" || Date.parse(task.createdAt) >= Date.now() - Number(period) * 86_400_000)), [data, project, delivery, period]);
  const activityTasks = useMemo(() => (data?.tasks ?? []).filter(task => (project === "all" || task.projectId === project)
    && (delivery === "all" || task.deliveryTarget === delivery)), [data, project, delivery]);
  const {
    taskRows, totals, delivered, pricedDelivered, deliveredCost, deliveredSubsidized, deliveredPartial,
    measuredDelivery, measured, models, pendingMetrics, pendingSpend, pendingPartial, totalsPartial,
    coverage, sessions, stale, questions, observedWaitMs,
  } = useMemo(() => {
    const taskRows = tasks.map(task => ({ task, metrics: usageMetrics(task.usage) }));
    const usage = tasks.flatMap(task => task.usage);
    const totals = usageMetrics(usage);
    const delivered = taskRows.filter(({ task }) => task.status === "delivered");
    const pricedDelivered = delivered.filter(({ metrics }) => metrics.cost !== null && metrics.unpricedMessages === 0);
    const pending = taskRows.filter(({ task }) => task.status !== "delivered");
    const pendingMetrics = usageMetrics(pending.flatMap(({ task }) => task.usage));
    return {
      taskRows, totals, delivered, pricedDelivered, pendingMetrics,
      deliveredCost: pricedDelivered.length ? pricedDelivered.reduce((sum, { metrics }) => sum + (metrics.cost ?? 0), 0) / pricedDelivered.length : null,
      deliveredSubsidized: pricedDelivered.some(({ metrics }) => metrics.subsidized),
      deliveredPartial: pricedDelivered.some(({ task, metrics }) => taskUsageIsPartial(task) || metrics.incompleteMessages > 0),
      measuredDelivery: delivered.flatMap(({ task }) => task.deliveryMs === null ? [] : [task.deliveryMs]),
      measured: tasks.filter(task => task.usage.length),
      models: [...new Set(usage.map(entry => `${entry.provider}/${entry.model}`))].map(name => ({ name, ...usageMetrics(usage.filter(entry => `${entry.provider}/${entry.model}` === name)) })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
      pendingSpend: pending.reduce((sum, { metrics }) => sum + (metrics.cost ?? 0), 0),
      pendingPartial: pending.some(({ task }) => taskUsageIsPartial(task)) || pendingMetrics.incompleteMessages > 0,
      totalsPartial: tasks.some(taskUsageIsPartial) || totals.incompleteMessages > 0,
      coverage: tasks.reduce((sum, task) => sum + task.observedSessions, 0),
      sessions: tasks.reduce((sum, task) => sum + task.sessions, 0),
      stale: tasks.reduce((sum, task) => sum + task.staleSessions, 0),
      questions: tasks.reduce((sum, task) => sum + task.questions, 0),
      observedWaitMs: tasks.reduce((sum, task) => sum + task.observedWaitMs, 0),
    };
  }, [tasks]);
  const rows = useMemo(() => taskRows.filter(({ task }) => `${task.title} ${task.issueKey ?? ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === "turns" ? b.metrics.turns - a.metrics.turns : sort === "duration" ? (b.metrics.durationMs ?? -1) - (a.metrics.durationMs ?? -1) : sort === "newest" ? b.task.createdAt.localeCompare(a.task.createdAt) : (b.metrics.cost ?? -1) - (a.metrics.cost ?? -1)), [taskRows, query, sort]);
  const attention: Array<[string, ReactNode]> = [
    ["Spend on tasks not delivered", <CostValue value={totals.cost === null ? null : pendingSpend} subsidized={pendingMetrics.subsidized} partial={pendingPartial} />],
    ["Turns with an error", String(totals.failedTurns)], ["Messages without completion", String(totals.incompleteMessages)],
    ["Questions observed", String(questions)],
    ["Observed wait for answers", duration(observedWaitMs)],
    ["Context summaries", String(totals.summaries)],
  ];
  const exportRows = () => {
    const cell = (value: string | number) => `"${String(value).replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
    const csv = ["Task,Status,Estimated USD,Coordinator turns,Delegated turns,Tokens,Agent seconds", ...rows.map(({ task, metrics }) => [task.title, task.status, metrics.cost ?? "", metrics.rootTurns, metrics.workerTurns, metrics.totalTokens, metrics.durationMs === null ? "" : metrics.durationMs / 1000].map(cell).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "suplex-task-analytics.csv"; anchor.click(); URL.revokeObjectURL(url);
  };
  return <ApplicationFrame title="Analytics" headerActions={<BarChart3 className="size-4 text-muted-foreground" />} headerRight={<><Button size="sm" variant="outline" onClick={exportRows} disabled={!rows.length}><ArrowDownToLine />Export CSV</Button><Button size="icon-sm" variant="ghost" aria-label="Refresh analytics" onClick={() => setRefresh(value => value + 1)}><RefreshCw /></Button></>}>
    <main className="min-w-0 flex-1 overflow-auto" data-analytics>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Filter label="Creation period" value={period} onChange={setPeriod} options={[{ value: "7", label: "Created in last 7 days" }, { value: "30", label: "Created in last 30 days" }, { value: "90", label: "Created in last 90 days" }, { value: "all", label: "Created at any time" }]} />
        <Filter label="Project" value={project} onChange={setProject} options={[{ value: "all", label: "All projects" }, ...projects.map(item => ({ value: item.id, label: item.name }))]} />
        <Filter label="Delivery target" value={delivery} onChange={setDelivery} options={[{ value: "all", label: "All delivery targets" }, ...taskDeliveryTargetOptions]} />
      </div>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!data && !error ? <p className="p-4 text-sm text-muted-foreground">Load analytics</p> : null}
      {data ? <>
      <dl className="grid grid-cols-2 xl:grid-cols-4">
        <Metric label="Estimated spend" value={<CostValue value={totals.cost} subsidized={totals.subsidized} partial={totalsPartial} />} detail={`${measured.length} of ${tasks.length} tasks with usage · USD`} />
        <Metric label="Delivered" value={`${tasks.length ? Math.round(delivered.length / tasks.length * 100) : 0}%`} detail={`${delivered.length} delivered / ${tasks.length} total tasks`} />
        <Metric label="Agent turns" value={compact(totals.turns)} detail={`${totals.rootTurns} Coordinator · ${totals.workerTurns} Delegated · ${totals.steps} model steps`} />
        <Metric label="Agent time" value={duration(totals.durationMs)} detail="Summed measured time, not wall-clock time" />
      </dl>
      <Suspense fallback={null}><ActivityChart tasks={activityTasks} /></Suspense>
      <div className="grid min-w-0 border-b lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]"><Suspense fallback={null}><OutcomeChart tasks={tasks} /><SpendChart tasks={tasks} /></Suspense></div>
      <dl className="grid grid-cols-2 xl:grid-cols-4">
        <Metric label="Tokens" value={compact(totals.totalTokens)} detail={`${compact(totals.tokens.input)} input · ${compact(totals.tokens.output)} output · ${compact(totals.tokens.reasoning)} reasoning`} />
        <Metric label="Cache tokens" value={compact(totals.tokens.cache.read)} detail={`${compact(totals.tokens.cache.write)} written · ${totals.tokens.input + totals.tokens.cache.read + totals.tokens.cache.write ? Math.round(totals.tokens.cache.read / (totals.tokens.input + totals.tokens.cache.read + totals.tokens.cache.write) * 100) : 0}% input cache reads`} />
        <Metric label="Median delivery time" value={duration(percentile(measuredDelivery, 0.5))} detail={`P90 ${duration(percentile(measuredDelivery, 0.9))} · ${measuredDelivery.length} measured deliveries`} />
        <Metric label="Cost per delivered task" value={<CostValue value={deliveredCost} subsidized={deliveredSubsidized} partial={deliveredPartial} />} detail={`Mean cost · ${pricedDelivered.length} priced delivered tasks`} />
      </dl>
      <div className="grid min-w-0 border-b lg:grid-cols-2">
        <section className="min-w-0 border-b p-4 lg:border-b-0 lg:border-r"><h2 className="mb-3 text-sm font-medium">Models</h2><Table><TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Steps</TableHead><TableHead>Tokens</TableHead><TableHead>Est. USD</TableHead></TableRow></TableHeader><TableBody>{models.map(model => <TableRow key={model.name}><TableCell>{model.name}</TableCell><TableCell>{model.steps}</TableCell><TableCell>{compact(model.totalTokens)}</TableCell><TableCell><CostValue value={model.cost} subsidized={model.subsidized} partial={model.unpricedMessages > 0 || model.incompleteMessages > 0} /></TableCell></TableRow>)}{!models.length ? <TableRow><TableCell colSpan={4}>No measured model usage</TableCell></TableRow> : null}</TableBody></Table></section>
         <section className="min-w-0 p-4"><h2 className="mb-3 text-sm font-medium">Attention and recovery</h2><dl className="divide-y text-sm">{attention.map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-2"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{value}</dd></div>)}</dl></section>
      </div>
      <AnalyticsProjects tasks={tasks} projects={projects} onSelect={setProject} />
      <section className="min-w-0 p-4" aria-label="Task analytics"><div className="mb-3 flex flex-wrap items-center gap-3"><h2 className="mr-auto text-sm font-medium">Task ledger <span className="text-muted-foreground">{rows.length}</span></h2><div className="w-52"><Input aria-label="Search analytics tasks" placeholder="Search the tasks" value={query} onChange={event => setQuery(event.target.value)} /></div><Filter label="Sort tasks" value={sort} onChange={setSort} options={[{ value: "cost", label: "Highest cost" }, { value: "turns", label: "Most turns" }, { value: "duration", label: "Longest agent time" }, { value: "newest", label: "Newest tasks" }]} /></div>
        <Table><TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Status</TableHead><TableHead>Coordinator / Delegated turns</TableHead><TableHead>Tokens</TableHead><TableHead>Agent time</TableHead><TableHead>Est. USD</TableHead><TableHead>Coverage</TableHead></TableRow></TableHeader><TableBody>{rows.map(({ task, metrics }) => <TableRow key={task.id}><TableCell><a className="block max-w-72 truncate font-medium hover:underline" href={withCompany(`/tasks/${task.id}`, companyId)}>{task.issueKey ? `${task.issueKey} · ` : ""}{task.title}</a><span className="text-xs text-muted-foreground">{projects.find(project => project.id === task.projectId)?.name}{task.archived ? " · Archived" : ""}</span></TableCell><TableCell><TaskStatus status={task.status} pullRequestState={task.pullRequestState} /></TableCell><TableCell>{metrics.rootTurns} / {metrics.workerTurns}</TableCell><TableCell>{!metrics.measuredMessages ? "Not available" : compact(metrics.totalTokens)}</TableCell><TableCell>{duration(!metrics.measuredMessages ? null : metrics.durationMs)}</TableCell><TableCell><CostValue value={metrics.cost} subsidized={metrics.subsidized} partial={taskUsageIsPartial(task) || metrics.incompleteMessages > 0} /></TableCell><TableCell>{task.staleSessions ? "Stale" : task.observedSessions < task.sessions || metrics.incompleteMessages ? "Partial" : task.observedSessions ? "Measured" : "No usage"}</TableCell></TableRow>)}{!rows.length ? <TableRow><TableCell colSpan={7}>No tasks match these filters.</TableCell></TableRow> : null}</TableBody></Table>
      </section>
      <footer className="space-y-1 border-t px-4 py-3 text-xs text-muted-foreground"><p>{coverage} / {sessions} native sessions observed{stale ? ` · ${stale} could not be refreshed` : ""}.</p><p>Active usage refreshes every 30 seconds. Completed history refreshes every 15 minutes.</p><p>One turn groups assistant replies to one prompt. Model steps are counted separately.</p><p>OpenCode cost estimates are not bills. Missing history and unpriced usage are excluded from spend.</p><p>Lifecycle durations use observations from this installation. Old delivery and wait times cannot be reconstructed.</p></footer>
      </> : null}
    </main>
  </ApplicationFrame>;
}
