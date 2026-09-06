import type { TaskAnalytics } from "../../task-analytics-contracts.js";
import { usageMetrics } from "../../task-analytics-metrics.js";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { compact, duration, money } from "../lib/analytics.js";

export function AnalyticsProjects({ tasks, projects, onSelect }: { tasks: TaskAnalytics[]; projects: Array<{ id: string; name: string }>; onSelect: (id: string) => void }) {
  const rows = [...new Set(tasks.map(task => task.projectId))].map(id => {
    const group = tasks.filter(task => task.projectId === id);
    return { id, name: projects.find(project => project.id === id)?.name ?? id, count: group.length,
      delivered: group.filter(task => task.status === "delivered").length, ...usageMetrics(group.flatMap(task => task.usage)) };
  }).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  return <section className="min-w-0 border-b p-4" aria-label="Project analytics"><h2 className="mb-3 text-sm font-medium">Projects</h2><Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Delivered / Total</TableHead><TableHead>Turns</TableHead><TableHead>Tokens</TableHead><TableHead>Agent time</TableHead><TableHead>Est. USD</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell><Button variant="link" size="sm" onClick={() => onSelect(row.id)}>{row.name}</Button></TableCell><TableCell>{row.delivered} / {row.count}</TableCell><TableCell>{row.turns}</TableCell><TableCell>{compact(row.totalTokens)}</TableCell><TableCell>{duration(!row.measuredMessages ? null : row.durationMs)}</TableCell><TableCell>{money(row.cost)}</TableCell></TableRow>)}{!rows.length ? <TableRow><TableCell colSpan={6}>No projects match these filters.</TableCell></TableRow> : null}</TableBody></Table></section>;
}
